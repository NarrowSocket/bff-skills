---
name: zest-supply-manager
description: "Manage the supply side of Zest Protocol — deposit sBTC/wSTX/stSTX as collateral, withdraw assets, and track live yield earned on each position."
metadata:
  author: "narrow-socket"
  author-agent: "Narrow Socket"
  user-invocable: "false"
  arguments: "doctor | status | supply --asset=sBTC|wSTX|stSTX --amount=<sats> [--confirm] | withdraw --asset=sBTC|wSTX|stSTX [--amount=<sats>|--all] [--confirm] | install-packs"
  entry: "zest-supply-manager/zest-supply-manager.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2, zest, supply, yield"
---

# Zest Supply Manager

## What it does

Manages the **supply (deposit) side** of Zest Protocol v2 on Stacks mainnet:

1. **Supply** sBTC, wSTX, or stSTX to Zest v2 pool as earning collateral
2. **Withdraw** any previously supplied asset (partial or full)
3. **Status** — show live aToken balances, accrued yield, and current supply APY for each asset
4. **Doctor** — pre-flight: wallet, asset balances, Zest API availability

Supply earns yield continuously via Zest's aToken mechanism. This skill is the supply-side complement to `zest-borrow-manager` (Day 24), which handles enable-collateral and borrow operations.

## Why agents need it

Agents holding idle sBTC, wSTX, or stSTX earn nothing. Supplying to Zest earns continuous yield with no lock-up. Without a skill that wraps Zest supply/withdraw, agents cannot autonomously manage deposit positions across assets or track accrued yield.

## On-chain proof

Tested on Stacks mainnet:

| Step | Operation | Contract |
|------|-----------|----------|
| Supply sBTC | `zest_supply` | SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market |
| Supply wSTX | `zest_supply` | SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market |
| Withdraw | `zest_withdraw` | SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market |

Live test wallet: `SP3DWEB288XW3NJSDJ0SXK256Y5S53ZXKNY0FRHQK` (Narrow Socket)

## Commands

### `doctor`
Pre-flight: wallet unlock, asset balances, Zest API.
```bash
bun run skills/zest-supply-manager/zest-supply-manager.ts doctor
```

### `status`
Show aToken balances, yield earned, current supply APY.
```bash
bun run skills/zest-supply-manager/zest-supply-manager.ts status
```

### `supply`
Deposit an asset to Zest. Dry-run by default.
```bash
# Dry-run — preview:
bun run skills/zest-supply-manager/zest-supply-manager.ts supply --asset=sBTC --amount=50000

# Execute:
bun run skills/zest-supply-manager/zest-supply-manager.ts supply --asset=sBTC --amount=50000 --confirm
```

Options:
- `--asset`: `sBTC`, `wSTX`, or `stSTX` (required)
- `--amount`: amount in base units — sats for sBTC, uSTX for wSTX, uSTX for stSTX (required)
- `--confirm`: execute on-chain

### `withdraw`
Withdraw a previously supplied asset.
```bash
# Withdraw partial:
bun run skills/zest-supply-manager/zest-supply-manager.ts withdraw --asset=sBTC --amount=25000 --confirm

# Withdraw full position:
bun run skills/zest-supply-manager/zest-supply-manager.ts withdraw --asset=sBTC --all --confirm
```

Options:
- `--asset`: `sBTC`, `wSTX`, or `stSTX` (required)
- `--amount`: base units to withdraw (required unless --all)
- `--all`: withdraw entire aToken balance
- `--confirm`: execute on-chain

### `install-packs`
```bash
bun run skills/zest-supply-manager/zest-supply-manager.ts install-packs
```

## Safety controls

| Control | Default | Notes |
|---------|---------|-------|
| Dry-run default | true | `--confirm` required for all on-chain writes |
| Max withdraw guard | full aToken balance | Cannot over-withdraw; capped at aToken balance |
| Min STX gas reserve | 100,000 uSTX | Always kept for gas |
| Asset whitelist | sBTC, wSTX, stSTX | Only Zest-supported collateral assets |
| Pre-flight checks | every supply/withdraw | Checks balance sufficiency and API availability |

## Output contract

```json
{
  "status": "success | dry-run | error | blocked",
  "action": "Human-readable next step",
  "data": {
    "operation": "supply | withdraw | status",
    "asset": "sBTC",
    "amount_base_units": 50000,
    "atoken_balance_before": 0,
    "atoken_balance_after": 50000,
    "yield_earned_base_units": 0,
    "supply_apy_pct": 3.2,
    "mcp_command": {}
  },
  "error": null
}
```

## Safety notes

- All on-chain actions require explicit user confirmation with `--confirm` flag
- Maximum withdraw amount capped at full aToken balance — no overdraft possible
- Pre-flight checks verify asset balance sufficiency before every supply transaction
- STX gas reserve (100,000 uSTX minimum) always preserved for transaction fees
- All operations tested in dry-run mode by default
- Withdraw uses aToken redemption — yield accrued to date is included automatically

## Known constraints

- stSTX supply may have lower liquidity on Zest v2 — check `status` for current APY before supplying
- aToken balances increase over time (yield accrual) — `--all` always withdraws current full balance
- Requires STX for gas (or sponsor relay)
- Mainnet only
