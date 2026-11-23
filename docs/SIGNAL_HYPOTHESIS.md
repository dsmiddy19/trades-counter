# Trades Counter: original signal hypothesis and change safeguards

Last reviewed: 2026-11-23

## Preserve the thesis

This tool began with an observation in TensorCharts: when a 15-minute buy/sell aggression ratio reached roughly 1.65 in the presence of sufficiently large trading activity (described as "1k orders" / a "1k" threshold), a momentum move or VWAP swing often followed.

That is an observed hypothesis, not a proven trading edge. Do not silently replace the ratio/VWAP relationship with a conventional composite technical rating.

## What the current app measures

- Venue: Coinbase Exchange spot executions, e.g., ETH-USD and BTC-USD
- The Coinbase Exchange side field denotes the maker side; the app reverses it to get the aggressor side
- User-selected 5m/15m/30m/60m is a rolling interval, not necessarily an aligned candlestick
- Ratio: aggressive buy BASE-UNIT volume divided by aggressive sell BASE-UNIT volume, or the negative reciprocal
- Minimum: 1,000 aggregate BASE UNITS on the dominant side of that interval, NOT 1,000 separate trades and NOT automatically $1,000 USD
- BUY/SELL logic requires a ratio of at least 1.65, at least 1,000 dominant-side units, complete data, session, macro-clear, plus two of three MACD/RSI/CMF votes (all three during 9:30–10:15 AM ET)
- The external TradingView page supplies NO votes; it is just a link
- BTC/ETH 4h trend and U.S. ETF flows provide context, not hard gates
- The VWAP/std bands use the selected rolling trade interval; TensorCharts also offers a VWAP over a configurable number of chart candles

## Critical open question: what did 1k mean in TensorCharts?

TensorCharts Trades Counter supports a per-execution volume filter. That is DIFFERENT from requiring 1,000 total base units on the dominant side. We must verify the original trade-size filtering and units before declaring the systems equivalent.

Documentation: https://docs.tensorcharts.com/docs/trades_counters/

Confirm the original TensorCharts exchange/market type, 15-minute interval, individual-trade filter and units, activity minimum, and VWAP period/anchor. Do not assume the displayed 1,000 condition reproduces the original setup.

## Recommended test: parallel shadow signals (no production logic change)

Compare, on the SAME Coinbase stream:
1. Current all-trades aggression ratio
2. An individual-trade-size-filtered ratio, such as >= $1,000 USD notional per execution, ONLY once the original unit is confirmed
3. Alternative thresholds/window sizes for research rather than silently changing the original 15m rule

For each FIRST threshold-crossing event, log event time, market, window, ratio, eligible buy/sell totals, trade count, execution-data completeness, time above threshold, VWAP reference, and price/VWAP changes over the next 5m/15m/30m.

Also log whether price continued in the aggression direction or reversed (absorption/exhaustion), technical votes, ATR-normalized favorable/adverse excursions, major events, regime, and approximate trading fees/slippage.

Do not count a hundred consecutive 1-second refreshes of one market move as a hundred independent samples. Validate threshold and voting variants on subsequent out-of-sample periods. Judge results by expectancy after fees/stops, not just how many charts appear to agree.

## Change safeguards

- Preserve the production signal until the shadow signal is evaluated and intentionally selected
- Back up or use a reviewable branch before changing core ratio, side labels, VWAP, or trading gates
- Increment the build stamp for every user-facing HTML release
- Use history.html for the latest five actual index.html build commits
- Use the Prepare Trades Counter rollback workflow to create a reviewed restore PR, not overwrite main silently
- Permanent pre-rollback branch: backup/pre-rollback-system-2026-11-23
- Five exact HTML snapshots are retained in the builds/ directory
- Never place API keys/tokens in public HTML or repository files

## Decision architecture

Keep distinct:
1. Observed imbalance (what the tape says now)
2. Actual price/VWAP response (does price follow through?)
3. Context (momentum, 4h, ETF, news)
4. Trading eligibility (data quality, macro/session, and human risk constraints)

A site BUY/SELL market signal does not establish that stop placement, position sizing, margin or daily trade-count rules are satisfied unless those are separately supplied and verified.
