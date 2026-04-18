---
name: hodlmm-inventory-balancer
description: "Detects token ratio drift in HODLMM concentrated liquidity positions and corrects it via Bitflow swaps. Configurable drift threshold, target ratio, and slippage tolerance. Pre-simulates all swaps before broadcasting. Safe for autonomous agent use on mainnet."
version: "1.0.0"
author: "NarrowSocket"
metadata:
  tags: "defi, hodlmm, bitflow, sbtc, rebalance, swap, write"
  requires: "mcp-aibtc"
  user-invocable: "false"
  entry: "hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts"
  networks: "mainnet"
  write: "true"
---

# HODLMM Inventory Balancer

Monitors HODLMM concentrated liquidity positions for token ratio drift and corrects via Bitflow swaps.

## Why agents need it

HODLMM positions drift as prices move — sBTC appreciates and the pool becomes sBTC-heavy, or STX pumps and the pool skews STX-heavy. Left uncorrected, drift concentrates risk in one asset and reduces fee earnings from the balanced range. Agents need an autonomous corrector that detects when drift exceeds a safe threshold and rebalances without human intervention, while protecting against slippage and market manipulation.

## Commands

| Command | Action |
|---------|--------|
| `doctor` | Check wallet, balances, ALEX pool availability, stxer reachability |
| `status [--target <pct>] [--threshold <pct>]` | Show current ratio, drift %, and recommended action (no writes) |
| `rebalance [--target <pct>] [--threshold <pct>] [--max-swap <sats>] [--max-slippage <pct>] [--dry-run]` | Execute corrective swap if drift exceeds threshold |

## Safety notes

- **Drift threshold gate:** Only swaps when drift exceeds `--threshold` (default 5%) — prevents thrashing on minor fluctuations
- **Manipulation guard:** If drift > 20%, aborts with error and requires operator review (possible price anomaly)
- **Max swap cap:** Single swap capped at `--max-swap` (default 500,000 sats) to prevent overshooting
- **Slippage protection:** Rejects swap quotes with slippage > `--max-slippage` (default 1%)
- **Pre-simulate:** Every swap runs through stxer simulation; aborts on `Err`
- **Confirmation loop:** Polls `get_transaction_status` up to 60s post-broadcast
- **Idempotent:** Re-running on a balanced position returns `action: skip`

## Output contract

All commands output a single JSON object to stdout:

```json
{
  "action": "swap_stx_to_sbtc | swap_sbtc_to_stx | skip | hold | dry_run",
  "amount": 250000,
  "drift_pct": 7.7,
  "actual_ratio_pct": 42.3,
  "target_ratio_pct": 50,
  "txid": "0xabc123...",
  "confirmed": true,
  "ratio_after_pct": 49.8,
  "position_after": {
    "sbtc_sats": 600000,
    "stx_ustx": 25000000,
    "actual_ratio_pct": 49.8
  }
}
```

Error responses:
```json
{ "error": "descriptive message", "drift_pct": 7.7, "position": {...} }
```

Exit code 0 on success or skip, exit code 1 on error or simulation failure.

## Usage

```bash
npx ts-node hodlmm-inventory-balancer.ts doctor
npx ts-node hodlmm-inventory-balancer.ts status --target 50
npx ts-node hodlmm-inventory-balancer.ts rebalance --target 50 --threshold 5
npx ts-node hodlmm-inventory-balancer.ts rebalance --target 60 --threshold 3 --dry-run
```
