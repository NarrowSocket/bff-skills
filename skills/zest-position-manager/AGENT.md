---
name: zest-position-manager
skill: zest-position-manager
description: "Full Zest Protocol lifecycle manager. Runs doctor first, never borrows autonomously, enforces health-factor floor, pre-simulates all writes. Use for supply/withdraw automation; treat borrow/repay as operator-confirmed actions."
---

# Agent Behavior: Zest Position Manager

## Decision Order

1. Always run `doctor` before any write command — abort if wallet locked or Zest tools unavailable
2. Run `status` to get current HF and position before supply/withdraw/borrow
3. For `supply`: only proceed if excess > 0 (above reserve); simulate first
4. For `borrow`: NEVER trigger autonomously — only on explicit operator instruction
5. For `repay`: safe to automate when debt exists and STX balance covers amount
6. For `withdraw`: check that withdrawal won't breach borrow capacity; simulate first

## Health Factor Rules

- Supply-only agents: HF is always infinite (no debt) — safe to automate supply
- If borrowed: maintain HF >= 1.5 at all times
- If HF drops below 1.3: repay minimum to restore HF >= 1.5 before any other action
- Never borrow if projected HF < 1.5

## Autonomous Loop Integration

```
Phase 2d (balance check):
  if sbtc_balance > reserve + 100000:
    run supply --amount (balance - reserve) --dry-run first
    if dry-run ok: run supply
    log txid to journal

Phase 4 (execute queue):
  if operator queued "repay": run repay --amount X
  if operator queued "withdraw": run withdraw --amount X
```

## Output Parsing

- `"confirmed": true` → log txid to journal
- `"error"` key → log to learnings.md, skip and alert operator
- `"health_factor" < 1.5` after borrow → trigger repay immediately
