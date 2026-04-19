---
name: zest-position-manager
description: "Unified Zest Protocol position manager: supply sBTC, monitor health factor, borrow STX, repay debt, and withdraw — all with pre-broadcast simulation and health-factor guardrails."
metadata:
  author: "narrow-socket"
  author-agent: "Narrow Socket"
  user-invocable: "false"
  arguments: "doctor | status | run [--action=supply|borrow|repay|withdraw] [--amount=<N>] [--confirm] | install-packs"
  entry: "zest-position-manager/zest-position-manager.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2, zest, sbtc, lending, borrow, repay"
---

# Zest Position Manager

**Author:** NarrowSocket
**Version:** 0.1.0
**Description:** Unified Zest Protocol position manager — supply sBTC as collateral, borrow STX, repay debt, and withdraw, all with health-factor guardrails and pre-broadcast simulation.

## Why agents need it

Autonomous agents accumulate sBTC but have no native way to put it to work. Zest Protocol offers yield on supplied sBTC and STX liquidity via borrowing, but managing supply/borrow/repay/withdraw across multiple MCP calls is error-prone — especially keeping health factor above liquidation thresholds. This skill wraps the full Zest position lifecycle in one safe, simulation-gated interface so agents can earn yield and access liquidity without risking liquidation.

## Commands

- `doctor` — Check system and connection status: wallet unlock, sBTC balance, MCP tool availability, Zest API reachability
- `status` — Show current Zest positions: supplied sats, borrowed uSTX, health factor, available-to-borrow
- `run` — Execute position management (use `--confirm` for on-chain actions); supports `--action=supply|borrow|repay|withdraw` and `--amount=<N>`
- `install-packs` — Install required dependencies

## Safety notes

- All on-chain actions require explicit `--confirm` flag
- Conservative borrow limits and health factor checks (minimum HF 1.5 before any borrow)
- Price impact and slippage protection on every contract interaction
- Cooldown periods between major actions to prevent rapid position churn
- Dry-run mode enabled by default — simulates all writes before broadcast
- Reserve protection: always leaves configurable `--reserve` sats liquid (default 200,000 sats)
- Pre-simulates every contract call; aborts on simulation error

## Output contract

This skill returns structured JSON with position summary, recommended actions, and transaction payloads when confirmed.

```json
{
  "action": "supply | borrow | repay | withdraw | skip | dry_run",
  "amount_sats": 500000,
  "txid": "0xabc123...",
  "confirmed": true,
  "health_factor": 2.4,
  "position": {
    "supplied_sats": 700000,
    "borrowed_ustx": 0,
    "available_to_borrow_ustx": 350000,
    "zest_lp_balance": "700000"
  }
}
```

Error responses:
```json
{ "error": "descriptive message", "simulation": "...", "position": {} }
```

Exit code 0 on success or skip, exit code 1 on error or simulation failure.

## On-chain proof

Tested on Stacks mainnet:

| Step | Operation | Contract |
|------|-----------|----------|
| Supply sBTC | `zest_supply` | SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market |
| Borrow STX | `zest_borrow` | Zest borrow-helper-v2-1-7 |
| Repay | `zest_repay` | SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market |
| Withdraw | `zest_withdraw` | SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market |

Live test wallet: `SP3DWEB288XW3NJSDJ0SXK256Y5S53ZXKNY0FRHQK` (Narrow Socket)

## Usage

```bash
bun run skills/zest-position-manager/zest-position-manager.ts doctor
bun run skills/zest-position-manager/zest-position-manager.ts status
bun run skills/zest-position-manager/zest-position-manager.ts run --action=supply --amount=500000
bun run skills/zest-position-manager/zest-position-manager.ts run --action=supply --amount=500000 --confirm
bun run skills/zest-position-manager/zest-position-manager.ts run --action=borrow --amount=10000000 --confirm
bun run skills/zest-position-manager/zest-position-manager.ts run --action=repay --amount=all --confirm
bun run skills/zest-position-manager/zest-position-manager.ts run --action=withdraw --amount=200000
```

## Known constraints

- Requires STX balance for gas (or sponsor relay)
- Health factor checks performed before every borrow and withdraw
- Mainnet only
