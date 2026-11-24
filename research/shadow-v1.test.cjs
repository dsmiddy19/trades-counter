"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname,"shadow-v1.js"),"utf8");
const storageKey = "tc.shadow.research.v1";

function setup(savedValue, fetchImpl) {
  const callbacks = new Map();
  const nodes = new Map();
  const memory = new Map();
  if (savedValue) memory.set(storageKey, savedValue);
  const saved = () => JSON.parse(memory.get(storageKey) || '{"version":1,"events":[]}');
  function element(id="element") {
    return {
      id, textContent:"", value:"", className:"", style:{}, children:[],
      classList:{add(){}},
      addEventListener(type, cb){callbacks.set(id+":"+type,cb);},
      append(...args){this.children.push(...args);},
      appendChild(n){this.children.push(n);return n;},
      replaceChildren(...args){this.children=[...args];},
      remove(){}, click(){}, focus(){}, select(){}
    };
  }
  const document={
    getElementById(id){if (!nodes.has(id)) nodes.set(id,element(id));return nodes.get(id);},
    createElement(tag){return element(tag);},
    body:element("body")
  };
  const window={confirm(){return true;}};
  const localStorage={
    getItem(k){return memory.get(k)??null;},
    setItem(k,v){memory.set(k,String(v));}
  };
  const context = {document,window,localStorage,console,fetch:fetchImpl,
    Blob:class { constructor(x,o){this.parts=x;this.options=o;} },
    URL:{createObjectURL(){return "blob:stub";},revokeObjectURL(){}},
    setTimeout(fn){fn();},Date,Math,Number,String,Array,Object};
  vm.runInNewContext(source, context, {filename:"shadow-v1.js"});
  return {observe:window.TradesCounterShadow.observe,callbacks,nodes,saved,memory};
}

function sample(t, opts={}) {
  const buys = opts.tradeBuys ?? 24;
  const trades=opts.trades??Array.from({length:40},(_,i)=>({
    id:"t"+i,ts:t-500,qty:90,price:2000,buy:i<buys
  }));
  return {
    now:t,product:opts.product??"ETH-USD",windowMinutes:opts.windowMinutes??15,
    threshold:opts.threshold??1.65,
    stats:{buyVol:opts.buyVol??2000,sellVol:opts.sellVol??1000,entries:40},
    ratio:opts.ratio??1.5,trades,
    price:opts.price??2000,vwap:opts.vwap??1998,
    complete:opts.complete??true,dataFresh:opts.dataFresh??true,
    context:{techBuy:1,techSell:2,swing:"bearish",macro:"CLEAR"}
  };
}

test("no backfill/startup event, but fresh ratio crossings of both variants are recorded", () => {
  const f=setup();
  const t=Date.UTC(2026,10,23,14,0,0);
  f.observe(sample(t,{ratio:2,tradeBuys:28}));
  assert.equal(f.saved().events.length,0,"initial above-threshold state is not a new crossing");
  f.observe(sample(t+1000,{ratio:1.2,tradeBuys:20}));
  f.observe(sample(t+2000,{ratio:1.8,tradeBuys:28,price:2005,vwap:1999}));
  assert.equal(f.saved().events.length,2);
  assert.deepEqual(f.saved().events.map(x=>x.mode).sort(),["all","large"]);
  assert.ok(f.saved().events.every(x=>x.context.techBuy===1));
  f.observe(sample(t+3000,{ratio:1.9,tradeBuys:29}));
  assert.equal(f.saved().events.length,2,"no duplicate events while threshold remains active");
});

test("small executions are filtered by USD value, not number of orders", () => {
  const f=setup();
  const t=Date.UTC(2026,10,23,14);
  const trades=[];
  for(let i=0;i<30;i++) trades.push({ts:t-500,qty:70,price:2000,buy:true});
  for(let i=0;i<10;i++) trades.push({ts:t-500,qty:70,price:2000,buy:false});
  for(let i=0;i<100;i++) trades.push({ts:t-500,qty:0.1,price:2000,buy:false});
  f.observe(sample(t,{ratio:1.2,tradeBuys:20,trades}));
  assert.equal(f.nodes.get("shadowFilteredRatio").textContent,"+3.00");
  assert.match(f.nodes.get("shadowFilteredMeta").textContent,/40\/140 eligible executions/);
});

test("forward 5m, 15m and 30m directional price and VWAP outcomes are observed", () => {
  const f=setup(), t=Date.UTC(2026,10,23,14);
  f.observe(sample(t,{ratio:1.1,tradeBuys:20}));
  f.observe(sample(t+1000,{ratio:1.9,tradeBuys:28,price:2000,vwap:1998}));
  for(let i=1;i<=1802;i++){
    f.observe(sample(t+1000+i*1000,{ratio:1.9,tradeBuys:28,price:2000+i*0.04,vwap:1998+i*0.013}));
  }
  const events=f.saved().events;
  assert.equal(events.length,2);
  for(const e of events){
    for(const key of ["5","15","30"]){
      assert.equal(e.checkpoints[key].status,"observed");
      assert.ok(e.checkpoints[key].pricePct>0);
      assert.ok(e.checkpoints[key].vwapPct>0);
      assert.ok(e.checkpoints[key].distanceChangePct>0);
    }
  }
  assert.match(f.nodes.get("shadowSummary").textContent,/2\/1|1\/1/);
});

test("a 30-second pause never marks future 5/15/30m checkpoints as missed", () => {
  const f=setup(), t=Date.now()-40000;
  f.observe(sample(t,{ratio:1.1,tradeBuys:20}));
  f.observe(sample(t+1000,{ratio:1.9,tradeBuys:28}));
  f.observe(sample(t+38000,{ratio:1.9,tradeBuys:28}));
  assert.equal(f.saved().events.length,2);
  for(const e of f.saved().events) {
    assert.equal(e.checkpoints["5"],undefined);
    assert.equal(e.checkpoints["15"],undefined);
    assert.equal(e.checkpoints["30"],undefined);
  }
});

test("browser reload preserves pending events and recorded samples, then measures the due checkpoint", () => {
  const f=setup(),t=Date.now()-60000;
  f.observe(sample(t,{ratio:1.2,tradeBuys:20}));
  f.observe(sample(t+1000,{ratio:1.9,tradeBuys:28,price:2000,vwap:1998}));
  f.observe(sample(t+60000,{ratio:1.9,tradeBuys:28,price:2002,vwap:1999}));
  const before=f.saved();
  assert.equal(before.events.length,2);
  assert.ok(before.samples.length>0);
  const reloaded=setup(f.memory.get(storageKey));
  // Mock a resumed clock just after the 5-minute checkpoint.
  reloaded.observe(sample(t+1000+5*60000+9000,{ratio:1.9,tradeBuys:28,price:2010,vwap:2004}));
  const restored=reloaded.saved();
  for (const e of restored.events) {
    assert.equal(e.checkpoints["5"].status,"observed");
    assert.ok(e.checkpoints["5"].pricePct>0);
    assert.ok(e.checkpoints["5"].vwapPct>0);
    assert.equal(e.checkpoints["15"],undefined);
    assert.equal(e.checkpoints["30"],undefined);
  }
});

test("late return marks only elapsed checkpoints missed, not future ones", () => {
  const f=setup(),t=Date.now()-1000;
  f.observe(sample(t,{ratio:1.2,tradeBuys:20}));
  f.observe(sample(t+1000,{ratio:1.9,tradeBuys:28}));
  f.observe(sample(t+9*60000,{ratio:1.9,tradeBuys:28,price:2020,vwap:2002}));
  for(const e of f.saved().events) {
    assert.equal(e.checkpoints["5"].status,"not observed");
    assert.equal(e.checkpoints["15"],undefined);
    assert.equal(e.checkpoints["30"],undefined);
  }
});

test("legacy v1 not-observed outcomes recover approximate PRICE ONLY from Coinbase 1m candles", async () => {
  const now=Date.now();
  const entryTime=now-12*60000;
  const due=entryTime+5*60000;
  const minute=Math.floor(due/60000)*60000;
  const event={
    id:entryTime+"-all-buy",runId:"old-browser",time:entryTime,
    product:"ETH-USD",windowMinutes:15,minUsd:1000,mode:"all",direction:"buy",
    threshold:1.65,ratio:1.9,entryPrice:2000,entryVwap:1995,
    selectedVolume:1500,eligibleExecutions:100,context:{},
    checkpoints:{
      "5":{status:"not observed"},
      "15":{status:"not observed"},
      "30":{status:"not observed"}
    }
  };
  const fetched=[];
  const fakeFetch=async url=>{
    fetched.push(String(url));
    return {ok:true,json:async()=>[[minute/1000,1990,2020,2000,2010,1234]]};
  };
  const f=setup(JSON.stringify({version:1,filterUsd:1000,events:[event]}),fakeFetch);
  f.observe(sample(now,{ratio:1.2,tradeBuys:20}));
  // Recovery is asynchronous, so let its microtasks settle.
  await new Promise(resolve=>setImmediate(resolve));
  const migrated=f.saved().events[0];
  assert.equal(migrated.checkpoints["5"].status,"price_estimate");
  assert.equal(migrated.checkpoints["5"].source,"coinbase_1m_candle_close");
  assert.equal(migrated.checkpoints["5"].vwapPct,null);
  assert.ok(Math.abs(migrated.checkpoints["5"].pricePct - 0.5) < 0.000001);
  assert.equal(migrated.checkpoints["15"],undefined,"future event must be pending after v1 migration");
  assert.equal(migrated.checkpoints["30"],undefined);
  assert.ok(fetched.length>=1);
  assert.match(f.nodes.get("shadowSummary").textContent,/1 pending/); // 15m still in the future
  assert.doesNotMatch(f.nodes.get("shadowSummary").textContent,/price \+ VWAP follow-through/);
});

test("a recovered 15m candle price is excluded from full price+VWAP statistics", async () => {
  const now=Date.now(),time=now-20*60000;
  const due=time+15*60000;
  const candleTs=Math.floor(due/60000)*60000;
  const event={
    id:time+"-large-sell",runId:"legacy",time,product:"ETH-USD",
    windowMinutes:15,minUsd:1000,mode:"large",direction:"sell",threshold:1.65,
    ratio:-1.7,entryPrice:2000,entryVwap:2003,selectedVolume:1300,
    eligibleExecutions:100,context:{},
    checkpoints:{"15":{status:"not observed"}}
  };
  const fetchMock=async ()=>({ok:true,json:async()=>[[candleTs/1000,1970,2010,2000,1980,123]]});
  const f=setup(JSON.stringify({version:1,filterUsd:1000,events:[event]}),fetchMock);
  f.observe(sample(now,{ratio:1.2,tradeBuys:20}));
  await new Promise(resolve=>setImmediate(resolve));
  const recovered=f.saved().events[0].checkpoints["15"];
  assert.equal(recovered.status,"price_estimate");
  assert.ok(recovered.pricePct>0,"SELL benefits from a falling estimated price");
  assert.equal(recovered.vwapPct,null);
  assert.match(f.nodes.get("shadowSummary").textContent,/Filtered: 0 full 15m observations · 1 price-only estimate/);
  assert.doesNotMatch(f.nodes.get("shadowSummary").textContent,/price \+ VWAP follow-through/);
});

test("incomplete or stale feed never triggers new observations", () => {
  const f=setup(),t=Date.UTC(2026,10,23,14);
  f.observe(sample(t,{ratio:1.2,tradeBuys:20,complete:false}));
  f.observe(sample(t+1000,{ratio:1.9,tradeBuys:28,complete:false}));
  f.observe(sample(t+2000,{ratio:1.2,tradeBuys:20,dataFresh:false}));
  f.observe(sample(t+3000,{ratio:1.9,tradeBuys:28,dataFresh:false}));
  assert.equal(f.saved().events.length,0);
  f.observe(sample(t+4000,{ratio:1.9,tradeBuys:28}));
  assert.equal(f.saved().events.length,0,"first good snapshot must only initialize arming");
});

test("changing filter size does not relabel prior research events or fabricate a new crossing", () => {
  const f=setup(),t=Date.UTC(2026,10,23,14);
  f.observe(sample(t,{ratio:1.2,tradeBuys:20}));
  f.observe(sample(t+1000,{ratio:1.9,tradeBuys:28}));
  assert.equal(f.saved().events.length,2);
  f.nodes.get("shadowMinUsd").value="5000";
  f.callbacks.get("shadowMinUsd:change")();
  f.observe(sample(t+2500,{ratio:1.9,tradeBuys:28}));
  assert.equal(f.saved().filterUsd,5000);
  assert.equal(f.saved().events.length,2);
  assert.equal(f.saved().events[0].minUsd,1000);
});
