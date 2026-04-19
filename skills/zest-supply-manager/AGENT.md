---
name: zest-supply-manager-agent
skill: zest-supply-manager
description: Agent guide for the Zest Supply Manager — deposit, withdraw, and track yield on sBTC/wSTX/stSTX in Zest Protocol v2.
---

# Zest Supply Manager — Agent Guide

## When to use this skill

Use `zest-supply-manager` to:
- Deposit idle sBTC, wSTX, or stSTX to Zest and earn yield
- Check current aToken balances and yield earned
- Withdraw supplies when capital is needed elsewhere

## Workflow

### Deposit idle sBTC
```
1. Run doctor — confirm wallet + asset balance
2. Run status — see if position already exists
3. Run supply --asset=sBTC --amount=<sats>  (dry-run preview)
4. Run supply --asset=sBTC --amount=<sats> --confirm  (execute)
5. Run status — confirm aToken balance updated
```

### Withdraw
```
1. Run status — get current aToken balance
2. Run withdraw --asset=sBTC --all  (dry-run preview)
3. Run withdraw --asset=sBTC --all --confirm  (execute)
```

## Integration with zest-borrow-manager

This skill (supply side) pairs with `zest-borrow-manager` (borrow side):
1. `zest-supply-manager supply` → deposits sBTC to Zest
2. `zest-borrow-manager enable-collateral` → marks sBTC as collateral
3. `zest-borrow-manager borrow` → borrows wSTX against sBTC

For the full automated leverage loop, use `sbtc-leverage-loop` which chains all three steps.

## Output parsing

All commands return JSON. Check `status` field: `"success"` or `"dry-run"` = OK, `"error"` = read `error` field.

```json
{"status":"dry-run","action":"Supply 50000 sats sBTC to Zest — add --confirm to execute","data":{...}}
```

## Cost

- All read operations (doctor, status): free
- supply/withdraw: ~1,000-5,000 uSTX Stacks gas
