---
name: zest-position-manager
description: "Unified Zest Protocol position manager: supply sBTC, monitor health factor, borrow STX, repay debt, and withdraw — all with pre-broadcast simulation and health-factor guardrails. Safe for autonomous agent use on mainnet."
version: "1.0.0"
author: "Narrow Socket"
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

## What It Does

| Command | Action |
|---------|--------|
| `doctor` | Check wallet, balances, MCP tools, Zest market availability |
| `status` | Full position snapshot: supplied, borrowed, health factor, available to borrow |
| `supply` | Supply sBTC to Zest lending pool (pre-simulated) |
| `borrow` | Borrow STX against sBTC collateral (health-factor gated) |
| `repay` | Repay outstanding STX debt (partial or full) |
| `withdraw` | Withdraw supplied sBTC (checks borrow capacity first) |

## Safety Guardrails (enforced in code)

- **Health factor floor:** Never borrow if resulting HF < 1.5 (configurable via `--min-hf`)
- **Reserve protection:** `supply` and `withdraw` always leave `--reserve` sats liquid
- **Pre-simulate all writes:** Every contract call goes through stxer simulation; aborts on `Err`
- **Confirmation loop:** Polls `get_transaction_status` for up to 60s post-broadcast
- **No auto-borrow:** `borrow` requires explicit `--amount` — never borrows autonomously
- **Zest tool availability check:** Boot sensor skips entire skill if `zest_supply` MCP tool is absent (< v1.33.1)

## Usage

```bash
# Prerequisites check
npx ts-node zest-position-manager.ts doctor

# Full position snapshot
npx ts-node zest-position-manager.ts status

# Supply 500k sats to Zest (keep 200k reserve)
npx ts-node zest-position-manager.ts supply --amount 500000 --reserve 200000

# Borrow 10 STX (only if health factor stays >= 1.5)
npx ts-node zest-position-manager.ts borrow --amount 10000000 --min-hf 1.5

# Repay 5 STX of debt
npx ts-node zest-position-manager.ts repay --amount 5000000

# Withdraw 200k sats (checks borrow capacity)
npx ts-node zest-position-manager.ts withdraw --amount 200000

# Dry-run any command
npx ts-node zest-position-manager.ts supply --amount 500000 --dry-run
```

## Output Format

All commands output JSON to stdout:

```json
{
  "action": "supply",
  "amount_sats": 500000,
  "txid": "0xabc123...",
  "confirmed": true,
  "health_factor": 2.4,
  "position": {
    "supplied_sats": 700000,
    "borrowed_ustx": 0,
    "available_to_borrow_ustx": 350000
  }
}
```
