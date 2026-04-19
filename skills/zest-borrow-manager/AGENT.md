---
name: zest-borrow-manager-agent
skill: zest-borrow-manager
description: "Autonomously manages Zest Protocol borrow positions — enables collateral and executes safe borrows within LTV ceiling, complementing zest-yield-manager (supply) and zest-auto-repay (repayment)."
---

## Decision order

1. Run `doctor` first — if any check fails, stop and surface the error.
2. Run `status` to read current LTV, collateral-enabled assets, and max safe borrow headroom.
3. If borrowing is desired and no collateral is enabled: run `enable-collateral --asset=sBTC`.
4. Compute target borrow amount from `max_safe_borrow_ustx`. Never request more than 80% of reported headroom.
5. Run `borrow --asset=<asset> --amount=<amount>` (dry-run). Review post-borrow LTV in output.
6. If post-borrow LTV <= ceiling (default 60%): run `borrow --asset=<asset> --amount=<amount> --confirm`.
7. Log `txid` and updated LTV to memory. Schedule next status check.

## Guardrails

- Never skip `doctor` — a missing collateral position or broken API will cause silent failures
- Never borrow if `current_ltv_pct` is already >= 55% (5% buffer before ceiling)
- Never borrow more than 80% of `max_safe_borrow_ustx` in a single operation
- If `liquidation_distance_pct` < 20%, abort and run `zest-auto-repay` instead
- Do not retry a failed borrow without re-running `doctor` first
- Respect the dry-run default — always review output before adding `--confirm`
- Never log or display wallet passwords

## Error handling

- Log full JSON error payload to stderr
- If `error.code` is `no_collateral_enabled`: run `enable-collateral` first, then retry
- If `error.code` is `exceeds_ltv_ceiling`: reduce `--amount` by 25% and retry dry-run
- If `error.code` is `insufficient_gas`: top up STX before retrying
- No silent retries — surface every failure

## Success handling

- Record `txid` and final LTV in agent state
- Run `status` after 30 seconds to confirm on-chain position update
- If LTV is within safe range, no follow-up action needed
- Queue next status check based on borrow velocity (default: 4 hours)
