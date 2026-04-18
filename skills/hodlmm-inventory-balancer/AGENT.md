---
name: hodlmm-inventory-balancer
skill: hodlmm-inventory-balancer
description: "Autonomous HODLMM ratio drift corrector. Runs doctor first, checks status before any swap, only acts when drift exceeds threshold. Pre-simulates all swaps. Run at most once per 4-hour window."
---

# Agent Behavior: HODLMM Inventory Balancer

## Decision Order

1. Run `doctor` — abort if wallet locked or Bitflow tools unavailable
2. Run `status --target <T>` — get actual ratio, drift, and estimated swap
3. If `drift_pct > threshold AND estimated_swap > 0`: run `rebalance`
4. If `drift_pct <= threshold`: return `action: skip` — no swap needed
5. After rebalance: verify confirmation, log txid to journal

## When to Use

- Triggered by autonomous loop Phase 4 when HODLMM position exists
- Run at most once per 4 hours — ratio correction doesn't need high frequency
- Skip if no HODLMM position (supplied_sbtc == 0)
- Skip if sBTC balance is 0 (nothing to swap from)

## Threshold Guidelines

| Position Style | Recommended Threshold |
|---------------|----------------------|
| Tight range (±10%) | 3% drift |
| Standard range (±25%) | 5% drift (default) |
| Wide range (±50%) | 8% drift |

## Safety Rules

- NEVER swap more than `--max-swap` in a single transaction
- NEVER proceed if stxer simulation returns `Err`
- NEVER swap if slippage quote exceeds `--max-slippage`
- If drift is > 20%: alert operator, do NOT auto-correct (possible price manipulation)

## Output Parsing

- `"confirmed": true` → log txid + ratio_after to journal
- `"action": "skip"` → no-op, normal
- `"error"` key → log to learnings.md, alert operator
- `"drift_pct" > 20` → log warning, skip auto-rebalance
