---
name: zest-position-manager
description: "Unified Zest Protocol position manager: supply sBTC, monitor health factor, borrow STX, repay debt, and withdraw — all with pre-broadcast simulation and health-factor guardrails. Safe for autonomous agent use on mainnet."
version: "1.0.0"
author: "NarrowSocket"
metadata:
  tags: "defi, zest, sbtc, lending, borrow, repay, write"
  requires: "mcp-aibtc"
  user-invocable: "false"
  entry: "zest-position-manager/zest-position-manager.ts"
  networks: "mainnet"
  write: "true"
---

# Zest Full Position Manager

Single skill that manages an agent's complete Zest Protocol position lifecycle.

## Why agents need it

Autonomous agents accumulate sBTC but have no native way to put it to work. Zest Protocol offers yield on supplied sBTC, but managing supply/borrow/repay/withdraw across multiple MCP calls is error-prone — especially keeping health factor above liquidation thresholds. This skill wraps the full lifecycle in one safe, simulation-gated interface so agents can earn yield without risking liquidation.

## Commands

| Command | Action |
|---------|--------|
| `doctor` | Check wallet unlock status, sBTC balance, MCP tool availability, stxer reachability |
| `status` | Full position snapshot: supplied sats, borrowed uSTX, health factor, available to borrow |
| `supply --amount <sats> [--reserve <sats>] [--dry-run]` | Supply sBTC to Zest lending pool |
| `borrow --amount <ustx> [--min-hf <hf>] [--dry-run]` | Borrow STX against sBTC collateral |
| `repay --amount <ustx|all> [--dry-run]` | Repay outstanding STX debt |
| `withdraw --amount <sats> [--min-hf <hf>] [--dry-run]` | Withdraw supplied sBTC |

## Safety notes

- **Health factor floor:** Never borrow if resulting HF < 1.5 (configurable via `--min-hf`)
- **Reserve protection:** `supply` and `withdraw` always leave `--reserve` sats liquid (default 200,000 sats)
- **Pre-simulate all writes:** Every contract call goes through stxer simulation; aborts on `Err`
- **Confirmation loop:** Polls `get_transaction_status` for up to 60s post-broadcast
- **No auto-borrow:** `borrow` requires explicit `--amount` — never borrows autonomously without operator instruction
- **Zest tool availability check:** Skips if `zest_supply` MCP tool is absent (requires MCP >= v1.33.1)

## Output contract

All commands output a single JSON object to stdout:

```json
{
  "action": "supply | borrow | repay | withdraw | skip | dry_run",
  "amount_sats": 500000,
  "txid": "0xabc123...",
  "confirmed": true,
  "health_factor": 2.4,
  "position": {
    "supplied_sats": 700000,
    "borrowed_ustx": 0,
    "available_to_borrow_ustx": 350000,
    "zest_lp_balance": "700000"
  }
}
```

Error responses:
```json
{ "error": "descriptive message", "simulation": "...", "position": {...} }
```

Exit code 0 on success or skip, exit code 1 on error or simulation failure.

## Usage

```bash
npx ts-node zest-position-manager.ts doctor
npx ts-node zest-position-manager.ts status
npx ts-node zest-position-manager.ts supply --amount 500000 --reserve 200000
npx ts-node zest-position-manager.ts borrow --amount 10000000 --min-hf 1.5
npx ts-node zest-position-manager.ts repay --amount all
npx ts-node zest-position-manager.ts withdraw --amount 200000 --dry-run
```
