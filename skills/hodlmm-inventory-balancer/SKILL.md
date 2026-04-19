---
name: hodlmm-inventory-balancer
description: "Monitors token X/Y ratio drift in HODLMM positions and executes corrective Bitflow swaps to restore target inventory balance autonomously."
metadata:
  author: "narrow-socket"
  author-agent: "Narrow Socket"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, hodlmm, bitflow, rebalance"
---

## What it does

Reads the agent's HODLMM liquidity position across all bins, calculates the current token X/Y inventory ratio, and — when drift exceeds a configurable threshold — executes a corrective swap on Bitflow to restore the target ratio. Runs on-demand or in autonomous loop mode.

## Why agents need it

In a DLMM like HODLMM, price moves change which bins are active. Bins below the current price hold only token Y; bins above hold only token X. As price drifts, so does the agent's effective inventory ratio. An unbalanced inventory earns fewer fees per unit of capital deployed. This skill keeps the agent's capital optimally positioned without manual intervention.

## Safety notes

- All on-chain writes require `--confirm` flag
- Minimum STX gas reserve enforced (≥ 1 STX) before execution
- Maximum swap amount capped at `--max-swap` (default: 10% of imbalanced token)
- Price impact gate: rejects swaps with > 1.5% slippage
- 4-hour cooldown between executions per pool (prevents thrashing)
- Mainnet-only: rejects if wallet is on testnet

## Commands

```bash
# Check environment and API connectivity
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts doctor

# Show current ratio, target ratio, drift, and recommended action
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts status --wallet <bc1q...> --pool <pool-id>

# Execute corrective swap (dry-run without --confirm)
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts run \
  --wallet <bc1q...> \
  --pool <pool-id> \
  --password <wallet-password> \
  --confirm
```

## Output contract

**Success:**
```json
{
  "result": "balanced|rebalanced|skipped",
  "details": {
    "pool": "string",
    "tokenX": "string",
    "tokenY": "string",
    "currentRatio": 0.0,
    "targetRatio": 0.5,
    "driftPct": 0.0,
    "action": "swap_x_for_y|swap_y_for_x|none",
    "swapAmountMicro": 0,
    "txid": "string|null",
    "cooldownRemaining": 0
  }
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints

- Requires pool ID from `bun run ... status --wallet <addr>` to discover active positions
- Swap execution requires STX for gas fees
- HODLMM position must have non-zero liquidity in at least one bin
