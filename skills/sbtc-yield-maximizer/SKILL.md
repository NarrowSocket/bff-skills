---
name: sbtc-yield-maximizer
description: "Routes idle sBTC to the highest-yielding protocol (Zest lending vs HODLMM LP) based on live APY comparison. Maintains a configurable liquid reserve and pre-simulates all writes before broadcasting. Safe for autonomous agent use on mainnet."
version: "1.0.0"
author: "NarrowSocket"
metadata:
  tags: "defi, sbtc, zest, hodlmm, yield, write"
  requires: "mcp-aibtc"
  user-invocable: "false"
  entry: "sbtc-yield-maximizer/sbtc-yield-maximizer.ts"
  networks: "mainnet"
  write: "true"
---

# sBTC Yield Maximizer

Routes idle sBTC capital to the highest-yielding Stacks DeFi protocol on each run.

## Why agents need it

Agents accumulate sBTC from fees and rewards but leave it idle in their wallet. Both Zest Protocol (lending) and HODLMM (LP fees) offer yield, but each performs differently depending on market conditions. Manually comparing APYs and routing capital every few hours is impossible for an autonomous agent without a dedicated skill. This skill fetches live yields, computes the optimal allocation, and executes the routing — all with simulation guards and reserve protection.

## Commands

| Command | Action |
|---------|--------|
| `doctor` | Check wallet unlock, sBTC balance, MCP tools, stxer reachability |
| `status [--reserve <sats>]` | Fetch live APYs, compute excess above reserve, recommend action (no writes) |
| `run [--reserve <sats>] [--max-supply <sats>] [--dry-run]` | Route excess sBTC to best-yield protocol |

## Safety notes

- **Reserve protection:** Never touches the liquid reserve (`--reserve`, default 200,000 sats)
- **APY delta threshold:** Only routes when APY difference >= 0.5% — prevents churn from minor fluctuations
- **Pre-simulate all writes:** Every contract call goes through stxer simulation; aborts on `Err`
- **Max supply cap:** Single allocation capped at `--max-supply` (default 5,000,000 sats)
- **HODLMM path:** Swaps half sBTC to STX via ALEX before LP deposit; pre-simulates the swap
- **Confirmation loop:** Polls `get_transaction_status` up to 3× post-broadcast

## Output contract

All commands output a single JSON object to stdout:

```json
{
  "action": "supply_zest | supply_hodlmm | hold | skip | dry_run",
  "amount_sats": 1500000,
  "reason": "Zest APY 8.2% > HODLMM yield 4.1%",
  "txid": "0xabc123...",
  "confirmed": true,
  "zest_apy": 8.2,
  "hodlmm_apy": 4.1
}
```

Status output:
```json
{
  "sbtc_balance_sats": 1700000,
  "reserve_sats": 200000,
  "excess_sats": 1500000,
  "zest_apy_pct": 8.2,
  "hodlmm_apy_pct": 4.1,
  "best_protocol": "zest",
  "apy_delta_pct": 4.1,
  "recommended_action": "supply_zest",
  "actionable": true
}
```

Error responses:
```json
{ "error": "descriptive message" }
```

Exit code 0 on success or skip, exit code 1 on error or simulation failure.

## Usage

```bash
npx ts-node sbtc-yield-maximizer.ts doctor
npx ts-node sbtc-yield-maximizer.ts status --reserve 200000
npx ts-node sbtc-yield-maximizer.ts run --reserve 200000 --max-supply 5000000
npx ts-node sbtc-yield-maximizer.ts run --dry-run
```
