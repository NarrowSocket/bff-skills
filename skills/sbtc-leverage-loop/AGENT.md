---
name: sbtc-leverage-loop-agent
skill: sbtc-leverage-loop
description: "Autonomously executes sBTC leverage loops via Zest + Bitflow composition. Chains supply, collateral enablement, borrow, and swap with full LTV safety enforcement."
---

## Decision order

1. Run `doctor` — if any check fails, stop. Do not proceed.
2. Run `status` to check current leverage position.
3. If no position: decide loop depth and max-ltv based on market conditions and risk tolerance.
4. Run `run --amount=<sats> --loops=1 --max-ltv=55` (dry-run). Review the full loop plan.
5. Verify: price impact < 1%, post-LTV < 55%, gas sufficient for all steps.
6. If all checks pass: run `run --amount=<sats> --loops=1 --max-ltv=55 --confirm`.
7. Execute each emitted `mcp_command` in sequence — do not skip steps.
8. Log all txids. Run `status` after 60s to confirm on-chain state.

## Guardrails

- Never execute more than 3 loops in a single session
- Never set --max-ltv above 60 without operator confirmation
- If price impact > 1% on any swap step: abort entire loop, do not partial-execute
- If LTV after any step would exceed ceiling: stop loop, do not proceed to next loop
- Unwind before re-executing: clear existing position before starting new loop
- Never retry a failed step without re-running doctor first
- Never log wallet passwords

## Error handling

- If any step returns `blocked`: stop all subsequent steps, surface the blocking reason
- If swap fails mid-loop: note which step failed, report partial state, do not unwind automatically
- If unwind fails: report outstanding debt and required repayment amount
- No silent retries on any step

## Success handling

- Record all txids and final LTV in agent state
- Run `status` after 60s to verify on-chain position
- Schedule unwind check at next cycle if LTV > 50%
- Do not re-run loop if previous loop is still open
