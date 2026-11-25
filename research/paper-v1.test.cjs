const {test}=require("node:test");
const assert=require("node:assert/strict");
const {createState,serialize,observe,summary}=require("./paper-v1.js");
const T=Date.UTC(2026,10,25,16);
const trade=(id,price,ts=T+id-100)=>({tradeId:id,price,ts});
function snap(now,action,trades,opts={}){
 return {now,product:"ETH-USD",windowMinutes:15,threshold:1.65,verified:true,gatesReady:true,
  action,price:trades.at(-1)?.price??2000,vwap:1995,ratio:1.8,techVotes:2,trades,...opts};
}
function open(side="BUY",settings){
 const s=createState();if(settings)s.settings={...s.settings,...settings};
 observe(s,snap(T,"NO-GO",[trade(100,2000,T)]));
 observe(s,snap(T+1000,side,[trade(101,2000,T+900)]));
 assert.equal(s.records.length,1);assert.equal(s.records[0].status,"open");return s;
}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,a+" != "+b);
test("only new verified 15m qualified transitions open a position; startup active signal ignored",()=>{
 const s=createState(),rows=[trade(100,2000,T)];
 observe(s,snap(T,"BUY",rows));assert.equal(s.records.length,0);
 observe(s,snap(T+1000,"NO-GO",rows));
 observe(s,snap(T+2000,"BUY",rows,{verified:false}));assert.equal(s.records.length,0);
 observe(s,snap(T+3000,"BUY",rows));assert.equal(s.records.length,0);
 observe(s,snap(T+4000,"NO-GO",rows));
 observe(s,snap(T+5000,"BUY",rows));assert.equal(s.records.length,1);
 observe(s,snap(T+6000,"BUY",rows));assert.equal(s.records.length,1);
});
test("unready gates and non-15m display do not initiate trades",()=>{
 const s=createState(),rows=[trade(100,2000,T)];
 observe(s,snap(T,"NO-GO",rows,{gatesReady:false}));
 observe(s,snap(T+1000,"BUY",rows));assert.equal(s.records.length,0);
 observe(s,snap(T+2000,"NO-GO",rows,{windowMinutes:5}));
 observe(s,snap(T+3000,"BUY",rows,{windowMinutes:5}));assert.equal(s.records.length,0);
});
test("long target first, excursions and cost math; ignores subsequent adverse tick",()=>{
 const s=open();const rows=[trade(104,1950,T+4000),trade(103,2010,T+3000),trade(102,1990,T+2000)];
 observe(s,snap(T+5000,"BUY",rows));const t=s.records[0];
 assert.equal(t.status,"tp");near(t.mfe,.5);near(t.mae,-.5);
 near(t.gross,.5);near(t.cost,.1604);near(t.net,.3396);assert.equal(t.finishedAt,T+3000);
});
test("short stop first, later target does not replace outcome",()=>{
 const s=open("SELL");observe(s,snap(T+5000,"SELL",[trade(102,2030,T+2000),trade(103,1980,T+3000)]));
 const t=s.records[0];assert.equal(t.status,"sl");near(t.mae,-1.5);near(t.gross,-1.5);
});
test("gap cannot produce false TP; restored earlier tick determines SL first",()=>{
 const s=open();observe(s,snap(T+4000,"NO-GO",[trade(103,2015,T+3000)],{verified:false}));
 assert.equal(s.records[0].status,"open");assert.equal(s.records[0].cursor,101);
 observe(s,snap(T+5000,"NO-GO",[trade(103,2015,T+3000),trade(102,1960,T+2000)]));
 assert.equal(s.records[0].status,"sl");
});
test("persisted cursor and entry settings survive refresh; recovered sequence settles once",()=>{
 const s=open();observe(s,snap(T+2000,"BUY",[trade(102,2005,T+1800)]));
 s.settings.tp=1.2;const r=createState(JSON.parse(JSON.stringify(serialize(s))));
 assert.equal(r.records[0].cursor,102);assert.equal(r.records[0].settings.tp,.5);
 observe(r,snap(T+4000,"BUY",[trade(102,2005,T+1800),trade(103,2011,T+3000)]));
 assert.equal(r.records[0].status,"tp");assert.equal(r.records.length,1);
});
test("timeout needs contiguous path through the deadline; gap expires unresolved",()=>{
 const s=open(),deadline=T+1000+30*60000;
 observe(s,snap(deadline+1000,"NO-GO",[trade(102,2004,deadline-1000),trade(103,2040,deadline+100)]));
 assert.equal(s.records[0].status,"timeout");near(s.records[0].gross,.2);
 const g=open();observe(g,snap(deadline+121000,"NO-GO",[trade(105,2040,deadline+100)]));
 assert.equal(g.records[0].status,"unknown");assert.equal(g.records[0].net,undefined);
});
test("one position at a time; opposite signal skipped, no automatic re-entry",()=>{
 const s=open();observe(s,snap(T+2000,"SELL",[trade(102,2001,T+1800)]));
 assert.equal(s.skipped,1);assert.equal(s.records.length,1);
 observe(s,snap(T+3000,"SELL",[trade(103,2012,T+2800)]));
 assert.equal(s.records[0].status,"tp");assert.equal(s.records.length,1);
});
test("different product executions cannot settle an existing position",()=>{
 const s=open();observe(s,snap(T+2000,"BUY",[trade(102,100000,T+1800)],{product:"BTC-USD"}));
 assert.equal(s.records[0].status,"open");assert.equal(s.records[0].cursor,101);
 assert.equal(summary(s).open,1);
});
