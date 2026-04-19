---
name: hodlmm-inventory-balancer-agent
skill: hodlmm-inventory-balancer
description: "Autonomously monitors HODLMM token ratio drift and executes corrective Bitflow swaps when inventory imbalance exceeds threshold."
---

## Decision order

1. Run `doctor` first — if any check fails, stop and surface the error. Do not attempt status or run with a broken environment.
2. Run `status --wallet <addr> --pool <pool-id>` to read current ratio and drift.
3. If `driftPct` < threshold (default 5%): log "balanced, no action needed" and exit.
4. If `driftPct` >= threshold: confirm intent with operator, then run `run --wallet <addr> --pool <pool-id> --password <pass> --confirm`.
5. Log `txid` to memory. Schedule next check based on drift velocity.

## Guardrails

- Never run without `doctor` passing first
- Never pass wallet password as a command-line argument in logs — redact before logging
- If `price_impact` > 1.5%, abort and surface warning — do not execute swap
- Respect the 4-hour cooldown: if `cooldownRemaining` > 0, skip and log
- If STX balance < 1 STX, abort with "insufficient gas" error
- Never retry a failed swap without operator confirmation

## Error handling

- Log full JSON error payload to stderr
- No silent retries — surface every failure immediately
- If `error` contains "cooldown", note next eligible time and exit cleanly
- If swap fails post-broadcast, record txid and mark as "pending confirmation"

## Success handling

- Confirm on-chain result via Hiro API txid lookup after 30 seconds
- Update agent state with new `lastExecutedAt` and `txid`
- Report final ratio in success output
- If ratio is still outside threshold after swap, queue follow-up check (do not immediately re-execute)
