/* Trades Counter shadow research v1.
 * Passive observation only. Does not modify production trade decision inputs.
 * Samples the existing Coinbase spot tape and rolling VWAP once per render.
 */
(() => {
  "use strict";

  const root = document.getElementById("shadowResearch");
  if (!root) return;

  const KEY = "tc.shadow.research.v1";
  const CHECKPOINTS = [5, 15, 30];
  const MAX_EVENTS = 120;
  const MIN_FILTERED_EXECUTIONS = 10;
  const CROSSING_COOLDOWN_MS = 5 * 60 * 1000;
  const MAX_CHECKPOINT_DELAY_MS = 120 * 1000;
  const MAX_SAMPLE_GAP_MS = 30 * 1000;
  const RUN_ID = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  const $ = id => document.getElementById(id);

  const el = {
    all: $("shadowAllRatio"),
    allMeta: $("shadowAllMeta"),
    filtered: $("shadowFilteredRatio"),
    filteredMeta: $("shadowFilteredMeta"),
    filteredTitle: $("shadowFilteredTitle"),
    status: $("shadowStatus"),
    summary: $("shadowSummary"),
    window: $("shadowWindow"),
    minUsd: $("shadowMinUsd"),
    events: $("shadowEvents"),
    count: $("shadowEventCount"),
    export: $("shadowExport"),
    clear: $("shadowClear")
  };

  const state = {
    filterUsd: 1000,
    events: [],
    currentScope: "",
    observedEligibility: Object.create(null),
    lastSampleAt: 0,
    lastSaveAt: 0,
    lastSnapshot: null
  };

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  function readStorage() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!saved || saved.version !== 1) return;
      if ([500, 1000, 2500, 5000, 10000, 25000].includes(Number(saved.filterUsd))) {
        state.filterUsd = Number(saved.filterUsd);
      }
      if (Array.isArray(saved.events)) {
        state.events = saved.events.filter(e =>
          e && /^[0-9a-z-]{8,}$/i.test(String(e.id || "")) &&
          ["all", "large"].includes(e.mode) &&
          ["buy", "sell"].includes(e.direction) &&
          Number.isFinite(num(e.time)) &&
          typeof e.product === "string" &&
          e.checkpoints && typeof e.checkpoints === "object"
        ).slice(0, MAX_EVENTS);
        // A prior tab session cannot provide timestamp-accurate forward samples.
        for (const e of state.events) {
          if (e.runId !== RUN_ID) markPending(e, "not observed");
        }
      }
    } catch (err) {
      console.warn("Shadow research storage unavailable", err);
    }
  }

  function saveStorage() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        version: 1,
        filterUsd: state.filterUsd,
        events: state.events.slice(0, MAX_EVENTS)
      }));
      state.lastSaveAt = Date.now();
    } catch (err) {
      console.warn("Shadow research could not save local history", err);
    }
  }

  function fmtRatio(value) {
    if (value === Infinity) return "+∞";
    if (value === -Infinity) return "-∞";
    if (!Number.isFinite(value)) return "—";
    return (value > 0 ? "+" : "") + value.toFixed(2);
  }

  function fmtVolume(value) {
    if (!Number.isFinite(value)) return "—";
    return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  }

  function fmtPercent(value) {
    if (!Number.isFinite(value)) return "—";
    return (value > 0 ? "+" : "") + value.toFixed(3) + "%";
  }

  function fmtMoney(value) {
    return "$" + Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function ratioForVolumes(buy, sell) {
    if (!buy && !sell) return 0;
    if (!sell) return Infinity;
    if (!buy) return -Infinity;
    if (buy >= sell) return buy / sell;
    return -(sell / buy);
  }

  function filteredSnapshot(trades, now, minutes, minUsd) {
    const cutoff = now - minutes * 60 * 1000;
    let buy = 0, sell = 0, eligible = 0, total = 0, notional = 0;
    for (const t of trades) {
      if (!t || t.ts < cutoff || t.ts > now + 5000 || !Number.isFinite(t.qty) || t.qty <= 0 ||
          !Number.isFinite(t.price) || t.price <= 0) continue;
      total++;
      const usd = t.qty * t.price;
      if (usd < minUsd) continue;
      eligible++;
      notional += usd;
      if (t.buy) buy += t.qty;
      else sell += t.qty;
    }
    return {buy, sell, eligible, total, notional, ratio: ratioForVolumes(buy, sell)};
  }

  function directionQualified(ratio, direction, threshold, dominantVolume, count, filtered) {
    if (!Number.isFinite(ratio) || ratio === 0) return false;
    if (filtered && count < MIN_FILTERED_EXECUTIONS) return false;
    if (!(dominantVolume >= 1000)) return false;
    return direction === "buy" ? ratio >= threshold : ratio <= -threshold;
  }

  function checkpointKey(minute) { return String(minute); }

  function markPending(event, reason) {
    let changed = false;
    for (const m of CHECKPOINTS) {
      const key = checkpointKey(m);
      if (!event.checkpoints[key]) {
        event.checkpoints[key] = { status: reason };
        changed = true;
      }
    }
    return changed;
  }

  function addEvent(p, mode, direction, ratio, selected) {
    const event = {
      id: String(p.now) + "-" + mode + "-" + direction,
      runId: RUN_ID,
      time: p.now,
      product: p.product,
      windowMinutes: p.windowMinutes,
      minUsd: state.filterUsd,
      mode,
      direction,
      threshold: p.threshold,
      ratio,
      entryPrice: p.price,
      entryVwap: p.vwap,
      selectedVolume: direction === "buy" ? selected.buy : selected.sell,
      eligibleExecutions: selected.eligible,
      context: p.context || {},
      lastObservedAt: p.now,
      checkpoints: {}
    };
    state.events.unshift(event);
    state.events = state.events.slice(0, MAX_EVENTS);
    saveStorage();
  }

  function updateCrossings(p, filtered) {
    const all = {
      ratio: p.ratio,
      buy: p.stats.buyVol,
      sell: p.stats.sellVol,
      eligible: p.stats.entries
    };
    const modes = [
      { name: "all", info: all, countGate: false },
      { name: "large", info: { ratio: filtered.ratio, buy: filtered.buy, sell: filtered.sell, eligible: filtered.eligible }, countGate: true }
    ];

    let recorded = false;
    for (const m of modes) {
      for (const dir of ["buy", "sell"]) {
        const key = m.name + ":" + dir;
        const volume = dir === "buy" ? m.info.buy : m.info.sell;
        // Detect a fresh ratio crossing. A delayed volume/count qualification alone
        // must NOT be mislabeled as a threshold-crossing event.
        const ratioCrossed = dir === "buy" ? m.info.ratio >= p.threshold : m.info.ratio <= -p.threshold;
        const qualified = ratioCrossed &&
          directionQualified(m.info.ratio, dir, p.threshold, volume, m.info.eligible, m.countGate);
        const previousCrossed = state.observedEligibility[key];
        // On first observation, initialize without manufacturing a historic crossing.
        if (previousCrossed === false && qualified) {
          const last = state.events.find(e => e.mode === m.name && e.direction === dir &&
            e.product === p.product && e.windowMinutes === p.windowMinutes &&
            (m.name === "all" || e.minUsd === state.filterUsd));
          if (!last || p.now - last.time >= CROSSING_COOLDOWN_MS) {
            addEvent(p, m.name, dir, m.info.ratio, m.info);
            recorded = true;
          }
        }
        state.observedEligibility[key] = ratioCrossed;
      }
    }
    return recorded;
  }

  function updateOutcomes(p) {
    let changed = false;
    for (const e of state.events) {
      if (e.runId !== RUN_ID) continue;
      if (CHECKPOINTS.every(m => e.checkpoints[checkpointKey(m)])) continue;

      if (e.product !== p.product || e.windowMinutes !== p.windowMinutes) {
        if (markPending(e, "not observed")) changed = true;
        continue;
      }
      const gap = p.now - e.lastObservedAt;
      if (gap > MAX_SAMPLE_GAP_MS) {
        if (markPending(e, "not observed")) changed = true;
        continue;
      }

      for (const m of CHECKPOINTS) {
        const key = checkpointKey(m);
        if (e.checkpoints[key]) continue;
        const due = e.time + m * 60 * 1000;
        if (p.now < due) continue;
        if (p.now - due > MAX_CHECKPOINT_DELAY_MS || !p.dataFresh ||
            !Number.isFinite(p.price) || !Number.isFinite(p.vwap)) {
          if (p.now - due > MAX_CHECKPOINT_DELAY_MS) {
            e.checkpoints[key] = {status:"not observed"};
            changed = true;
          }
          continue;
        }

        const sign = e.direction === "buy" ? 1 : -1;
        e.checkpoints[key] = {
          status: "observed",
          observedAt: p.now,
          pricePct: sign * ((p.price / e.entryPrice) - 1) * 100,
          vwapPct: sign * ((p.vwap / e.entryVwap) - 1) * 100,
          price: p.price,
          vwap: p.vwap,
          // Directional change in distance of price from rolling VWAP.
          distanceChangePct: sign * (((p.price - p.vwap) - (e.entryPrice - e.entryVwap)) / e.entryPrice) * 100
        };
        changed = true;
      }
      e.lastObservedAt = p.now;
    }
    return changed;
  }

  function dom(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = String(text);
    return result;
  }

  function labelRatio(element, ratio, ready) {
    element.className = "shadowRatio " + (ready ? (ratio >= 1 ? "bull" : ratio <= -1 ? "bear" : "") : "");
    element.textContent = fmtRatio(ratio);
  }

  function resultCell(result) {
    const td = dom("td", "shadowResult");
    if (!result) {
      td.textContent = "Pending";
      td.classList.add("pending");
      return td;
    }
    if (result.status !== "observed") {
      td.textContent = result.status === "not observed" ? "Not observed" : "Pending";
      td.classList.add("pending");
      return td;
    }
    const p = dom("div", result.pricePct > 0 ? "positive" : result.pricePct < 0 ? "negative" : "", "Price " + fmtPercent(result.pricePct));
    const v = dom("div", result.vwapPct > 0 ? "positive" : result.vwapPct < 0 ? "negative" : "", "VWAP " + fmtPercent(result.vwapPct));
    td.append(p, v);
    return td;
  }

  function renderHistory() {
    el.events.replaceChildren();
    el.count.textContent = String(state.events.length) + " crossings stored locally";
    if (!state.events.length) {
      const tr = dom("tr");
      const td = dom("td", "shadowEmpty", "No new threshold crossings recorded yet. Keep this page running with a complete trade window to collect evidence.");
      td.colSpan = 6;
      tr.appendChild(td);
      el.events.appendChild(tr);
      return;
    }

    for (const e of state.events.slice(0, 12)) {
      const tr = dom("tr");
      const timestamp = new Date(e.time);
      const tdTime = dom("td", "shadowTime",
        timestamp.toLocaleString("en-US", {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}));
      tdTime.appendChild(dom("small", "", e.product + " · " + e.windowMinutes + "m"));
      const tdMode = dom("td", "", (e.mode === "large" ? "Filtered" : "All trades"));
      tdMode.appendChild(dom("small", "", (e.direction === "buy" ? "BUY" : "SELL") +
        (e.mode === "large" ? " · " + fmtMoney(e.minUsd) + "/fill" : " · all sizes")));
      tdMode.classList.add(e.direction === "buy" ? "shadowBuy" : "shadowSell");
      const tdRatio = dom("td", "shadowNum", fmtRatio(e.ratio));
      const data = [tdTime, tdMode, tdRatio];
      for (const m of CHECKPOINTS) data.push(resultCell(e.checkpoints[checkpointKey(m)]));
      tr.append(...data);
      el.events.appendChild(tr);
    }
  }

  function renderSummary() {
    const completed = mode => state.events.filter(e => e.mode === mode &&
      e.checkpoints["15"] && e.checkpoints["15"].status === "observed");
    const all = completed("all");
    const large = completed("large");
    const describe = (name, rows) => {
      if (!rows.length) return name + ": no completed 15m observations";
      const follow = rows.filter(e => e.checkpoints["15"].pricePct > 0 && e.checkpoints["15"].vwapPct > 0).length;
      const avg = rows.reduce((v,e) => v + e.checkpoints["15"].pricePct, 0) / rows.length;
      return name + ": " + follow + "/" + rows.length +
        " price + VWAP follow-through · avg directional price " + fmtPercent(avg);
    };
    el.summary.textContent = describe("All", all) + "   |   " + describe("Filtered", large);
  }

  function render(p, filtered, full, fresh) {
    const baseSymbol = (p.product || "").split("-")[0] || "base";
    const allRatio = p.ratio;
    const baseSideVol = allRatio >= 0 ? p.stats.buyVol : p.stats.sellVol;
    const filteredSideVol = filtered.ratio >= 0 ? filtered.buy : filtered.sell;
    const filteredReady = filtered.eligible >= MIN_FILTERED_EXECUTIONS && filtered.buy > 0 && filtered.sell > 0;

    el.window.textContent = p.windowMinutes + "m · " + p.product;
    el.filteredTitle.textContent = "Executions ≥ " + fmtMoney(state.filterUsd);
    labelRatio(el.all, allRatio, true);
    labelRatio(el.filtered, filtered.ratio, filteredReady);

    el.allMeta.textContent = "Dominant " + fmtVolume(baseSideVol) + " " + baseSymbol +
      " · " + fmtVolume(p.stats.entries) + " executions";
    el.filteredMeta.textContent = fmtVolume(filtered.eligible) + "/" + fmtVolume(filtered.total) +
      " eligible executions · dominant " + fmtVolume(filteredSideVol) + " " + baseSymbol +
      (filteredReady ? "" : " · thin sample");

    if (!full) {
      el.status.textContent = "WAIT: incomplete " + p.windowMinutes + "m trade window";
      el.status.className = "shadowState warning";
    } else if (!fresh) {
      el.status.textContent = "WAIT: live executions are stale";
      el.status.className = "shadowState warning";
    } else {
      el.status.textContent = "OBSERVING · crossing events only";
      el.status.className = "shadowState ready";
    }
    renderSummary();
  }

  function exportCsv() {
    const cols = [
      "time_utc","market","source","direction","window_minutes","min_execution_usd",
      "threshold","ratio","selected_base_volume","eligible_executions","entry_price","entry_vwap",
      "technical_buy_votes","technical_sell_votes","swing_bias","macro_label",
      "price_5m_pct","vwap_5m_pct","status_5m",
      "price_15m_pct","vwap_15m_pct","status_15m",
      "price_30m_pct","vwap_30m_pct","status_30m"
    ];
    const rows = [cols];
    for (const e of state.events.slice().reverse()) {
      const row = [
        new Date(e.time).toISOString(),e.product,e.mode,e.direction,e.windowMinutes,
        e.mode === "large" ? e.minUsd : 0,e.threshold,e.ratio,e.selectedVolume,
        e.eligibleExecutions,e.entryPrice,e.entryVwap,
        e.context && e.context.techBuy,e.context && e.context.techSell,
        e.context && e.context.swing,e.context && e.context.macro
      ];
      for (const m of CHECKPOINTS) {
        const x = e.checkpoints[checkpointKey(m)];
        row.push(x && x.status === "observed" ? x.pricePct : "");
        row.push(x && x.status === "observed" ? x.vwapPct : "");
        row.push(x ? x.status : "pending");
      }
      rows.push(row);
    }
    const csv = rows.map(row => row.map(value => {
      const s = value === null || value === undefined ? "" : String(value);
      return '"' + s.replace(/"/g, '""') + '"';
    }).join(",")).join("\r\n");
    const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = dom("a");
    a.href = url;
    a.download = "trades-counter-shadow-events-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function observe(raw) {
    if (!raw || !Array.isArray(raw.trades) || !raw.stats) return;
    const now = num(raw.now);
    if (!Number.isFinite(now) || now - state.lastSampleAt < 900) return;
    state.lastSampleAt = now;

    const p = {
      now,
      product: String(raw.product || ""),
      windowMinutes: Number(raw.windowMinutes) || 15,
      threshold: num(raw.threshold),
      trades: raw.trades,
      stats: raw.stats,
      ratio: raw.ratio,
      price: num(raw.price),
      vwap: num(raw.vwap),
      dataFresh: !!raw.dataFresh,
      complete: !!raw.complete,
      context: raw.context || {}
    };
    const scope = p.product + "|" + p.windowMinutes + "|" + state.filterUsd + "|" + p.threshold;
    if (scope !== state.currentScope) {
      state.currentScope = scope;
      state.observedEligibility = Object.create(null);
    }

    const filtered = filteredSnapshot(p.trades, p.now, p.windowMinutes, state.filterUsd);
    const usable = p.complete && p.dataFresh && Number.isFinite(p.price) &&
      Number.isFinite(p.vwap) && p.vwap > 0 &&
      Number.isFinite(p.threshold) && p.threshold > 1;

    if (usable) {
      const recorded = updateCrossings(p, filtered);
      const outcomesChanged = updateOutcomes(p);
      if (outcomesChanged && !recorded) saveStorage();
    } else {
      // Do not manufacture first crossings from partial/stale data.
      // Still expire abandoned observations instead of relabeling them as measured.
      const expired = state.events.some(e => {
        if (e.runId !== RUN_ID || CHECKPOINTS.every(m => e.checkpoints[checkpointKey(m)])) return false;
        if (p.now - e.lastObservedAt <= MAX_SAMPLE_GAP_MS) return false;
        return markPending(e, "not observed");
      });
      if (expired) saveStorage();
    }

    render(p, filtered, p.complete, p.dataFresh);
    renderHistory();
    state.lastSnapshot = {p, filtered};
  }

  el.minUsd.value = String(state.filterUsd);
  el.minUsd.addEventListener("change", () => {
    const v = Number(el.minUsd.value);
    if (![500,1000,2500,5000,10000,25000].includes(v)) return;
    state.filterUsd = v;
    state.currentScope = "";
    state.observedEligibility = Object.create(null);
    saveStorage();
    if (state.lastSnapshot) {
      const p = state.lastSnapshot.p;
      const filtered = filteredSnapshot(p.trades, p.now, p.windowMinutes, state.filterUsd);
      render(p, filtered, p.complete, p.dataFresh);
    }
  });
  el.export.addEventListener("click", exportCsv);
  el.clear.addEventListener("click", () => {
    if (!state.events.length) return;
    if (!window.confirm("Clear locally recorded research events? Export a CSV first if you need them.")) return;
    state.events = [];
    state.observedEligibility = Object.create(null);
    state.currentScope = "";
    saveStorage();
    renderHistory();
    renderSummary();
  });

  readStorage();
  el.minUsd.value = String(state.filterUsd);
  renderHistory();
  renderSummary();
  window.TradesCounterShadow = Object.freeze({ observe });
})();
