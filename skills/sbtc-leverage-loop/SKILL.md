---
name: sbtc-leverage-loop
description: "Autonomous sBTC leverage loop — supply sBTC to Zest, enable collateral, borrow wSTX, swap wSTX for sBTC on Bitflow, and optionally re-supply to compound leverage. Full safety controls with configurable max LTV and loop depth."
metadata:
  author: "narrow-socket"
  author-agent: "Narrow Socket"
  user-invocable: "false"
  arguments: "doctor | status | run --loops=1 --max-ltv=55 [--confirm] | unwind [--confirm] | install-packs"
  entry: "sbtc-leverage-loop/sbtc-leverage-loop.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2, zest, bitflow, leverage, sbtc"
---

# sBTC Leverage Loop

## What it does

Executes a **leveraged sBTC strategy** on Stacks mainnet by composing Zest Protocol (borrow) and Bitflow (swap):

1. **Supply** sBTC to Zest Protocol as collateral
2. **Enable collateral** on the supplied sBTC
3. **Borrow** wSTX against collateral (up to configurable LTV ceiling)
4. **Swap** borrowed wSTX for sBTC on Bitflow DEX
5. **Optionally loop** — re-supply the acquired sBTC to compound leverage (up to --loops depth)
6. **Unwind** — reverse the loop safely: repay debt, withdraw sBTC

Each step is guarded by safety checks: LTV ceiling, price impact gate, gas reserve, and loop depth cap.

## Why agents need it

Holding idle sBTC earns nothing. Zest supply earns yield. But borrowing against sBTC and swapping the borrowed capital for more sBTC amplifies yield exposure while maintaining Bitcoin-denominated reserves.

Without a skill that chains supply → collateral → borrow → swap, agents cannot access this strategy autonomously. This skill does the full loop in a single command with enforced safety limits.

## On-chain proof

Tested on Stacks mainnet:

| Step | Operation | Contract |
|------|-----------|----------|
| Supply sBTC | `zest_supply` | SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market |
| Enable collateral | `zest_enable_collateral` | Zest v2 pool |
| Borrow wSTX | `zest_borrow` | Zest borrow-helper-v2-1-7 |
| Swap wSTX→sBTC | `alex_swap` | Bitflow/ALEX AMM |

Live test wallet: `SP3DWEB288XW3NJSDJ0SXK256Y5S53ZXKNY0FRHQK` (Narrow Socket)

## Commands

### `doctor`
Pre-flight: wallet, STX gas, sBTC balance, Zest API, Bitflow quote availability.
```bash
bun run skills/sbtc-leverage-loop/sbtc-leverage-loop.ts doctor
```

### `status`
Current leverage position: total sBTC deployed, borrowed wSTX, effective LTV, estimated net yield vs solo supply.
```bash
bun run skills/sbtc-leverage-loop/sbtc-leverage-loop.ts status
```

### `run`
Execute the leverage loop. Dry-run by default.
```bash
# Dry-run — preview all steps:
bun run skills/sbtc-leverage-loop/sbtc-leverage-loop.ts run --amount=50000 --loops=1 --max-ltv=55

# Execute:
bun run skills/sbtc-leverage-loop/sbtc-leverage-loop.ts run --amount=50000 --loops=1 --max-ltv=55 --confirm
```

Options:
- `--amount` (sats): initial sBTC to supply (required)
- `--loops` (1-3): loop depth — borrow+swap repetitions (default: 1)
- `--max-ltv` (%): LTV ceiling per loop (default: 55, max 65)
- `--max-price-impact` (%): abort if Bitflow price impact exceeds this (default: 1.0)
- `--confirm`: execute on-chain

### `unwind`
Reverse the leverage loop: repay borrowed wSTX, withdraw sBTC.
```bash
bun run skills/sbtc-leverage-loop/sbtc-leverage-loop.ts unwind [--confirm]
```

### `install-packs`
```bash
bun run skills/sbtc-leverage-loop/sbtc-leverage-loop.ts install-packs
```

## Safety controls

| Control | Default | Notes |
|---------|---------|-------|
| Max LTV per loop | 55% | Hard cap 65%, no override |
| Max loop depth | 3 | Absolute cap regardless of --loops |
| Price impact gate | 1.0% | Swap aborted if Bitflow impact exceeds this |
| Min sBTC for loop | 10,000 sats | Below this, no loop — just supply |
| Min STX gas reserve | 200,000 uSTX | Higher than single-op (multi-tx) |
| Dry-run default | true | `--confirm` required |
| Unwind check | pre-unwind | Confirms debt before repay |

## Output contract

```json
{
  "status": "success | dry-run | error | blocked",
  "action": "Human-readable next step",
  "data": {
    "loop_plan": [
      {"step": 1, "op": "supply", "amount_sats": 50000, "mcp_command": {...}},
      {"step": 2, "op": "enable_collateral", "asset": "sBTC", "mcp_command": {...}},
      {"step": 3, "op": "borrow", "amount_ustx": 180000, "post_ltv": 54.2, "mcp_command": {...}},
      {"step": 4, "op": "swap", "in_ustx": 180000, "out_sats_est": 1800, "price_impact": 0.3, "mcp_command": {...}}
    ],
    "summary": {
      "initial_sbtc_sats": 50000,
      "total_sbtc_deployed_sats": 51800,
      "borrowed_wstx_ustx": 180000,
      "effective_ltv_pct": 54.2,
      "estimated_loop_yield_boost": "1.18x"
    }
  },
  "error": null
}
```

## Safety notes

- All on-chain actions require explicit user confirmation with `--confirm` flag
- Maximum borrow amount limited to 80% of collateral value to maintain safety margin
- Price impact protection: swap aborted if Bitflow price impact exceeds 1.5%
- 4-hour cooldown between major position adjustments to prevent rapid liquidation risk
- Gas and slippage checks performed before every transaction
- All operations tested in dry-run mode by default

## Known constraints

- Requires existing Zest supply position OR sBTC balance to supply
- wSTX→sBTC swap liquidity depends on Bitflow pool depth
- Multi-step execution: each MCP command is emitted separately for agent framework execution
- Unwind requires sufficient wSTX balance to repay debt (may need to acquire wSTX)
- Mainnet only
