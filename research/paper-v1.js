/* Passive paper-trade study. No order execution, no signal feedback.
 * Uses observed Coinbase spot executions in trade-ID order; never guesses a
 * first-hit outcome across a missing sequence. Returns are unleveraged.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports) module.exports=api;
  else root.TradesCounterPaper=api.mount(root.document,root.localStorage);
})(typeof window!=="undefined"?window:globalThis,function(){
  "use strict";
  const KEY="tc.paper.v1",MAX=120,HORIZON=30*60000;
  const DEFAULT={tp:0.5,sl:1.5,fee:0.06,slip:0.02};
  const positive=n=>Number.isFinite(n)&&n>0;
  const direction=t=>t.side==="BUY"?1:-1;
  function validSettings(x){
    return x&&positive(x.tp)&&x.tp<=20&&positive(x.sl)&&x.sl<=20&&
      Number.isFinite(x.fee)&&x.fee>=0&&x.fee<=2&&Number.isFinite(x.slip)&&x.slip>=0&&x.slip<=2;
  }
  function createState(saved){
    const s={settings:{...DEFAULT},records:[],armed:false,scope:"",lastAction:null,skipped:0};
    if(saved&&saved.version===1){
      if(validSettings(saved.settings))s.settings={...saved.settings};
      if(Array.isArray(saved.records))s.records=saved.records.filter(t=>
        t&&typeof t.id==="string"&&typeof t.product==="string"&&
        ["BUY","SELL"].includes(t.side)&&positive(t.entry)&&Number.isSafeInteger(t.cursor)&&
        Number.isFinite(t.startedAt)&&validSettings(t.settings)&&
        ["open","tp","sl","timeout","unknown"].includes(t.status)).slice(0,MAX);
      s.skipped=Number.isFinite(saved.skipped)?saved.skipped:0;
    }
    return s;
  }
  function serialize(s){return {version:1,settings:s.settings,records:s.records,skipped:s.skipped};}
  function orderedTrades(trades){
    return trades.filter(t=>Number.isSafeInteger(t.tradeId)&&positive(t.price)&&
      Number.isFinite(t.ts)).slice().sort((a,b)=>a.tradeId-b.tradeId);
  }
  function settle(t,status,price,ts){
    t.status=status;t.exit=price;t.finishedAt=ts;
    if(status!=="unknown"){
      t.gross=direction(t)*(price/t.entry-1)*100;
      // Entry/exit costs each as % of their own notional, normalized by entry.
      t.cost=(t.settings.fee+t.settings.slip)*(1+price/t.entry);
      t.net=t.gross-t.cost;
    }
  }
  // Preserve the last contiguous ID across reload. On gaps wait for REST
  // recovery. Never inspect a later price before missing earlier executions.
  function advance(t,rows,now){
    let changed=false;
    if(t.status!=="open")return changed;
    const deadline=t.startedAt+HORIZON;
    for(const row of rows){
      if(row.tradeId<=t.cursor)continue;
      if(row.tradeId!==t.cursor+1)break;
      if(row.ts<t.startedAt){t.cursor=row.tradeId;changed=true;continue;}
      if(row.ts>=deadline){
        // Deadline price is last known execution at or before deadline;
        // continuity through the first later execution establishes coverage.
        settle(t,"timeout",t.lastPrice,deadline);return true;
      }
      t.cursor=row.tradeId;t.lastPrice=row.price;t.lastAt=row.ts;changed=true;
      const move=direction(t)*(row.price/t.entry-1)*100;
      t.mfe=Math.max(t.mfe,move);t.mae=Math.min(t.mae,move);
      if(move>=t.settings.tp-1e-9){settle(t,"tp",row.price,row.ts);return true;}
      if(move<=-t.settings.sl+1e-9){settle(t,"sl",row.price,row.ts);return true;}
    }
    // A 2-minute grace period permits REST catchup; no fabricated exit.
    if(now>deadline+120000){settle(t,"unknown",null,now);return true;}
    return changed;
  }
  function observe(s,p){
    if(!p||!Number.isFinite(p.now)||!Array.isArray(p.trades))return false;
    const scope=p.product+"|"+p.windowMinutes+"|"+p.threshold;
    if(scope!==s.scope){s.scope=scope;s.armed=false;s.lastAction=null;}
    const rows=orderedTrades(p.trades);
    let changed=false;
    for(const t of s.records){
      if(t.status!=="open")continue;
      if(t.product===p.product)changed=advance(t,rows,p.now)||changed;
      else if(p.now>t.startedAt+HORIZON+120000){settle(t,"unknown",null,p.now);changed=true;}
    }
    if(!p.verified){s.armed=false;s.lastAction=null;return changed;}
    if(!s.armed){s.armed=true;s.lastAction=p.action;return changed;}
    const fresh=(p.action==="BUY"||p.action==="SELL")&&p.action!==s.lastAction;
    s.lastAction=p.action;
    if(!fresh||p.windowMinutes!==15||!rows.length||!positive(p.price)||!positive(p.vwap))return changed;
    // One simulated position at a time, including across market switches.
    if(s.records.some(t=>t.status==="open")){s.skipped++;return true;}
    const last=rows[rows.length-1];
    if(last.ts>p.now||p.now-last.ts>30000||Math.abs(last.price-p.price)>1e-8)return changed;
    const t={id:p.product+"-"+p.now+"-"+last.tradeId,product:p.product,side:p.action,
      startedAt:p.now,entry:last.price,entryVwap:p.vwap,entryDistance:(last.price/p.vwap-1)*100,
      ratio:p.ratio,threshold:p.threshold,windowMinutes:p.windowMinutes,techVotes:p.techVotes,
      settings:{...s.settings},cursor:last.tradeId,lastPrice:last.price,lastAt:p.now,
      mfe:0,mae:0,status:"open"};
    s.records.unshift(t);s.records=s.records.slice(0,MAX);return true;
  }
  function summary(s){
    // Avoid mixing different risk/cost settings or markets into a strategy statistic.
    return s.records.reduce((a,t)=>{
      a[t.status]=(a[t.status]||0)+1;return a;
    },{open:0,tp:0,sl:0,timeout:0,unknown:0});
  }
  function mount(document,storage){
    if(!document.getElementById("paperStudy"))return null;
    const $=id=>document.getElementById(id);
    let saved=null;try{saved=JSON.parse(storage.getItem(KEY)||"null")}catch{}
    const s=createState(saved);
    const fields=["tp","sl","fee","slip"];
    let lastDraw="",lastSave=0,storageError=false;
    const pct=n=>Number.isFinite(n)?(n>0?"+":"")+n.toFixed(3)+"%":"—";
    const money=n=>positive(n)?n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:4}):"—";
    const time=n=>new Date(n).toLocaleString("en-US",{timeZone:"America/New_York",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
    const cell=(tr,text)=>{const td=document.createElement("td");td.textContent=text;tr.appendChild(td);return td;};
    function save(){
      try{storage.setItem(KEY,JSON.stringify(serialize(s)));lastSave=Date.now();storageError=false}
      catch{storageError=true}
    }
    function draw(){
      const counts=summary(s);
      $("paperSummary").textContent=s.records.length+" paper entries · "+counts.tp+" TP first · "+counts.sl+" SL first · "+counts.timeout+" timed out · "+counts.unknown+" unresolved · "+counts.open+" open"+(s.skipped?" · "+s.skipped+" signals skipped while open":"")+(storageError?" · WARNING: local storage failed":"");
      const signature=JSON.stringify(s.records);
      if(signature===lastDraw)return;
      lastDraw=signature;
      const body=$("paperRows");body.replaceChildren();
      if(!s.records.length){const tr=document.createElement("tr");const td=cell(tr,"Waiting for a new verified 15m BUY or SELL transition. No historical entries are invented.");td.colSpan=8;body.appendChild(tr);return;}
      for(const t of s.records.slice(0,20)){
        const tr=document.createElement("tr");
        cell(tr,time(t.startedAt)+" ET · "+t.product);
        cell(tr,t.side+" · "+money(t.entry));
        cell(tr,pct(t.entryDistance)+" vs VWAP");
        cell(tr,({open:"Open",tp:"TP first",sl:"SL first",timeout:"30m timeout",unknown:"Unresolved · data gap"})[t.status]);
        cell(tr,pct(t.mfe)+" / "+pct(t.mae));
        cell(tr,t.finishedAt&&t.status!=="unknown"?Math.max(0,(t.finishedAt-t.startedAt)/60000).toFixed(1)+"m":"—");
        cell(tr,pct(t.net));
        cell(tr,t.settings.tp+"% / "+t.settings.sl+"%");
        body.appendChild(tr);
      }
    }
    fields.forEach(k=>{$("paper-"+k).value=s.settings[k];});
    $("paperApply").addEventListener("click",()=>{
      const next=Object.fromEntries(fields.map(k=>[k,Number($("paper-"+k).value)]));
      if(!validSettings(next)){$("paperSettingsNote").textContent="Invalid settings: TP/SL >0 to 20%; fee/slippage 0 to 2% per side.";return;}
      s.settings=next;save();$("paperSettingsNote").textContent="Saved for future entries. Existing entries retain their original settings.";draw();
    });
    $("paperExport").addEventListener("click",()=>{
      const cols=["id","product","side","startedAt","entry","entryVwap","entryDistance","ratio","threshold","windowMinutes","techVotes","status","mfe","mae","exit","finishedAt","gross","cost","net","tp","sl","fee","slip","cursor"];
      const lines=[cols,...s.records.map(t=>cols.map(k=>t.settings[k]??t[k]??""))].map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(",")).join("\r\n");
      const url=URL.createObjectURL(new Blob([lines],{type:"text/csv;charset=utf-8"}));
      const a=document.createElement("a");a.href=url;a.download="trades-counter-paper.csv";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    if(typeof window!=="undefined")window.addEventListener("pagehide",save);
    draw();
    return Object.freeze({observe(p){
      if(observe(s,p)){save();draw();}
    }});
  }
  return {createState,serialize,observe,advance,summary,mount};
});
