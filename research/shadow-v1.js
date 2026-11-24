/* Trades Counter shadow research v2.
 * Passive observer: production signal logic is completely unaffected.
 * Stores timestamped trade-price / rolling-VWAP samples for honest checkpoint recovery.
 * Only historical price (not VWAP) can be approximated from Coinbase 1m candles.
 */
(() => {
  "use strict";

  const root = document.getElementById("shadowResearch");
  if (!root) return;

  const KEY = "tc.shadow.research.v1";
  const CHECKPOINTS = [5, 15, 30];
  const MAX_EVENTS = 120;
  const RAW_VISIBLE_LIMIT = 24;
  const MIN_FILTERED_EXECUTIONS = 10;
  const CROSSING_COOLDOWN_MS = 5 * 60 * 1000;
  const MAX_CHECKPOINT_DELAY_MS = 120 * 1000;
  const SNAPSHOT_INTERVAL_MS = 5000;
  const SNAPSHOT_TOLERANCE_MS = 10000;
  const SNAPSHOT_RETENTION_MS = 37 * 60 * 1000;
  const SAVE_INTERVAL_MS = 10000;
  const RECOVERY_DELAY_MS = 120 * 1000;
  const RECOVERY_INTERVAL_MS = 120 * 1000;
  const RECOVERY_RETRY_MS = 10 * 60 * 1000;
  const RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const RECOVERY_BUCKET_MS = 4 * 60 * 60 * 1000;
  const MAX_RECOVERY_BATCHES = 3;
  const RUN_ID = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  const $ = id => document.getElementById(id);

  const el = {
    rawEvents: $("shadowRawEvents"),
    rawCount: $("shadowRawCount"),
    title: $("shadowTitle"),
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
    lastHistoryRenderKey: "",
    samples: [],
    currentScope: "",
    observedEligibility: Object.create(null),
    lastSampleAt: 0,
    lastSaveAt: 0,
    nextRecoveryAt: 0,
    recoveryBusy: false,
    recoveryAttemptedAt: Object.create(null),
    lastSnapshot: null
  };

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  // Version-1 events are intentionally migrated in place: never throw away
  // the crossings a user already collected or convert future deadlines to failures.
  function readStorage() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!saved || ![1, 2].includes(saved.version)) return;
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
        const now = Date.now();
        for (const e of state.events) {
          for (const m of CHECKPOINTS) {
            const key = checkpointKey(m);
            // v1 accidentally marked every future checkpoint "not observed"
            // after a browser refresh or brief interruption.
            if (e.checkpoints[key]?.status === "not observed" &&
                now < e.time + m * 60 * 1000) delete e.checkpoints[key];
          }
        }
      }
      if (Array.isArray(saved.samples)) {
        const cutoff = Date.now() - SNAPSHOT_RETENTION_MS;
        state.samples = saved.samples.filter(s =>
          s && Number.isFinite(s.ts) && s.ts >= cutoff &&
          typeof s.product === "string" &&
          Number.isFinite(s.windowMinutes) &&
          Number.isFinite(s.price) && s.price > 0 &&
          Number.isFinite(s.vwap) && s.vwap > 0
        ).slice(-550);
      }
    } catch (err) {
      console.warn("Shadow research storage unavailable", err);
    }
  }

  function saveStorage() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        version: 2,
        filterUsd: state.filterUsd,
        events: state.events.slice(0, MAX_EVENTS),
        samples: state.samples
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

  function checkpointDue(event, minute) {
    return event.time + minute * 60 * 1000;
  }

  function recordSample(p) {
    if (!p.complete || !p.dataFresh ||
        !Number.isFinite(p.price) || p.price <= 0 ||
        !Number.isFinite(p.vwap) || p.vwap <= 0) return false;
    const last = state.samples[state.samples.length - 1];
    if (last && p.now - last.ts < SNAPSHOT_INTERVAL_MS &&
        last.product === p.product && last.windowMinutes === p.windowMinutes) return false;
    state.samples.push({
      ts: p.now,
      product: p.product,
      windowMinutes: p.windowMinutes,
      price: p.price,
      vwap: p.vwap
    });
    const cutoff = p.now - SNAPSHOT_RETENTION_MS;
    state.samples = state.samples.filter(s => s.ts >= cutoff).slice(-550);
    return true;
  }

  function closestSample(event, due) {
    let nearest = null, nearestGap = SNAPSHOT_TOLERANCE_MS + 1;
    for (const s of state.samples) {
      if (s.product !== event.product || s.windowMinutes !== event.windowMinutes) continue;
      const gap = Math.abs(s.ts - due);
      if (gap < nearestGap) {
        nearestGap = gap;
        nearest = s;
      }
    }
    return nearestGap <= SNAPSHOT_TOLERANCE_MS ? nearest : null;
  }

  function observationFromSample(event, sample, due) {
    const sign = event.direction === "buy" ? 1 : -1;
    if (!Number.isFinite(event.entryPrice) || event.entryPrice <= 0 ||
        !Number.isFinite(event.entryVwap) || event.entryVwap <= 0) return null;
    return {
      status: "observed",
      source: "recorded_price_and_vwap",
      observedAt: sample.ts,
      offsetSeconds: Math.round((sample.ts - due) / 1000),
      pricePct: sign * (sample.price / event.entryPrice - 1) * 100,
      vwapPct: sign * (sample.vwap / event.entryVwap - 1) * 100,
      price: sample.price,
      vwap: sample.vwap,
      distanceChangePct: sign *
        (((sample.price - sample.vwap) - (event.entryPrice - event.entryVwap)) / event.entryPrice) * 100
    };
  }

  // Do not mark future checkpoints as lost just because the browser slept or
  // the active market/window changed. A stored sample may still resolve them.
  function updateOutcomes(p) {
    let changed = false;
    for (const e of state.events) {
      for (const m of CHECKPOINTS) {
        const key = checkpointKey(m);
        const due = checkpointDue(e, m);
        const current = e.checkpoints[key];
        if (current?.status === "observed" || current?.status === "price_estimate") continue;
        if (p.now < due) continue;

        const sample = closestSample(e, due);
        if (sample) {
          const result = observationFromSample(e, sample, due);
          if (result) {
            e.checkpoints[key] = result;
            changed = true;
            continue;
          }
        }
        // A missed deadline is only labeled after its own due time, not earlier.
        // Keep it eligible for price-only candle recovery later.
        if (p.now > due + MAX_CHECKPOINT_DELAY_MS && !current) {
          e.checkpoints[key] = {status: "not observed"};
          changed = true;
        }
      }
    }
    return changed;
  }

  // Fetch groups of 1m Coinbase spot candles, never fake a rolling VWAP from
  // OHLCV data. Recovered price is approximate to the minute close only.
  async function recoverHistoricalPrice(now) {
    if (state.recoveryBusy || now < state.nextRecoveryAt) return;
    state.nextRecoveryAt = now + RECOVERY_INTERVAL_MS;
    const groups = new Map();
    for (const e of state.events) {
      if (!Number.isFinite(e.entryPrice) || e.entryPrice <= 0) continue;
      if (!/^[A-Z0-9]+-USD$/.test(e.product)) continue;
      for (const m of CHECKPOINTS) {
        const key = checkpointKey(m);
        if (["observed", "price_estimate"].includes(e.checkpoints[key]?.status)) continue;
        const due = checkpointDue(e, m);
        if (now - due < RECOVERY_DELAY_MS || now - due > RECOVERY_RETENTION_MS) continue;
        const bucket = Math.floor(due / RECOVERY_BUCKET_MS) * RECOVERY_BUCKET_MS;
        const groupId = e.product + "|" + bucket;
        if (!groups.has(groupId)) groups.set(groupId, {product:e.product, bucket, entries:[]});
        groups.get(groupId).entries.push({event:e, minute:m, due});
      }
    }
    const eligibleGroups = [...groups.entries()]
      .filter(([id]) => now - (state.recoveryAttemptedAt[id] || 0) >= RECOVERY_RETRY_MS)
      .sort((a,b) => b[1].bucket - a[1].bucket)
      .slice(0, MAX_RECOVERY_BATCHES);
    if (!eligibleGroups.length) return;

    state.recoveryBusy = true;
    let changed = false;
    try {
      for (const [id, group] of eligibleGroups) {
        state.recoveryAttemptedAt[id] = now;
        const start = new Date(group.bucket).toISOString();
        const end = new Date(group.bucket + RECOVERY_BUCKET_MS).toISOString();
        const url = "https://api.exchange.coinbase.com/products/" +
          encodeURIComponent(group.product) + "/candles?granularity=60&start=" +
          encodeURIComponent(start) + "&end=" + encodeURIComponent(end);
        try {
          const response = await fetch(url, {cache:"no-store"});
          if (!response.ok) throw new Error("HTTP " + response.status);
          const rows = await response.json();
          if (!Array.isArray(rows)) throw new Error("Expected Coinbase candles array");
          const closes = new Map();
          for (const row of rows) {
            if (!Array.isArray(row) || row.length < 5) continue;
            const candleTime = num(row[0]) * 1000;
            const close = num(row[4]);
            if (Number.isFinite(candleTime) && Number.isFinite(close) && close > 0) {
              closes.set(candleTime,close);
            }
          }
          for (const {event,minute,due} of group.entries) {
            const key = checkpointKey(minute);
            if (["observed", "price_estimate"].includes(event.checkpoints[key]?.status)) continue;
            const candleStart = Math.floor(due / 60000) * 60000;
            const close = closes.get(candleStart);
            if (!Number.isFinite(close)) continue;
            const sign = event.direction === "buy" ? 1 : -1;
            event.checkpoints[key] = {
              status: "price_estimate",
              source: "coinbase_1m_candle_close",
              observedAt: candleStart + 60000,
              price: close,
              pricePct: sign * (close / event.entryPrice - 1) * 100,
              vwap: null,
              vwapPct: null
            };
            changed = true;
          }
        } catch (err) {
          // Research recovery is best effort and cannot affect trade signals.
          console.warn("Shadow price-only recovery unavailable for " + group.product, err);
        }
      }
    } finally {
      state.recoveryBusy = false;
      if (changed) {
        saveStorage();
        renderHistory();
        renderSummary();
      }
    }
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
    if (result.status === "price_estimate") {
      const price = dom("div", result.pricePct > 0 ? "positive" : result.pricePct < 0 ? "negative" : "",
        "Price ≈ " + fmtPercent(result.pricePct));
      const note = dom("small", "", "1m close · VWAP unavailable");
      td.title = "Approximate Coinbase 1-minute candle closing price; rolling VWAP was not recorded.";
      td.append(price,note);
      return td;
    }
    if (result.status !== "observed") {
      td.textContent = result.status === "not observed" ? "VWAP not observed" : "Pending";
      td.classList.add("pending");
      return td;
    }
    const p = dom("div", result.pricePct > 0 ? "positive" : result.pricePct < 0 ? "negative" : "",
      "Price " + fmtPercent(result.pricePct));
    const v = dom("div", result.vwapPct > 0 ? "positive" : result.vwapPct < 0 ? "negative" : "",
      "VWAP " + fmtPercent(result.vwapPct));
    if (Number.isFinite(result.offsetSeconds)) {
      td.title = "Recorded trade-price / rolling-VWAP sample " +
        Math.abs(result.offsetSeconds) + "s " + (result.offsetSeconds >= 0 ? "after" : "before") +
        " checkpoint time";
    }
    td.append(p,v);
    return td;
  }


  // A time-window episode is anchored at the FIRST observed qualifying crossing.
  // Later same-direction crossings inside that same window are descriptive events,
  // not new independent tests of the same price response.
  // Group boundaries also require identical market, threshold and filter cohort.
  function groupEpisodes(events) {
    const sorted = [...events].filter(e =>
      e && Number.isFinite(e.time) && e.time > 0 &&
      ["all","large"].includes(e.mode) &&
      ["buy","sell"].includes(e.direction) &&
      Number.isFinite(Number(e.windowMinutes)) && Number(e.windowMinutes) > 0
    ).sort((a,b) => a.time-b.time ||
      (a.mode === "large" ? -1 : 1));

    const groups = [];
    for (const event of sorted) {
      const minutes = Number(event.windowMinutes);
      const threshold = Number(event.threshold);
      const filter = Number(event.minUsd);
      const last = groups.findLast(g =>
        g.product === event.product &&
        g.direction === event.direction &&
        g.windowMinutes === minutes &&
        Object.is(g.threshold,threshold) &&
        Object.is(g.minUsd,filter) &&
        event.time >= g.startTime &&
        event.time < g.startTime + minutes*60000
      );
      if (last) {
        last.events.push(event);
      } else {
        groups.push({
          id: [event.product,minutes,threshold,filter,event.direction,event.time].join("|"),
          product:event.product,direction:event.direction,
          windowMinutes:minutes,threshold,minUsd:filter,
          startTime:event.time,anchor:event,events:[event]
        });
      }
    }
    for (const group of groups) {
      group.firstAll = group.events.find(e=>e.mode==="all") || null;
      group.firstLarge = group.events.find(e=>e.mode==="large") || null;
      group.kind = group.firstAll && group.firstLarge ? "both" :
        group.firstLarge ? "large_only" : "all_only";
      group.firstMode = group.anchor.mode;
      group.secondModeDelaySeconds = group.kind==="both" ?
        Math.round(Math.abs(group.firstAll.time-group.firstLarge.time)/1000) : null;
    }
    return groups.reverse(); // latest episode first
  }

  function fmtEtStamp(value) {
    return new Date(value).toLocaleString("en-US",{
      timeZone:"America/New_York",
      month:"short",day:"numeric",hour:"numeric",minute:"2-digit"
    }) + " ET";
  }

  function episodeKindLabel(kind) {
    return kind==="both" ? "Both ratios" :
      kind==="large_only" ? "Filtered only" : "All trades only";
  }

  function episodeByEvent(episodes) {
    const result = new Map();
    for(const group of episodes) {
      for(const event of group.events) result.set(event.id,group);
    }
    return result;
  }

  function renderRawHistory() {
    if (!el.rawEvents) return;
    el.rawEvents.replaceChildren();
    if (el.rawCount) el.rawCount.textContent =
      "Raw crossing log (" + state.events.length + ")" +
      (state.events.length > RAW_VISIBLE_LIMIT ?
       " · latest " + RAW_VISIBLE_LIMIT + " shown; CSV includes all" :
       " · original entries preserved");

    if (!state.events.length) {
      const tr=dom("tr");
      const td=dom("td","shadowEmpty","No raw threshold crossings recorded yet.");
      td.colSpan=6;
      tr.appendChild(td);
      el.rawEvents.appendChild(tr);
      return;
    }
    for (const e of state.events.slice(0,RAW_VISIBLE_LIMIT)) {
      const tr=dom("tr");
      const tdTime=dom("td","shadowTime",fmtEtStamp(e.time));
      tdTime.appendChild(dom("small","",e.product+" · "+e.windowMinutes+"m"));
      const tdMode=dom("td",e.direction==="buy"?"shadowBuy":"shadowSell",
        (e.mode==="large"?"Filtered":"All trades"));
      tdMode.appendChild(dom("small","",e.direction.toUpperCase()+
        (e.mode==="large"?" · "+fmtMoney(e.minUsd)+"/execution":" · all sizes")));
      tr.append(tdTime,tdMode,dom("td","shadowNum",fmtRatio(e.ratio)),
        ...CHECKPOINTS.map(m=>resultCell(e.checkpoints[checkpointKey(m)])));
      el.rawEvents.appendChild(tr);
    }
  }

  function renderHistory() {
    // Rendering 120 x 6 DOM cells every second would slow the live dashboard.
    // Rebuild only when an event or one of its outcome checkpoints changes.
    const renderKey = state.events.map(e =>
      e.id + ":" + CHECKPOINTS.map(m => {
        const c = e.checkpoints[checkpointKey(m)];
        return c ? c.status + ":" + (Number.isFinite(c.pricePct)?c.pricePct:"") +
          ":" + (Number.isFinite(c.vwapPct)?c.vwapPct:"") : "pending";
      }).join(",")
    ).join("|");
    if (renderKey === state.lastHistoryRenderKey) return;
    state.lastHistoryRenderKey = renderKey;
    const episodes=groupEpisodes(state.events);
    el.events.replaceChildren();
    el.count.textContent = episodes.length + " time-window episodes · "+
      state.events.length + " raw crossings";
    if (!episodes.length) {
      const tr=dom("tr");
      const td=dom("td","shadowEmpty",
        "No threshold-crossing episodes yet. Keep a complete live window open to collect evidence.");
      td.colSpan=6;
      tr.appendChild(td);
      el.events.appendChild(tr);
      renderRawHistory();
      return;
    }
    for (const episode of episodes.slice(0,20)) {
      const first=episode.anchor;
      const tr=dom("tr");
      const tdTime=dom("td","shadowTime",fmtEtStamp(episode.startTime));
      tdTime.appendChild(dom("small","",episode.product+" · "+episode.windowMinutes+"m"));
      const tdDetection=dom("td",episode.direction==="buy"?"shadowBuy":"shadowSell",
        episodeKindLabel(episode.kind));
      const firstLabel=episode.firstMode==="large"?"filtered":"all trades";
      const paired=episode.kind==="both"?
        (" · second crossed "+episode.secondModeDelaySeconds+"s later"):"";
      tdDetection.appendChild(dom("small","",episode.direction.toUpperCase()+
        " · first: "+firstLabel+paired));
      tdDetection.appendChild(dom("small","",
        episode.events.length+" recorded crossing"+
        (episode.events.length===1?"":"s")+
        " · filter "+fmtMoney(episode.minUsd)));
      const ratio=dom("td","shadowNum",fmtRatio(first.ratio));
      ratio.appendChild(dom("small","","first crossing"));
      tr.append(tdTime,tdDetection,ratio,
        ...CHECKPOINTS.map(m=>resultCell(first.checkpoints[checkpointKey(m)])));
      el.events.appendChild(tr);
    }
    renderRawHistory();
  }

  function renderSummary() {
    const episodes=groupEpisodes(state.events);
    const both=episodes.filter(e=>e.kind==="both").length;
    const large=episodes.filter(e=>e.kind==="large_only").length;
    const all=episodes.filter(e=>e.kind==="all_only").length;
    const full=episodes.filter(e=>e.anchor.checkpoints["15"]?.status==="observed");
    const price=episodes.filter(e=>["observed","price_estimate"].includes(
      e.anchor.checkpoints["15"]?.status));
    const follow=price.filter(e=>e.anchor.checkpoints["15"].pricePct>0).length;
    const pending=episodes.filter(e=>!e.anchor.checkpoints["15"]).length;
    const priceNote=price.length ?
      follow+"/"+price.length+" moved with aggression at 15m (includes 1m price estimates)" :
      "No measured 15m price responses yet";
    el.summary.textContent =
      episodes.length+" time-window episodes from "+state.events.length+
      " crossings · Both "+both+" · Filtered only "+large+" · All only "+all+
      "\n15m: "+priceNote+" · "+full.length+" exact price + VWAP outcomes"+
      (pending ? " · "+pending+" pending" : "")+
      "\nThe first crossing anchors each episode; later crossings are not counted again. This does not establish independent samples or a trading edge.";
  }

  function render(p, filtered, full, fresh) {
    const baseSymbol = (p.product || "").split("-")[0] || "base";
    const allRatio = p.ratio;
    const baseSideVol = allRatio >= 0 ? p.stats.buyVol : p.stats.sellVol;
    const filteredSideVol = filtered.ratio >= 0 ? filtered.buy : filtered.sell;
    const filteredReady = filtered.eligible >= MIN_FILTERED_EXECUTIONS && filtered.buy > 0 && filtered.sell > 0;

    el.title.textContent = "Does aggression beyond ±" + p.threshold.toFixed(2) + " precede a VWAP move?";
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
    const episodes = groupEpisodes(state.events);
    const eventToEpisode = episodeByEvent(episodes);
    const cols = [
      "time_utc","market","source","direction","window_minutes","min_execution_usd",
      "threshold","ratio","selected_base_volume","eligible_executions","entry_price","entry_vwap",
      "technical_buy_votes","technical_sell_votes","swing_bias","macro_label",
      "price_5m_pct","vwap_5m_pct","status_5m",
      "price_15m_pct","vwap_15m_pct","status_15m",
      "price_30m_pct","vwap_30m_pct","status_30m",
      "episode_id","episode_detection","episode_first_crossing","episode_crossings"
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
        row.push(x && ["observed","price_estimate"].includes(x.status) ? x.pricePct : "");
        row.push(x && x.status === "observed" ? x.vwapPct : "");
        row.push(x ? x.status : "pending");
      }
      const ep = eventToEpisode.get(e.id);
      row.push(ep?.id || "");
      row.push(ep ? episodeKindLabel(ep.kind) : "");
      row.push(ep && ep.anchor.id === e.id ? "yes" : "no");
      row.push(ep?.events.length ?? "");
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

    // Every valid live observation contributes a timestamped sample.
    // Preserve it across reloads so missed browser frames do not erase outcomes.
    const sampleAdded = recordSample(p);
    let recorded = false;
    if (usable) recorded = updateCrossings(p, filtered);
    const outcomesChanged = updateOutcomes(p);
    if ((sampleAdded && Date.now() - state.lastSaveAt >= SAVE_INTERVAL_MS) ||
        (outcomesChanged || recorded)) saveStorage();

    // Nonblocking, rate-limited research-only historical price fallback.
    // This never claims to reconstruct the original rolling VWAP.
    recoverHistoricalPrice(p.now).catch(err =>
      console.warn("Optional shadow historical recovery failed", err));

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
    state.samples = [];
    state.observedEligibility = Object.create(null);
    state.currentScope = "";
    saveStorage();
    renderHistory();
    renderSummary();
  });

  // Flush the last few seconds of samples before a refresh/tab suspension.
  if (typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", saveStorage);
  }
  if (typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) saveStorage();
    });
  }

  readStorage();
  el.minUsd.value = String(state.filterUsd);
  renderHistory();
  renderSummary();
  window.TradesCounterShadow = Object.freeze({ observe });
})();
