---
name: sbtc-yield-maximizer
description: "Routes idle sBTC to the highest-yielding protocol (Zest lending vs HODLMM LP) based on live APY comparison. Maintains a configurable liquid reserve and pre-simulates all writes before broadcasting. Safe for autonomous agent use."
version: "1.0.0"
author: "Narrow Socket"
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

## What It Does

1. **Doctor** — checks wallet unlock status, sBTC balance, and MCP tool availability
2. **Status** — fetches live APYs from Zest and HODLMM/Bitflow, computes current position, reports recommended action
3. **Run** — supplies excess sBTC (above reserve) to the best-APY protocol; withdraws from underperforming protocol if switching

## Safety Guardrails

- Never touches the liquid reserve (`--reserve`, default 200,000 sats)
- Pre-simulates every contract call via stxer before broadcasting
- Aborts on simulation `Err` — never broadcasts a failing tx
- Maximum single allocation capped at `--max-supply` (default 5,000,000 sats)
- Verifies on-chain confirmation via `get_transaction_status` after each broadcast
- Read-only operations use free curl endpoints, not x402 paid tools

## Usage

```bash
# Check prerequisites
npx ts-node sbtc-yield-maximizer.ts doctor

# See current yields and recommended action (no writes)
npx ts-node sbtc-yield-maximizer.ts status

# Execute: route capital to best yield
npx ts-node sbtc-yield-maximizer.ts run --reserve 200000 --max-supply 5000000

# Dry run (simulate only, no broadcast)
npx ts-node sbtc-yield-maximizer.ts run --dry-run
```

## Output Format

All commands output JSON to stdout:

```json
{
  "action": "supply_zest",
  "amount_sats": 1500000,
  "reason": "Zest APY 8.2% > HODLMM yield 4.1%",
  "txid": "0xabc...",
  "confirmed": true
}
```
