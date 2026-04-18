#!/usr/bin/env ts-node
/**
 * HODLMM Inventory Balancer
 * Detects token ratio drift in HODLMM positions and corrects via Bitflow swaps.
 * Pre-simulates all writes. Drift-threshold gated.
 */

import { Command } from "commander";
import { execSync } from "child_process";

const program = new Command();

// ── Constants ────────────────────────────────────────────────────────────────
const SBTC_TOKEN = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const STX_TOKEN = "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx"; // wrapped STX for pool
const STXER_BASE = "https://api.stxer.xyz";
const HIRO_BASE = "https://api.hiro.so";
const DEFAULT_TARGET = 50;     // % sBTC target
const DEFAULT_THRESHOLD = 5;   // % drift before rebalancing
const DEFAULT_MAX_SWAP = 500_000; // sats or uSTX cap
const DEFAULT_MAX_SLIPPAGE = 1.0; // %

// ── Helpers ───────────────────────────────────────────────────────────────────
function mcp(tool: string, args: Record<string, unknown> = {}): unknown {
  const payload = JSON.stringify({ tool, arguments: args });
  try {
    const out = execSync(
      `echo '${payload.replace(/'/g, "'\\''")}' | npx @aibtc/mcp-server@latest --call`,
      { encoding: "utf8", timeout: 30_000 }
    );
    return JSON.parse(out.trim());
  } catch (e) {
    throw new Error(`MCP(${tool}): ${e instanceof Error ? e.message : e}`);
  }
}

function curlGet(url: string): unknown {
  const out = execSync(`curl -sf "${url}"`, { encoding: "utf8", timeout: 15_000 });
  return JSON.parse(out.trim());
}

function curlPost(url: string, body: unknown): unknown {
  const esc = JSON.stringify(body).replace(/'/g, "'\\''");
  const out = execSync(
    `curl -sf -X POST -H "Content-Type: application/json" -d '${esc}' "${url}"`,
    { encoding: "utf8", timeout: 15_000 }
  );
  return JSON.parse(out.trim());
}

function simulate(sender: string, contract: string, code: string): { safe: boolean; result: string } {
  const { id } = curlPost(`${STXER_BASE}/devtools/v2/simulations`, { skip_tracing: true }) as { id: string };
  const resp = curlPost(`${STXER_BASE}/devtools/v2/simulations/${id}`, {
    steps: [{ Eval: [sender, "", contract, code] }],
  }) as { steps: Array<{ Eval: Record<string, unknown> }> };
  const ev = resp?.steps?.[0]?.Eval ?? {};
  return { safe: "Ok" in ev, result: JSON.stringify(ev) };
}

async function waitConfirm(txid: string | undefined, timeoutMs = 60_000): Promise<boolean> {
  if (!txid) return false;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 6_000));
    const s = mcp("get_transaction_status", { txid }) as { status?: string };
    if (s?.status === "success") return true;
    if (s?.status?.startsWith("abort")) return false;
  }
  return false;
}

// ── Position fetcher ──────────────────────────────────────────────────────────
interface PositionInfo {
  sbtc_sats: number;
  stx_ustx: number;
  sbtc_value_usd: number;
  stx_value_usd: number;
  actual_ratio_pct: number;
  has_position: boolean;
}

function getHodlmmPosition(stxAddress: string): PositionInfo {
  // Query Bitflow API for LP position
  let sbtcSats = 0;
  let stxUstx = 0;

  try {
    const resp = curlGet(
      `https://api.bitflow.finance/v1/positions?address=${stxAddress}`
    ) as { positions?: Array<{ token0: string; token0Amount: number; token1Amount: number }> };

    const sbtcPos = resp?.positions?.find((p) =>
      p.token0?.toLowerCase().includes("sbtc")
    );
    if (sbtcPos) {
      sbtcSats = sbtcPos.token0Amount ?? 0;
      stxUstx = sbtcPos.token1Amount ?? 0;
    }
  } catch {
    // fallback: check wallet balances as proxy
    try {
      const balResp = mcp("sbtc_get_balance") as { balance?: number };
      sbtcSats = balResp?.balance ?? 0;
      const stxResp = mcp("get_stx_balance") as { balance?: number };
      stxUstx = stxResp?.balance ?? 0;
    } catch { /* no position data */ }
  }

  // Approximate USD values (BTC ~$85k, STX ~$0.40)
  const BTC_PRICE = 85_000;
  const STX_PRICE = 0.40;
  const sbtcUsd = (sbtcSats / 1e8) * BTC_PRICE;
  const stxUsd = (stxUstx / 1e6) * STX_PRICE;
  const total = sbtcUsd + stxUsd;
  const actualRatio = total > 0 ? (sbtcUsd / total) * 100 : 50;

  return {
    sbtc_sats: sbtcSats,
    stx_ustx: stxUstx,
    sbtc_value_usd: Math.round(sbtcUsd * 100) / 100,
    stx_value_usd: Math.round(stxUsd * 100) / 100,
    actual_ratio_pct: Math.round(actualRatio * 10) / 10,
    has_position: sbtcSats > 0 || stxUstx > 0,
  };
}

// ── Swap amount calculator ────────────────────────────────────────────────────
function calcSwap(
  pos: PositionInfo,
  targetPct: number,
  maxSwap: number
): { direction: "sbtc_to_stx" | "stx_to_sbtc"; amount: number; drift_pct: number } {
  const BTC_PRICE = 85_000;
  const STX_PRICE = 0.40;
  const totalUsd = pos.sbtc_value_usd + pos.stx_value_usd;
  const targetSbtcUsd = totalUsd * (targetPct / 100);
  const diff = targetSbtcUsd - pos.sbtc_value_usd; // positive = need more sBTC
  const drift = pos.actual_ratio_pct - targetPct;

  if (diff > 0) {
    // Need more sBTC → swap STX → sBTC
    const stxNeeded = Math.abs(diff) / STX_PRICE * 1e6; // uSTX
    const maxSwapUstx = maxSwap * 1e6; // maxSwap is in sats-equivalent; convert to uSTX cap
    return {
      direction: "stx_to_sbtc",
      amount: Math.min(Math.round(stxNeeded), maxSwapUstx),
      drift_pct: Math.abs(drift),
    };
  } else {
    // Too much sBTC → swap sBTC → STX
    const sbtcNeeded = Math.abs(diff) / BTC_PRICE * 1e8; // sats
    return {
      direction: "sbtc_to_stx",
      amount: Math.min(Math.round(sbtcNeeded), maxSwap),
      drift_pct: Math.abs(drift),
    };
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
program.name("hodlmm-inventory-balancer").version("1.0.0");

program.command("doctor").description("Check prerequisites").action(() => {
  const checks: Record<string, unknown> = {};

  try {
    const ws = mcp("wallet_status") as { isUnlocked?: boolean; wallet?: { address: string } };
    checks.wallet_unlocked = ws?.isUnlocked ?? false;
    checks.stx_address = ws?.wallet?.address ?? "unknown";
  } catch { checks.wallet_unlocked = false; }

  try {
    const bal = mcp("sbtc_get_balance") as { balance?: number };
    checks.sbtc_balance_sats = bal?.balance ?? 0;
  } catch { checks.sbtc_balance_sats = "error"; }

  try {
    // Check ALEX/Bitflow swap availability
    mcp("alex_list_pools");
    checks.alex_pools = true;
  } catch { checks.alex_pools = false; }

  try {
    curlGet("https://api.bitflow.finance/v1/health");
    checks.bitflow_api = true;
  } catch { checks.bitflow_api = false; }

  try {
    curlPost(`${STXER_BASE}/devtools/v2/simulations`, { skip_tracing: true });
    checks.stxer_reachable = true;
  } catch { checks.stxer_reachable = false; }

  const ready = checks.wallet_unlocked === true && checks.alex_pools === true;
  console.log(JSON.stringify({ ready, checks }, null, 2));
  process.exit(ready ? 0 : 1);
});

program
  .command("status")
  .description("Show current ratio, drift, and recommended action (no writes)")
  .option("--target <pct>", "Target sBTC ratio %", String(DEFAULT_TARGET))
  .option("--threshold <pct>", "Drift threshold %", String(DEFAULT_THRESHOLD))
  .option("--max-swap <sats>", "Max swap amount", String(DEFAULT_MAX_SWAP))
  .action((opts) => {
    const target = parseFloat(opts.target);
    const threshold = parseFloat(opts.threshold);
    const maxSwap = parseInt(opts.maxSwap, 10);

    const ws = mcp("wallet_status") as { wallet?: { address: string } };
    const addr = ws?.wallet?.address ?? "";
    const pos = getHodlmmPosition(addr);

    if (!pos.has_position) {
      console.log(JSON.stringify({ action: "skip", reason: "No HODLMM position found", address: addr }));
      return;
    }

    const swap = calcSwap(pos, target, maxSwap);
    const needsRebalance = swap.drift_pct > threshold;

    console.log(JSON.stringify({
      position: pos,
      target_ratio_pct: target,
      drift_pct: swap.drift_pct,
      threshold_pct: threshold,
      needs_rebalance: needsRebalance,
      recommended: needsRebalance
        ? { action: `swap_${swap.direction}`, amount: swap.amount }
        : { action: "hold", reason: `Drift ${swap.drift_pct.toFixed(1)}% within ${threshold}% threshold` },
    }, null, 2));
  });

program
  .command("rebalance")
  .description("Execute corrective swap to restore target ratio")
  .option("--target <pct>", "Target sBTC ratio %", String(DEFAULT_TARGET))
  .option("--threshold <pct>", "Min drift % before acting", String(DEFAULT_THRESHOLD))
  .option("--max-swap <sats>", "Max swap cap in sats (sBTC side)", String(DEFAULT_MAX_SWAP))
  .option("--max-slippage <pct>", "Max slippage %", String(DEFAULT_MAX_SLIPPAGE))
  .option("--dry-run", "Simulate only, no broadcast", false)
  .action(async (opts) => {
    const target = parseFloat(opts.target);
    const threshold = parseFloat(opts.threshold);
    const maxSwap = parseInt(opts.maxSwap, 10);
    const maxSlippage = parseFloat(opts.maxSlippage);
    const dryRun = opts.dryRun as boolean;

    const ws = mcp("wallet_status") as { isUnlocked?: boolean; wallet?: { address: string } };
    if (!ws?.isUnlocked) {
      console.log(JSON.stringify({ error: "Wallet locked" })); process.exit(1);
    }
    const addr = ws.wallet!.address;

    const pos = getHodlmmPosition(addr);
    if (!pos.has_position) {
      console.log(JSON.stringify({ action: "skip", reason: "No HODLMM position found" }));
      return;
    }

    const swap = calcSwap(pos, target, maxSwap);

    if (swap.drift_pct <= threshold) {
      console.log(JSON.stringify({
        action: "skip",
        reason: `Drift ${swap.drift_pct.toFixed(1)}% within ${threshold}% threshold`,
        actual_ratio_pct: pos.actual_ratio_pct,
        target_ratio_pct: target,
      }));
      return;
    }

    if (swap.drift_pct > 20) {
      console.log(JSON.stringify({
        error: "Drift > 20% — possible price anomaly. Operator review required.",
        drift_pct: swap.drift_pct,
        position: pos,
      }));
      process.exit(1);
    }

    // Get swap quote and check slippage
    let quoteSlippage = 0;
    try {
      const quote = mcp("alex_get_swap_quote", {
        from: swap.direction === "stx_to_sbtc" ? STX_TOKEN : SBTC_TOKEN,
        to: swap.direction === "stx_to_sbtc" ? SBTC_TOKEN : STX_TOKEN,
        amount: swap.amount,
      }) as { slippage?: number; price_impact?: number };
      quoteSlippage = (quote?.slippage ?? quote?.price_impact ?? 0) * 100;
    } catch { /* proceed without slippage check if quote unavailable */ }

    if (quoteSlippage > maxSlippage) {
      console.log(JSON.stringify({
        error: `Slippage ${quoteSlippage.toFixed(2)}% exceeds max ${maxSlippage}%`,
        swap_direction: swap.direction,
        amount: swap.amount,
      }));
      process.exit(1);
    }

    // Pre-simulate via stxer
    const alexContract = "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.amm-pool-v2-01";
    const clarityCode = swap.direction === "stx_to_sbtc"
      ? `(contract-call? '${alexContract} swap-helper 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx '${SBTC_TOKEN} u${swap.amount} none)`
      : `(contract-call? '${alexContract} swap-helper '${SBTC_TOKEN} 'SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx u${swap.amount} none)`;

    const sim = simulate(addr, alexContract, clarityCode);
    if (!sim.safe) {
      console.log(JSON.stringify({ error: "Simulation failed — aborting", simulation: sim.result }));
      process.exit(1);
    }

    if (dryRun) {
      console.log(JSON.stringify({
        dry_run: true,
        action: `swap_${swap.direction}`,
        amount: swap.amount,
        drift_pct: swap.drift_pct,
        target_ratio_pct: target,
        simulation: "Ok",
      }));
      return;
    }

    // Execute swap via ALEX
    const tx = mcp("alex_swap", {
      from: swap.direction === "stx_to_sbtc" ? STX_TOKEN : SBTC_TOKEN,
      to: swap.direction === "stx_to_sbtc" ? SBTC_TOKEN : STX_TOKEN,
      amount: swap.amount,
    }) as { txid?: string; success?: boolean };

    if (!tx?.txid) {
      console.log(JSON.stringify({ error: "Swap broadcast failed", response: tx }));
      process.exit(1);
    }

    const confirmed = await waitConfirm(tx.txid);
    const posAfter = getHodlmmPosition(addr);

    console.log(JSON.stringify({
      action: `swap_${swap.direction}`,
      amount: swap.amount,
      drift_pct: swap.drift_pct,
      actual_ratio_pct: pos.actual_ratio_pct,
      target_ratio_pct: target,
      txid: tx.txid,
      confirmed,
      ratio_after_pct: posAfter.actual_ratio_pct,
      position_after: posAfter,
    }));
  });

program.parse(process.argv);
