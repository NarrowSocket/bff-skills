---
name: hodlmm-inventory-balancer
description: "Detects token ratio drift in HODLMM concentrated liquidity positions and corrects it via Bitflow swaps. Configurable drift threshold, target ratio, and slippage tolerance. Pre-simulates all swaps before broadcasting. Safe for autonomous agent use on mainnet."
version: "1.0.0"
author: "Narrow Socket"
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

## What It Does

| Command | Action |
|---------|--------|
| `doctor` | Check wallet, balances, MCP tools, Bitflow pool availability |
| `status` | Fetch current position ratio vs target; compute drift and swap amount |
| `rebalance` | Execute corrective swap if drift exceeds threshold (pre-simulated) |

## How Drift Correction Works

1. Fetch current HODLMM position token balances (sBTC + STX side)
2. Compute actual ratio: `actual_pct = sbtc_value / (sbtc_value + stx_value)`
3. Compare to target ratio (default 50/50)
4. If `|actual_pct - target_pct| > drift_threshold` (default 5%), compute corrective swap amount
5. Pre-simulate swap via stxer — abort on Err
6. Execute via `alex_swap` or `mcp__aibtc__jingswap_*` — verify confirmation

## Safety Guardrails (enforced in code)

- **Drift threshold gate:** Only swaps when drift exceeds `--threshold` (default 5%)
- **Max swap cap:** Single swap capped at `--max-swap` to prevent overshooting
- **Slippage protection:** Rejects quotes with slippage > `--max-slippage` (default 1%)
- **Pre-simulate:** Every swap goes through stxer simulation; aborts on `Err`
- **Confirmation loop:** Polls `get_transaction_status` up to 60s post-broadcast
- **Idempotent:** Re-running on an already-balanced position returns `action: skip`

## Usage

```bash
# Check prerequisites
npx ts-node hodlmm-inventory-balancer.ts doctor

# Check current drift (no writes)
npx ts-node hodlmm-inventory-balancer.ts status --target 50

# Rebalance if drift > 5% from 50/50 target
npx ts-node hodlmm-inventory-balancer.ts rebalance --target 50 --threshold 5

# Dry run (simulate only)
npx ts-node hodlmm-inventory-balancer.ts rebalance --target 50 --dry-run

# Custom target (60% sBTC / 40% STX)
npx ts-node hodlmm-inventory-balancer.ts rebalance --target 60 --threshold 3 --max-swap 100000
```

## Output Format

```json
{
  "action": "swap_stx_to_sbtc",
  "swap_amount_ustx": 5000000,
  "sbtc_received_sats": 100,
  "actual_ratio_pct": 42.3,
  "target_ratio_pct": 50,
  "drift_pct": 7.7,
  "txid": "0xabc123...",
  "confirmed": true,
  "ratio_after_pct": 49.8
}
```
