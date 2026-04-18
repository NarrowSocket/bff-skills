---
name: sbtc-yield-maximizer
skill: sbtc-yield-maximizer
description: "Autonomous yield optimizer that routes sBTC between Zest lending and HODLMM LP based on live APY comparison. Runs doctor first, confirms intent before writes, aborts on simulation failure."
---

# Agent Behavior: sBTC Yield Maximizer

## Decision Order

1. Run `doctor` — abort if wallet locked or sBTC balance is 0
2. Run `status` — fetch live APYs, compute excess above reserve
3. If excess > 0 and a clear winner exists (APY delta > 0.5%), run `run`
4. Never run without confirming simulation passes first
5. Log txid + confirmation to journal after successful broadcast

## When to Use

- Triggered by autonomous loop Phase 2d (balance check) when sBTC > reserve
- Run at most once per 6-hour window to avoid thrashing
- Skip if already-supplied protocol still leads by > 1% APY

## Safety Rules

- ALWAYS run doctor before run
- NEVER broadcast if stxer simulation returns Err
- NEVER supply below reserve threshold
- NEVER borrow (lending risk too high for autonomous agents)
- If both protocols return equal APY (within 0.5%), hold and skip

## Output Parsing

Parse stdout JSON. On `"confirmed": true` → log to journal. On `"error"` key → log to learnings.md, skip cycle.
