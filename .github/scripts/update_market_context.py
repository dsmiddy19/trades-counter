#!/usr/bin/env python3
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

BASE_URL = "https://openapi.sosovalue.com/openapi/v1/etfs/summary-history"
OUT = Path("market-context.json")
SOURCE_URL = "https://sosovalue.com/developer/data/etf"

def finite_number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None

def fetch_summary(symbol, api_key):
    response = requests.get(
        BASE_URL,
        params={"symbol": symbol, "country_code": "US", "limit": 15},
        headers={"x-soso-api-key": api_key, "User-Agent": "trades-counter-github-action/1.0"},
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict) or payload.get("code") != 0:
        raise RuntimeError(
            f"SoSoValue {symbol} response error: "
            f"{payload.get('message', 'unknown error') if isinstance(payload, dict) else 'invalid JSON envelope'}"
        )
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise RuntimeError(f"SoSoValue {symbol} data is not a list")

    settled = []
    for row in rows:
        if not isinstance(row, dict) or not row.get("date"):
            continue
        flow = finite_number(row.get("total_net_inflow"))
        if flow is None:
            continue
        settled.append({
            "date": str(row["date"]),
            "net_flow": flow,
            "value_traded": finite_number(row.get("total_value_traded")),
            "net_assets": finite_number(row.get("total_net_assets")),
            "cum_net_inflow": finite_number(row.get("cum_net_inflow")),
        })

    settled.sort(key=lambda row: row["date"])
    if len(settled) < 5:
        raise RuntimeError(f"Only {len(settled)} settled {symbol} ETF rows returned")
    return settled

def row_map(rows):
    return {row["date"]: row for row in rows}

def rounded(value):
    return None if value is None else round(float(value), 2)

def main():
    api_key = os.environ.get("SOSO_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("SOSO_API_KEY repository secret is missing")

    btc_rows = fetch_summary("BTC", api_key)
    eth_rows = fetch_summary("ETH", api_key)
    btc_by_date = row_map(btc_rows)
    eth_by_date = row_map(eth_rows)

    common_dates = sorted(set(btc_by_date) & set(eth_by_date))
    if len(common_dates) < 5:
        raise RuntimeError("Fewer than five common settled BTC/ETH ETF trading days")

    latest_date = common_dates[-1]
    recent_dates = common_dates[-5:]
    btc_latest = btc_by_date[latest_date]
    eth_latest = eth_by_date[latest_date]

    btc_5d = sum(btc_by_date[d]["net_flow"] for d in recent_dates)
    eth_5d = sum(eth_by_date[d]["net_flow"] for d in recent_dates)

    def compact_rows(mapping):
        return [{"date": d, "net_flow": rounded(mapping[d]["net_flow"])} for d in recent_dates]

    total_value_traded = sum(
        value for value in [btc_latest["value_traded"], eth_latest["value_traded"]] if value is not None
    )
    total_net_assets = sum(
        value for value in [btc_latest["net_assets"], eth_latest["net_assets"]] if value is not None
    )

    etf = {
        "date": latest_date,
        "btc_1d": rounded(btc_latest["net_flow"]),
        "eth_1d": rounded(eth_latest["net_flow"]),
        "btc_5d": rounded(btc_5d),
        "eth_5d": rounded(eth_5d),
        "btc_value_traded_1d": rounded(btc_latest["value_traded"]),
        "eth_value_traded_1d": rounded(eth_latest["value_traded"]),
        "total_value_traded_1d": rounded(total_value_traded),
        "btc_net_assets": rounded(btc_latest["net_assets"]),
        "eth_net_assets": rounded(eth_latest["net_assets"]),
        "total_net_assets": rounded(total_net_assets),
        "btc_cum_net_inflow": rounded(btc_latest["cum_net_inflow"]),
        "eth_cum_net_inflow": rounded(eth_latest["cum_net_inflow"]),
        "btc_rows": compact_rows(btc_by_date),
        "eth_rows": compact_rows(eth_by_date),
        "source_url": SOURCE_URL,
    }

    existing = None
    if OUT.exists():
        try:
            existing = json.loads(OUT.read_text())
        except Exception:
            existing = None

    if isinstance(existing, dict) and existing.get("source") == "SoSoValue API" and existing.get("etf") == etf:
        print(f"ETF data unchanged through {latest_date}; leaving market-context.json untouched")
        return

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "SoSoValue API",
        "source_url": SOURCE_URL,
        "etf": etf,
    }
    OUT.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Updated ETF context through {latest_date}")
    print(f"BTC 1d: {etf['btc_1d']}; ETH 1d: {etf['eth_1d']}; common 5d: {recent_dates[0]} -> {recent_dates[-1]}")

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ETF update failed: {exc}", file=sys.stderr)
        raise
