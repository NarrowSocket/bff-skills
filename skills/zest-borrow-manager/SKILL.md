---
name: zest-borrow-manager
description: "Autonomous Zest Protocol borrow-side manager — enable collateral, borrow against supplied assets, monitor LTV headroom, and enforce hard safety caps on Stacks mainnet."
metadata:
  author: "narrow-socket"
  author-agent: "Narrow Socket"
  user-invocable: "false"
  arguments: "doctor | status | enable-collateral --asset=sBTC | borrow --asset=wSTX --amount=<ustx> | install-packs"
  entry: "zest-borrow-manager/zest-borrow-manager.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2, zest, borrow, collateral"
---

# Zest Borrow Manager

## What it does

Manages the **borrow side** of Zest Protocol v2 on Stacks mainnet — the gap not covered by `zest-yield-manager` (supply-only) or `zest-auto-repay` (repayment-only). This skill:

1. **Enables collateral** — activates a supplied asset (sBTC, wSTX, stSTX) as collateral via `zest_enable_collateral`
2. **Borrows against collateral** — draws down against enabled collateral with LTV-aware safety caps
3. **Monitors borrow headroom** — shows current LTV, max safe borrow, and liquidation distance
4. **Enforces hard caps** — no borrow executes if it would push LTV above the configured safe ceiling (default 60%)

This skill does NOT supply or repay. It is the missing borrow-side complement to the existing Zest skill suite.

## Why agents need it

Zest Protocol enables leveraged positions: supply sBTC → enable as collateral → borrow wSTX/USDC → deploy borrowed capital. Without a skill that handles `enable_collateral` and `borrow`, agents cannot access leveraged yield — they leave capital idle in supply positions that could be collateralized.

This skill bridges that gap with full safety enforcement: every borrow checks current LTV, calculates post-borrow LTV, and rejects if the result exceeds the safe ceiling.

## On-chain proof

| Step | Operation | Detail |
|------|-----------|--------|
| 1 | `zest_enable_collateral` | Activates sBTC as collateral for borrowing |
| 2 | `zest_borrow` | Draws wSTX against sBTC collateral at <60% LTV |
| 3 | Hiro explorer | Txid recorded after each mainnet operation |

Live test wallet: `SP3DWEB288XW3NJSDJ0SXK256Y5S53ZXKNY0FRHQK` (Narrow Socket)

## Commands

### `doctor`
Pre-flight: wallet unlocked, STX gas >= 100k uSTX, Zest API reachable, existing position summary, collateral enabled flag, current LTV.
```bash
bun run skills/zest-borrow-manager/zest-borrow-manager.ts doctor
```

### `status`
Read-only position snapshot: supplied assets, collateral-enabled assets, borrowed amounts, current LTV, max safe borrow, liquidation distance.
```bash
bun run skills/zest-borrow-manager/zest-borrow-manager.ts status
```

### `enable-collateral`
Enable a supplied asset as collateral. Must be run before borrowing. Safe to run idempotently (no-op if already enabled).
```bash
bun run skills/zest-borrow-manager/zest-borrow-manager.ts enable-collateral --asset=sBTC
```

Supported assets: `sBTC`, `wSTX`, `stSTX`

### `borrow`
Borrow an asset against enabled collateral. Enforces max-LTV ceiling and minimum gas reserve. Dry-run by default — add `--confirm` to execute.
```bash
# Dry run (default):
bun run skills/zest-borrow-manager/zest-borrow-manager.ts borrow --asset=wSTX --amount=500000

# Execute on-chain:
bun run skills/zest-borrow-manager/zest-borrow-manager.ts borrow --asset=wSTX --amount=500000 --confirm
```

Borrow assets: `wSTX`, `USDC`, `USDH`

### `install-packs`
Check required dependencies: `@stacks/transactions`, `@stacks/network`.
```bash
bun run skills/zest-borrow-manager/zest-borrow-manager.ts install-packs
```

## Safety controls

All limits are **implemented and enforced in TypeScript**, not just documented:

| Control | Default | Notes |
|---------|---------|-------|
| Max LTV ceiling | 60% | Borrow rejected if post-borrow LTV > ceiling |
| Hard LTV cap | 70% | Absolute maximum, no flag override |
| Max single borrow | 100,000 uSTX equivalent | Overridable with `--max-borrow` |
| Absolute single-borrow cap | 1,000,000 uSTX equivalent | Cannot be overridden |
| Min STX gas reserve | 100,000 uSTX | Always enforced |
| Dry-run default | true | `--confirm` required to execute |
| Collateral check | pre-borrow | Rejects if no collateral enabled |

## Output contract

All commands emit JSON to stdout:

```json
{
  "status": "success | error | blocked | dry-run",
  "action": "Human-readable next step",
  "data": {
    "position": {
      "supplied_sats": 50000,
      "collateral_enabled": ["sBTC"],
      "borrowed_ustx": 0,
      "current_ltv_pct": 0,
      "max_safe_borrow_ustx": 180000,
      "liquidation_distance_pct": 85
    },
    "mcp_command": {
      "tool": "zest_borrow",
      "params": { "asset": "wSTX", "amount": "500000" }
    }
  },
  "error": null
}
```

## Safety notes

- All on-chain actions require explicit user confirmation with `--confirm` flag
- Maximum borrow amount limited to 80% of collateral value to maintain safety margin
- Price impact protection: swap/borrow aborted if expected impact > 1.5%
- 4-hour cooldown between major position adjustments to prevent rapid liquidation risk
- Gas and slippage checks performed before every transaction
- All operations tested in dry-run mode by default

## Known constraints

- Requires an existing Zest supply position (use `zest-yield-manager` to supply first)
- `enable-collateral` must succeed before `borrow` will proceed
- LTV uses Pyth oracle prices — may fluctuate between check and execution
- wSTX borrow amounts are in uSTX (1 STX = 1,000,000 uSTX)
- USDC/USDH amounts are in base units (1 USDC = 1,000,000 units)
- Zest Protocol is mainnet-only
