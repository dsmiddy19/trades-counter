const {test,expect}=require("@playwright/test");
const BASE="http://127.0.0.1:8765";
const T=Date.UTC(2026,10,24,16,0,0);
function trade(id,offset,size,price,side){return {trade_id:id,time:new Date(T+offset).toISOString(),size:String(size),price:String(price),side}}
function tape(product){
 const p=product==="BTC-USD"?100000:2000;
 return [trade(104,-1000,600,p+10,"sell"),trade(103,-10000,600,p,"sell"),
 trade(102,-60000,600,p-10,"buy"),trade(101,-901000,100,p-100,"buy")];
}
async function fixture(page,{missing=false,delay=false}={}){
 const errors=[],sockets=[],requests=[];
 let available=!missing,offline=false;
 page.on("pageerror",e=>errors.push(String(e)));
 await page.clock.install({time:new Date(T)});
 await page.addInitScript(()=>{localStorage.setItem("tc.window","15");localStorage.setItem("tc.product","ETH-USD");localStorage.setItem("tc.threshold.v2","1.65");});
 await page.routeWebSocket("wss://ws-feed.exchange.coinbase.com",ws=>{
   const socket={ws,product:null};sockets.push(socket);
   ws.onMessage(message=>{
     const msg=JSON.parse(message);socket.product=msg.product_ids[0];
     ws.send(JSON.stringify({type:"subscriptions"}));
     ws.send(JSON.stringify({type:"heartbeat",product_id:socket.product,last_trade_id:104,time:new Date(T).toISOString()}));
   });
 });
 await page.route("**/*",async route=>{
   const url=new URL(route.request().url());
   if(url.origin===BASE && !/calendar\.json|market-context\.json/.test(url.pathname)) return route.continue();
   if(url.pathname.includes("calendar.json")||url.hostname.includes("faireconomy")) {
      return route.fulfill({json:[{title:"Low impact fixture",country:"USD",impact:"Low",date:new Date(T+86400000).toISOString()}]});
   }
   if(url.pathname.includes("market-context.json")) return route.fulfill({json:{}});
   if(url.pathname.endsWith("/trades")){
      const product=url.pathname.split("/")[2];requests.push(product);
      if(delay&&product==="ETH-USD"&&requests.filter(p=>p==="ETH-USD").length===1) await new Promise(r=>setTimeout(r,1500));
      if(offline)return route.fulfill({status:503,body:"unavailable"});
      const rows=tape(product).filter(r=>available||r.trade_id!==103);
      return route.fulfill({json:url.searchParams.has("after")?[]:rows});
   }
   if(url.pathname.endsWith("/candles")){
      const gran=Number(url.searchParams.get("granularity"))||900;
      const last=Math.floor(T/1000/gran)*gran;
      const rows=Array.from({length:120},(_,i)=>{const c=1000+(i+1)*(i+1)*.01;return [last-(119-i)*gran,c-2,c+.1,c-1,c,1000]});
      return route.fulfill({json:rows.reverse()});
   }
   return route.fulfill({status:503,body:"fixture unavailable"});
 });
 await page.goto(BASE);
 return {errors,sockets,requests,heal(){available=true},offline(){offline=true}};
}
async function tick(page,ms=1500){await page.clock.runFor(ms)}
test("real browser: maker side, boundary exclusion, deduplication, ratio, VWAP, and signal",async({page})=>{
 const f=await fixture(page);
 await tick(page,2500);
 await expect(page.locator("#windowBadge")).toHaveText("Window verified");
 await expect(page.locator("#ratio")).toHaveText("+2.00");
 await expect(page.locator("#tradeCount")).toHaveText("3");
 await expect(page.locator("#vwap")).toHaveText("2,000.00");
 await expect(page.locator("#decisionAction")).toHaveText("BUY");
 const sock=f.sockets.at(-1);
 sock.ws.send(JSON.stringify({...tape("ETH-USD")[0],type:"match",product_id:"ETH-USD"}));
 await tick(page);
 await expect(page.locator("#tradeCount")).toHaveText("3");
 await expect(page.locator("#ratio")).toHaveText("+2.00");
 expect(f.errors).toEqual([]);
});
test("missing execution blocks signal; REST repair restores verified window",async({page})=>{
 const f=await fixture(page,{missing:true});
 await tick(page,2500);
 await expect(page.locator("#decisionAction")).toHaveText("NO-GO");
 await expect(page.locator("#flowGate")).toHaveText("DATA WAIT");
 f.heal();
 await tick(page,6000);
 await expect(page.locator("#windowBadge")).toHaveText("Window verified");
 await expect(page.locator("#ratio")).toHaveText("+2.00");
 await expect(page.locator("#decisionAction")).toHaveText("BUY");
 expect(f.errors).toEqual([]);
});
test("silent disconnection and REST outage cannot leave a BUY signal",async({page})=>{
 const f=await fixture(page);
 await tick(page,2500);
 await expect(page.locator("#decisionAction")).toHaveText("BUY");
 f.offline();
 await tick(page,33000);
 await expect(page.locator("#decisionAction")).toHaveText("NO-GO");
 await expect(page.locator("#windowBadge")).toHaveText("Stale feed");
 expect(f.errors).toEqual([]);
});
test("market switch while old backfill is pending cannot contaminate new data",async({page})=>{
 const f=await fixture(page,{delay:true});
 await page.locator("#product").selectOption("BTC-USD");
 await tick(page,2500);
 await expect(page.locator("#topMarket")).toHaveText("BTC-USD");
 await expect(page.locator("#vwap")).toHaveText("100,000.00");
 await expect(page.locator("#ratio")).toHaveText("+2.00");
 await expect(page.locator("#tradeCount")).toHaveText("3");
 await expect(page.locator("#windowBadge")).toHaveText("Window verified");
 expect(f.errors).toEqual([]);
});
test("mobile layout and settings survive reload",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 const f=await fixture(page);
 await tick(page,2500);
 await expect(page.locator("#ratio")).toHaveText("+2.00");
 await expect(page.locator("#shadowResearch")).toBeVisible();
 await expect(page.locator("#window")).toHaveValue("15");
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
 expect(f.errors).toEqual([]);
});
