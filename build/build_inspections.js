// 階段二:把貨櫃(含真實破損信心)指派給時間窗內的每艘船,輸出 inspections.js
// 執行:node build_inspections.js
"use strict";
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "data", "inspections.js");

// ---- 參數(先前已敲定)----
const YEAR = 2025, MONTH = 5;            // 6 月
const START = new Date(YEAR, MONTH, 14, 0, 0).getTime();   // 6/14 00:00
const HOURS = 72;                        // 3 天
const END = START + HOURS * 3600e3;
const TEU = { S: 300, M: 600, L: 900 };
const RATE = 0.015;                      // 破損率 1.5%
const BETA = 0.02;                       // 真實數據校準後(D_score 在繁忙中心達 40~80)
const SEED = 20250615;
const CTS = ["CT1","CT2","CT3","CT4","CT5","CT6","CT7"];
const WEIGHT = { S:1, M:2, L:3 };

// ---- 種子亂數 ----
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
const rnd = mulberry32(SEED);
function gauss(){let u=0,v=0;while(!u)u=rnd();while(!v)v=rnd();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}
function binApprox(n,p){const m=n*p,s=Math.sqrt(n*p*(1-p));return Math.max(0,Math.round(m+gauss()*s));}
function pick(arr){return arr[Math.floor(rnd()*arr.length)];}

// ---- 載入資料 ----
global.window = {};
require(path.join(ROOT, "data", "port_data.js"));
const PD = global.window.PORT_DATA;
const pool = JSON.parse(fs.readFileSync(path.join(ROOT,"data","damage_pool.json"),"utf8"));
const CONF = pool.pool.slice().sort((a,b)=>a-b);
const hiCut = CONF[Math.floor(CONF.length*0.85)];        // 高信心池(前15%)供高潮情境
const HIPOOL = CONF.filter(c=>c>=hiCut);
console.log(`信心池 ${CONF.length} 筆,均值 ${pool.meta.mean_damage_conf},高信心門檻(P85)=${hiCut.toFixed(3)}`);

// ---- 視窗內船班 ----
const visits = [];
for (const v of PD.visits) {
  const a = new Date(v.arrive).getTime(), e = new Date(v.occ_end).getTime();
  if (e <= START || a >= END) continue;               // 不重疊視窗者略過
  if (!CTS.includes(v.ct)) continue;
  visits.push({ ct:v.ct, cn:v.cn, size:v.size, aMs:a, eMs:e, _v:v });
}
console.log(`視窗 6/14–6/17 內船班:${visits.length} 艘`);

// ---- 指派破損(隨機分配各船)----
function assign(vis, hi){
  const teu = TEU[vis.size] || 300;
  let nd = binApprox(teu, RATE);
  const src = hi ? HIPOOL : CONF;
  if (hi) nd = Math.max(nd, vis.size==="L"?16:vis.size==="M"?11:6);   // 高潮船:壞櫃偏多
  let dsum = 0;
  for (let i=0;i<nd;i++) dsum += pick(src);
  vis.teu = teu; vis.nd = nd; vis.dsum = +dsum.toFixed(3);
}

// 先普通指派
for (const v of visits) assign(v, false);

// ---- 指標函式 ----
function present(ct,ms){return visits.filter(v=>v.ct===ct && v.aMs<=ms && ms<v.eMs);}
function wsum(ct,ms){return present(ct,ms).reduce((s,v)=>s+(WEIGHT[v.size]||1),0);}
function ppi(ct,ms){return wsum(ct,ms)/PD.terminals[ct].limit;}
function dscore(ct,ms){return present(ct,ms).reduce((s,v)=>s+v.dsum,0);}
function rps(ct,ms){return ppi(ct,ms)*(1+BETA*dscore(ct,ms));}
function topOtherRps(ct,ms){return Math.max(0,...CTS.filter(c=>c!==ct).map(c=>rps(c,ms)));}
const HH=ms=>new Date(ms).getHours(), DD=ms=>new Date(ms).getDate();
const lbl=idx=>{const ms=START+idx*3600e3;return `6/${DD(ms)} ${String(HH(ms)).padStart(2,"0")}h`;};

// 把某船改成「異常高破損批次」,信心自高信心池抽,直到 dsum≥target(有上限)
function makeAnomaly(v,target){
  v.nd=0; v.dsum=0;
  while(v.dsum<target && v.nd<150){ v.dsum+=pick(HIPOOL); v.nd++; }
  v.dsum=+v.dsum.toFixed(3);
}
// 讓 ct 在 ms 這一刻的 RPS 超過其他所有 CT(乘 margin);把需求灌到該 CT 最大的在泊船
// floor:D_score 下限,確保注入是「有份量的異常批次」而非剛好壓過
function forceTop(ct,ms,margin,floor=0,pred=null){
  const p=ppi(ct,ms); if(p<=0) return null;
  const need=((topOtherRps(ct,ms)*margin)/p - 1)/BETA;    // 需要的 D_score
  let ships=present(ct,ms);
  if(pred){const f=ships.filter(pred); if(f.length) ships=f;}  // 場景隔離:只灌不影響另一幕時刻的船
  ships=ships.slice().sort((a,b)=>(TEU[b.size]-TEU[a.size]));
  const tgt=ships[0]; if(!tgt) return null;
  const others=present(ct,ms).filter(v=>v!==tgt).reduce((s,v)=>s+v.dsum,0);
  makeAnomaly(tgt, Math.max(Math.max(0,need-others)+2, floor));
  return {ct,idx:Math.round((ms-START)/3600e3),ppi:p,rps:+rps(ct,ms).toFixed(3),nd:tgt.nd,ship:tgt.cn};
}

// === 場景1:壅塞尖峰(9–18h 單一 CT 最高 PPI,純壅塞驅動,不注入)===
let peakIdx=12, peakP=0, peakCT=null;
for(let i=0;i<HOURS;i++){ if(HH(START+i*3600e3)<9||HH(START+i*3600e3)>18)continue;
  for(const ct of CTS){const p=ppi(ct,START+i*3600e3);if(p>peakP){peakP=p;peakIdx=i;peakCT=ct;}}}

// === 場景2:破損翻轉(午後 11–16h 壓力接近的時段;主角須「非尖峰中心 CT」且注入成本最小)===
// 傍晚 CT7 一枝獨秀無法自然翻轉;午後 CT2/CT3/CT6 擠成一團,差距小、翻轉真實。
let flip=null,flipCost=1e9;
for(let i=0;i<HOURS;i++){const ms=START+i*3600e3;if(HH(ms)<11||HH(ms)>16)continue;
  const active=CTS.filter(c=>ppi(c,ms)>0).sort((a,b)=>ppi(b,ms)-ppi(a,ms));
  if(active.length<3)continue;
  const top=active[0];
  for(const ct of active.slice(1,4)){                    // 第2~4名當翻轉主角
    if(ct===peakCT)continue;                             // 主角不能是尖峰那個中心
    const p=ppi(ct,ms); if(p<0.30||p>=ppi(top,ms))continue;
    const need=((rps(top,ms)*1.15)/p-1)/BETA - dscore(ct,ms);   // 還差多少 D_score
    if(need>0 && need<flipCost && need<45){ flipCost=need; flip={idx:i,ct,ms,topCT:top}; }
  }}

// === 場景3:深夜異常批次衝頂(1–5h、視窗中段,低 PPI 且有船在泊且該船停留數小時;盡量換不同中心)===
let night=null;
{ // 收集所有可行候選(深夜低壓 + 有隔離船 + 打得贏),優先「非翻轉主角、壓力最低」者
  const cands=[];
  for(let i=6;i<HOURS-2;i++){const ms=START+i*3600e3;const h=HH(ms);if(h>5&&h<23)continue;   // 23–05h
    for(const ct of CTS){
      const pr=present(ct,ms);const p=ppi(ct,ms);
      if(pr.length<1||p<=0||p>=0.30)continue;
      // 注入目標:還會停 ≥2h 即可(深夜幕先注入、翻轉幕最後校準,會自動吸收其影響)
      const iso=pr.filter(v=>(v.eMs-ms)/3600e3>=2);
      if(!iso.length)continue;
      // 可行性:壓過當時自然第一名所需的 D_score 必須在異常批次上限內
      const needD=((topOtherRps(ct,ms)*1.25)/p-1)/BETA - dscore(ct,ms);
      if(needD>=120)continue;
      cands.push({idx:i,ct,ms,p,avoid:(flip&&ct===flip.ct)?1:0});
    }}
  cands.sort((a,b)=>a.avoid-b.avoid || a.p-b.p);
  night=cands[0]||null;
}

// ---- 注入兩幕異常,並自我驗證 ----
const report=[];
// 注入順序:先深夜幕(只挑翻轉時刻之後才進港的船,保證不回頭影響翻轉那一刻),
// 最後校準翻轉幕(面對的是最終全局狀態,校準必然成立)
// 場景隔離:深夜幕只需「還會停 ≥2h」;翻轉幕嚴格只灌「深夜前就離港」的船
// (順序=深夜先注入、翻轉最後校準 → 翻轉自動吸收深夜影響;反向則靠 flipPred 隔離)
const nightPred = v=>!night||(v.eMs-night.ms)>=2*3600e3;
const flipPred  = v=>!night||v.eMs<=night.ms;
if(night){ const r=forceTop(night.ct,night.ms,1.25,32, nightPred);   // 下限 D_score≥32:真正的異常批次
  report.push(`深夜衝頂 ★ ${night.ct} @ ${lbl(night.idx)} PPI ${(ppi(night.ct,night.ms)*100).toFixed(0)}% → 注入異常批次後 RPS ${r.rps}(壞櫃 ${r.nd})`); }
if(flip){ const r=forceTop(flip.ct,flip.ms,1.15,0, flipPred);
  report.push(`傍晚翻轉 ⚡ ${flip.ct}(原 PPI 第 ${CTS.filter(c=>ppi(c,flip.ms)>ppi(flip.ct,flip.ms)).length+1} 名) @ ${lbl(flip.idx)} → 注入後 RPS ${r.rps}(壞櫃 ${r.nd}),壓過 ${flip.topCT}`); }

// 保險:若仍互相影響,重新加壓(隔離謂詞保證收斂)
for(let k=0;k<4;k++){
  let again=false;
  if(night && rankOf(night.ct,night.ms)!==1){ forceTop(night.ct,night.ms,1.25,32, nightPred); again=true; }
  if(flip && rankOf(flip.ct,flip.ms)!==1){ forceTop(flip.ct,flip.ms,1.15,0, flipPred); again=true; }
  if(!again) break;
}

// 驗證兩幕主角確實是該時刻 RPS 第一
function rankOf(ct,ms){return CTS.map(c=>[c,rps(c,ms)]).sort((a,b)=>b[1]-a[1]).findIndex(x=>x[0]===ct)+1;}
console.log(`白天尖峰 ▮ ${lbl(peakIdx)} PPI ${(peakP*100).toFixed(0)}%`);
report.forEach(s=>console.log(s));
if(flip) console.log(`  驗證:傍晚翻轉時 ${flip.ct} 排名 = ${rankOf(flip.ct,flip.ms)}`);
if(night) console.log(`  驗證:深夜衝頂時 ${night.ct} 排名 = ${rankOf(night.ct,night.ms)}`);

// ---- 輸出 ----
const terminals={}; for(const ct of CTS) terminals[ct]={name:PD.terminals[ct].name_zh,limit:PD.terminals[ct].limit};
const outVisits = visits.map(v=>({ct:v.ct,cn:v.cn,size:v.size,aMs:v.aMs,eMs:v.eMs,teu:v.teu,nd:v.nd,dsum:v.dsum}));
const payload = {
  meta:{ beta:BETA, damage_rate:RATE, teu_map:TEU, seed:SEED,
    pool_stats:pool.meta, generated:new Date().toISOString() },
  window:{ startMs:START, hours:HOURS, startLabel:"2025-06-14 00:00" },
  scenes:{
    peak:peakIdx,
    flip: flip?flip.idx:peakIdx, flipCT: flip?flip.ct:null,
    night: night?night.idx:0, nightCT: night?night.ct:null,
  },
  terminals, ctOrder:CTS, visits:outVisits,
};
fs.writeFileSync(OUT, "window.INSPECTIONS = " + JSON.stringify(payload) + ";\n", "utf8");
console.log("已寫出:", OUT, `(${outVisits.length} 艘)`);
