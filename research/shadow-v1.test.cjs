"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname,"shadow-v1.js"),"utf8");
const storageKey = "tc.shadow.research.v1";

function setup(savedValue) {
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
  const context = {document,window,localStorage,console,
    Blob:class { constructor(x,o){this.parts=x;this.options=o;} },
    URL:{createObjectURL(){return "blob:stub";},revokeObjectURL(){}},
    setTimeout(fn){fn();},Date,Math,Number,String,Array,Object};
  vm.runInNewContext(source, context, {filename:"shadow-v1.js"});
  return {observe:window.TradesCounterShadow.observe,callbacks,nodes,saved,memory};
}

function sample(t, opts={}) {
  const buys = opts.tradeBuys ?? 24;
  const trades=Array.from({length:40},(_,i)=>({
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

test("missing observations are never reconstructed from stale prices or a resumed browser", () => {
  const f=setup(),t=Date.UTC(2026,10,23,14);
  f.observe(sample(t,{ratio:1.1,tradeBuys:20}));
  f.observe(sample(t+1000,{ratio:1.9,tradeBuys:28}));
  f.observe(sample(t+50000,{ratio:1.9,tradeBuys:28}));
  assert.equal(f.saved().events.length,2);
  assert.equal(f.saved().events[0].checkpoints["5"].status,"not observed");
  const restored=setup(f.memory.get(storageKey));
  assert.equal(restored.saved().events[0].checkpoints["15"].status,"not observed");
  assert.equal(restored.saved().events[0].checkpoints["30"].status,"not observed");
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
