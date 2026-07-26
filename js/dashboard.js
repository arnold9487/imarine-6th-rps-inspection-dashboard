// ===== 動態風險巡檢決策儀表盤 =====
"use strict";
const D = window.INSPECTIONS;
const WEIGHT = { S: 1, M: 2, L: 3 };
const SIZE_ZH = { S: "小", M: "中", L: "大" };
const BETA = (D.meta && D.meta.beta) || 0.1;
const HOURS = D.window.hours || 72;
const START = D.window.startMs;
const CTS = D.ctOrder;
const TERM = D.terminals;

const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, "0");
const DOW = ["日", "一", "二", "三", "四", "五", "六"];

// PPI 三段配色(藍→橙→紅)
function ppiColor(p) {
  p = Math.max(0, Math.min(1, p));
  const stops = [[59,130,246],[245,158,11],[239,68,68]];
  const seg = p < 0.5 ? 0 : 1, t = seg === 0 ? p/0.5 : (p-0.5)/0.5;
  const a = stops[seg], b = stops[seg+1];
  const m = i => Math.round(a[i] + (b[i]-a[i]) * t);
  return `rgb(${m(0)},${m(1)},${m(2)})`;
}

// 某時刻各 CT 的指標
function computeAt(ms) {
  const out = [];
  let maxRps = 0;
  for (const ct of CTS) {
    let n = 0, wsum = 0, teu = 0, nd = 0, dsum = 0;
    for (const v of D.visits) {
      if (v.ct !== ct) continue;
      if (v.aMs <= ms && ms < v.eMs) {
        n++; wsum += WEIGHT[v.size] || 1; teu += v.teu;
        nd += v.nd; dsum += v.dsum;
      }
    }
    const limit = TERM[ct].limit;
    const ppi = limit ? wsum / limit : 0;
    const rps = ppi * (1 + BETA * dsum);
    maxRps = Math.max(maxRps, rps);
    out.push({ ct, name: TERM[ct].name, limit, n, wsum, teu, nd, dsum, ppi, rps });
  }
  out.sort((a, b) => b.rps - a.rps || b.ppi - a.ppi);
  return { rows: out, maxRps };
}

// ---- FLIP 動畫:列在重排時滑動 ----
const rowEls = {};   // ct -> <tr>
const tbody = $("#rows");
function ensureRow(ct) {
  if (rowEls[ct]) return rowEls[ct];
  const tr = document.createElement("tr");
  tr.dataset.ct = ct;
  tr.innerHTML = `<td class="lft rank"></td><td class="lft ctname"></td>
    <td class="c-n"></td><td class="c-w"></td><td class="c-lim"></td>
    <td class="c-ppi"></td><td class="c-teu"></td><td class="c-nd"></td>
    <td class="c-ds dscore"></td><td class="c-rps"></td>`;
  rowEls[ct] = tr;
  return tr;
}

function render(ms) {
  const { rows, maxRps } = computeAt(ms);

  // FLIP: 記錄舊位置
  const firstTop = {};
  for (const ct in rowEls) firstTop[ct] = rowEls[ct].getBoundingClientRect().top;

  rows.forEach((r, i) => {
    const tr = ensureRow(r.ct);
    tr.classList.toggle("top", i === 0 && r.rps > 0);
    const hot = r.nd > 0;
    tr.querySelector(".rank").textContent = i + 1;
    tr.querySelector(".ctname").innerHTML =
      `${hot ? '<span class="alert-dot"></span>' : ''}<span>${r.name}</span><small>${r.ct}</small>`;
    tr.querySelector(".c-n").textContent = r.n;
    tr.querySelector(".c-w").textContent = r.wsum;
    tr.querySelector(".c-lim").textContent = r.limit;
    tr.querySelector(".c-ppi").innerHTML =
      `<span class="ppi-cell"><span class="ppi-bar"><i style="width:${Math.min(100,r.ppi*100)}%;background:${ppiColor(r.ppi)}"></i></span>`
      + `<span class="ppi-val" style="color:${ppiColor(r.ppi)}">${Math.round(r.ppi*100)}%</span></span>`;
    tr.querySelector(".c-teu").textContent = r.teu ? r.teu.toLocaleString() : "—";
    const nd = tr.querySelector(".c-nd");
    nd.textContent = r.nd || 0; nd.className = "c-nd dmg" + (hot ? " hot" : "");
    tr.querySelector(".c-ds").textContent = r.dsum ? r.dsum.toFixed(2) : "0";
    const w = maxRps ? Math.min(100, r.rps / maxRps * 100) : 0;
    tr.querySelector(".c-rps").innerHTML =
      `<span class="rps-wrap"><span class="rps-bar"><i style="width:${w}%"></i></span>`
      + `<span class="rps-cell">${r.rps.toFixed(2)}</span></span>`;
    tbody.appendChild(tr);   // 依新排序重新插入
  });

  // FLIP: 反轉 + 播放
  for (const ct in rowEls) {
    const tr = rowEls[ct];
    const dy = firstTop[ct] - tr.getBoundingClientRect().top;
    if (dy) {
      tr.style.transform = `translateY(${dy}px)`;
      tr.style.transition = "transform 0s";
      requestAnimationFrame(() => {
        tr.style.transition = "";
        tr.style.transform = "";
      });
    }
  }

  // 時鐘 + KPI
  const d = new Date(ms);
  $("#clock").textContent = `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:00`;
  $("#dow").textContent = `週${DOW[d.getDay()]}`;
  const top = rows[0];
  const totNd = rows.reduce((s,r)=>s+r.nd,0);
  const totShip = rows.reduce((s,r)=>s+r.n,0);
  $("#kpi").innerHTML =
    `<span>當前榜首 <b style="color:var(--rps)">${top.rps>0?top.name:'—'}</b> RPS <b>${top.rps.toFixed(2)}</b></span>`
    + `<span>在泊船 <b>${totShip}</b> 艘</span>`
    + `<span>偵測破損櫃 <b style="color:var(--dmg)">${totNd}</b></span>`;
}

// ---- 時間控制 ----
const slider = $("#slider");
slider.max = String(HOURS - 1);
let idx = +slider.value;
function show(i) { idx = Math.max(0, Math.min(HOURS-1, i)); slider.value = idx; render(START + idx*3600e3); }

slider.addEventListener("input", () => show(+slider.value));

let timer = null;
function stop(){ if(timer){clearInterval(timer);timer=null;} $("#play").textContent="▶"; }
function playLoop(){
  stop(); $("#play").textContent="⏸";
  timer = setInterval(() => {
    if (idx >= HOURS-1) { show(0); }
    else show(idx+1);
  }, +$("#speed").value);
}
$("#play").addEventListener("click", () => timer ? stop() : playLoop());
$("#speed").addEventListener("change", () => { if(timer) playLoop(); });
document.querySelectorAll("[data-jump]").forEach(b =>
  b.addEventListener("click", () => { stop(); const s=D.scenes||{}; show(s[b.dataset.jump] ?? idx); }));

// β 顯示綁資料
const betaLabel = $("#beta-label"); if (betaLabel) betaLabel.textContent = "β = " + BETA;

// 初始:跳到白天尖峰
show((D.scenes && D.scenes.peak != null) ? D.scenes.peak : 12);
