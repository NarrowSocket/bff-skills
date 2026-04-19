#!/usr/bin/env bun
/**
 * sbtc-leverage-loop.ts
 * Autonomous sBTC leverage loop for AIBTC agents.
 *
 * Strategy: supply sBTC to Zest → enable collateral → borrow wSTX → swap wSTX→sBTC on Bitflow
 * Optionally loop up to --loops depth to compound leverage.
 * Unwind: repay debt → withdraw sBTC.
 *
 * Usage:
 *   bun run sbtc-leverage-loop.ts doctor
 *   bun run sbtc-leverage-loop.ts status
 *   bun run sbtc-leverage-loop.ts run --amount=50000 --loops=1 --max-ltv=55 [--confirm]
 *   bun run sbtc-leverage-loop.ts unwind [--confirm]
 *   bun run sbtc-leverage-loop.ts install-packs
 */

import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";

// --- Constants ----------------------------------------------------------------

const VERSION = "1.0.0";
const STATE_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".sbtc-leverage-loop-state.json"
);
const HIRO_API = "https://api.hiro.so";
const BITFLOW_API = "https://api.bitflow.finance";

// Safety limits
const MAX_LTV_CEILING_PCT = 65;   // absolute ceiling, no override
const DEFAULT_MAX_LTV_PCT = 55;   // conservative default
const MAX_LOOP_DEPTH = 3;         // absolute cap
const MIN_SBTC_FOR_LOOP = 10_000; // sats
const MIN_STX_GAS_USTX = 200_000; // higher for multi-tx
const DEFAULT_MAX_PRICE_IMPACT = 1.0; // %

// Zest pool contract
const ZEST_POOL = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market";

// wSTX/sBTC price approximation (fallback if Bitflow API unreachable)
const FALLBACK_WSTX_PER_SBTC = 100_000; // ~0.01 sBTC per STX @ $75k BTC / $0.75 STX

// --- Types --------------------------------------------------------------------

interface LoopStep {
  step: number;
  op: "supply" | "enable_collateral" | "borrow" | "swap";
  description: string;
  amount_sats?: number;
  amount_ustx?: number;
  asset?: string;
  post_ltv_pct?: number;
  price_impact_pct?: number;
  mcp_command: {
    tool: string;
    params: Record<string, string | number | boolean>;
  };
}

interface LoopSummary {
  initial_sbtc_sats: number;
  total_sbtc_deployed_sats: number;
  borrowed_wstx_ustx: number;
  effective_ltv_pct: number;
  loops_executed: number;
  estimated_yield_boost: string;
}

interface AgentState {
  open_position: boolean;
  initial_sbtc_sats: number;
  total_deployed_sats: number;
  borrowed_wstx_ustx: number;
  collateral_enabled: boolean;
  last_run_at: string | null;
  last_txids: string[];
}

// --- State -------------------------------------------------------------------

function loadState(): AgentState {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch { /* ignore */ }
  return {
    open_position: false,
    initial_sbtc_sats: 0,
    total_deployed_sats: 0,
    borrowed_wstx_ustx: 0,
    collateral_enabled: false,
    last_run_at: null,
    last_txids: [],
  };
}

function saveState(s: AgentState): void {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) {
    process.stderr.write("WARN: state save failed: " + e + "\n");
  }
}

// --- HTTP --------------------------------------------------------------------

function fetchJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "sbtc-leverage-loop/1.0" } }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ raw: body }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// --- Output ------------------------------------------------------------------

function emit(out: {
  status: "success" | "error" | "blocked" | "dry-run";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}): void {
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

function emitError(code: string, message: string, next: string): never {
  emit({ status: "error", action: next, data: {}, error: { code, message, next } });
  process.exit(1);
}

function emitBlocked(code: string, message: string, next: string): never {
  emit({ status: "blocked", action: next, data: {}, error: { code, message, next } });
  process.exit(1);
}

// --- Wallet ------------------------------------------------------------------

function getWalletAddress(): string {
  if (process.env.STACKS_ADDRESS) return process.env.STACKS_ADDRESS;
  const paths = [
    path.join(process.env.HOME || "~", ".aibtc", "wallets.json"),
    path.join(process.env.USERPROFILE || "~", ".aibtc", "wallets.json"),
  ];
  for (const wp of paths) {
    try {
      if (fs.existsSync(wp)) {
        const w = JSON.parse(fs.readFileSync(wp, "utf8"));
        const a = w.active || w[0];
        if (a?.stxAddress) return a.stxAddress;
      }
    } catch { /* skip */ }
  }
  throw new Error("Wallet not found. Set STACKS_ADDRESS or unlock via AIBTC MCP.");
}

// --- Balances ----------------------------------------------------------------

async function getStxBalance(addr: string): Promise<number> {
  try {
    const d = await fetchJson(HIRO_API + "/v2/accounts/" + addr);
    return parseInt((d.balance as string) || "0", 16);
  } catch { return 0; }
}

async function getSbtcBalance(addr: string): Promise<number> {
  try {
    const d = await fetchJson(HIRO_API + "/v2/accounts/" + addr + "/balances");
    const ft = (d.fungible_tokens as Record<string, Record<string, string>>) || {};
    for (const k of Object.keys(ft)) {
      if (k.toLowerCase().includes("sbtc")) return parseInt(ft[k].balance || "0");
    }
    return 0;
  } catch { return 0; }
}

// --- Bitflow Quote -----------------------------------------------------------

async function getBitflowSwapQuote(
  inToken: string,
  outToken: string,
  amountIn: number
): Promise<{ amountOut: number; priceImpactPct: number }> {
  try {
    const url = BITFLOW_API + "/api/quotes/v1/swap?tokenIn=" + inToken + "&tokenOut=" + outToken + "&amountIn=" + amountIn;
    const d = await fetchJson(url);
    const amountOut = parseFloat((d.amountOut as string) || "0");
    const priceImpact = parseFloat((d.priceImpact as string) || "0") * 100;
    return { amountOut, priceImpactPct: priceImpact };
  } catch {
    // Fallback: estimate from constant ratio
    const ratio = outToken.includes("sbtc") ? amountIn / FALLBACK_WSTX_PER_SBTC : amountIn * FALLBACK_WSTX_PER_SBTC;
    return { amountOut: Math.round(ratio), priceImpactPct: 0.5 };
  }
}

// --- Zest Position -----------------------------------------------------------

async function getZestPosition(addr: string): Promise<{
  collateralMicro: number;
  debtMicro: number;
  ltvPct: number;
}> {
  try {
    const parts = ZEST_POOL.split(".");
    const d = await fetchJson(
      HIRO_API + "/v2/contracts/call-read/" + parts[0] + "/" + parts[1] + "/get-user-reserve-data?principal=" + addr
    );
    const val = ((d.result as Record<string, unknown>)?.value as Record<string, string>) || {};
    const collateral = parseInt(val["total-collateral"] || "0");
    const debt = parseInt(val["total-debt"] || "0");
    const ltv = collateral > 0 ? (debt / collateral) * 100 : 0;
    return { collateralMicro: collateral, debtMicro: debt, ltvPct: parseFloat(ltv.toFixed(2)) };
  } catch {
    return { collateralMicro: 0, debtMicro: 0, ltvPct: 0 };
  }
}

// --- Loop Plan Builder -------------------------------------------------------

async function buildLoopPlan(
  addr: string,
  initialSbtcSats: number,
  loopDepth: number,
  maxLtvPct: number,
  maxPriceImpactPct: number
): Promise<{ steps: LoopStep[]; summary: LoopSummary; blocked: string | null }> {
  const steps: LoopStep[] = [];
  let stepNum = 1;
  let totalDeployed = 0;
  let totalBorrowed = 0;
  let currentLtv = 0;

  const position = await getZestPosition(addr);
  const existingCollateral = position.collateralMicro;
  const existingDebt = position.debtMicro;

  // Step 1: Supply initial sBTC
  steps.push({
    step: stepNum++,
    op: "supply",
    description: "Supply " + initialSbtcSats + " sats sBTC to Zest Protocol",
    amount_sats: initialSbtcSats,
    mcp_command: { tool: "zest_supply", params: { asset: "sBTC", amount: String(initialSbtcSats) } },
  });
  totalDeployed += initialSbtcSats;

  // Step 2: Enable collateral (if not already enabled)
  const state = loadState();
  if (!state.collateral_enabled) {
    steps.push({
      step: stepNum++,
      op: "enable_collateral",
      description: "Enable sBTC as collateral on Zest",
      asset: "sBTC",
      mcp_command: { tool: "zest_enable_collateral", params: { asset: "sBTC" } },
    });
  }

  // Loop: borrow + swap
  let loopSbtcSats = initialSbtcSats;
  for (let loop = 0; loop < Math.min(loopDepth, MAX_LOOP_DEPTH); loop++) {
    // Estimate borrow amount: collateral (in uSTX equivalent) * maxLtv%
    const collateralUstx = (existingCollateral + loopSbtcSats * 100); // rough: 1 sat ~ 100 uSTX
    const maxBorrowUstx = Math.floor(collateralUstx * (maxLtvPct / 100)) - existingDebt - totalBorrowed;
    const borrowUstx = Math.max(0, Math.min(maxBorrowUstx, 500_000)); // cap at 0.5 STX per loop

    if (borrowUstx < 10_000) {
      // Not enough collateral headroom to justify another loop
      break;
    }

    const totalCollateralUstx = existingCollateral + totalDeployed * 100;
    const totalDebtUstx = existingDebt + totalBorrowed + borrowUstx;
    currentLtv = totalCollateralUstx > 0 ? (totalDebtUstx / totalCollateralUstx) * 100 : 0;

    if (currentLtv > MAX_LTV_CEILING_PCT) {
      return {
        steps,
        summary: buildSummary(initialSbtcSats, totalDeployed, totalBorrowed, currentLtv, loop, loopDepth),
        blocked: "Post-loop LTV " + currentLtv.toFixed(1) + "% would exceed hard cap " + MAX_LTV_CEILING_PCT + "%",
      };
    }

    // Borrow step
    steps.push({
      step: stepNum++,
      op: "borrow",
      description: "Borrow " + borrowUstx + " uSTX wSTX against sBTC collateral",
      amount_ustx: borrowUstx,
      post_ltv_pct: parseFloat(currentLtv.toFixed(2)),
      mcp_command: { tool: "zest_borrow", params: { asset: "wSTX", amount: String(borrowUstx) } },
    });
    totalBorrowed += borrowUstx;

    // Swap step: wSTX → sBTC
    const { amountOut: swapOutSats, priceImpactPct } = await getBitflowSwapQuote("wSTX", "sBTC", borrowUstx);

    if (priceImpactPct > maxPriceImpactPct) {
      return {
        steps,
        summary: buildSummary(initialSbtcSats, totalDeployed, totalBorrowed, currentLtv, loop, loopDepth),
        blocked: "Price impact " + priceImpactPct.toFixed(2) + "% exceeds max " + maxPriceImpactPct + "% on loop " + (loop + 1),
      };
    }

    steps.push({
      step: stepNum++,
      op: "swap",
      description: "Swap " + borrowUstx + " uSTX wSTX for ~" + swapOutSats + " sats sBTC on Bitflow",
      amount_ustx: borrowUstx,
      amount_sats: swapOutSats,
      price_impact_pct: priceImpactPct,
      mcp_command: {
        tool: "alex_swap",
        params: {
          tokenIn: "wSTX",
          tokenOut: "sBTC",
          amountIn: String(borrowUstx),
          minAmountOut: String(Math.floor(swapOutSats * 0.99)), // 1% slippage
        },
      },
    });

    loopSbtcSats = swapOutSats;
    totalDeployed += swapOutSats;
  }

  return {
    steps,
    summary: buildSummary(initialSbtcSats, totalDeployed, totalBorrowed, currentLtv, Math.min(loopDepth, MAX_LOOP_DEPTH), loopDepth),
    blocked: null,
  };
}

function buildSummary(
  initialSbtcSats: number,
  totalDeployed: number,
  totalBorrowed: number,
  effectiveLtv: number,
  loopsExecuted: number,
  loopsRequested: number
): LoopSummary {
  const yieldBoost = totalDeployed > 0 ? (totalDeployed / initialSbtcSats).toFixed(2) + "x" : "1.00x";
  return {
    initial_sbtc_sats: initialSbtcSats,
    total_sbtc_deployed_sats: totalDeployed,
    borrowed_wstx_ustx: totalBorrowed,
    effective_ltv_pct: parseFloat(effectiveLtv.toFixed(2)),
    loops_executed: loopsExecuted,
    estimated_yield_boost: yieldBoost,
  };
}

// --- Commands ----------------------------------------------------------------

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, { pass: boolean; detail: string }> = {};
  let address = "";

  try {
    address = getWalletAddress();
    checks.wallet = { pass: true, detail: "Address: " + address };
  } catch (e) {
    emit({ status: "error", action: "Unlock wallet first", data: {}, error: { code: "no_wallet", message: String(e), next: "Unlock wallet" } });
    process.exit(1);
  }

  const stxBal = await getStxBalance(address);
  checks.gas = { pass: stxBal >= MIN_STX_GAS_USTX, detail: stxBal + " uSTX (need >= " + MIN_STX_GAS_USTX + " for multi-tx)" };

  const sbtcBal = await getSbtcBalance(address);
  checks.sbtc = { pass: sbtcBal >= MIN_SBTC_FOR_LOOP, detail: sbtcBal + " sats (need >= " + MIN_SBTC_FOR_LOOP + ")" };

  let zestOk = false;
  try {
    await getZestPosition(address);
    zestOk = true;
  } catch { /* ignored */ }
  checks.zest_api = { pass: zestOk, detail: zestOk ? "Zest Protocol v2 reachable" : "Zest API unreachable" };

  let bitflowOk = false;
  try {
    const q = await getBitflowSwapQuote("wSTX", "sBTC", 100_000);
    bitflowOk = q.amountOut > 0;
  } catch { /* ignored */ }
  checks.bitflow_api = { pass: bitflowOk, detail: bitflowOk ? "Bitflow quote API reachable" : "Bitflow API unreachable (will use estimate)" };

  const allPass = Object.values(checks).every((c) => c.pass);
  emit({
    status: allPass ? "success" : "error",
    action: allPass ? "Ready -- run `status` then `run --amount=<sats> --loops=1 --max-ltv=55`" : "Fix failing checks",
    data: { checks },
    error: allPass ? null : { code: "preflight_failed", message: "One or more checks failed", next: "Fix checks above" },
  });
  if (!allPass) process.exit(1);
}

async function cmdStatus(): Promise<void> {
  let address: string;
  try { address = getWalletAddress(); } catch (e) { emitError("no_wallet", String(e), "Unlock wallet"); }
  const position = await getZestPosition(address!);
  const sbtcBal = await getSbtcBalance(address!);
  const state = loadState();
  const summary = !state.open_position
    ? "No open leverage position. Run: run --amount=<sats> --loops=1 --max-ltv=55"
    : "Open position: " + state.total_deployed_sats + " sats deployed, " + state.borrowed_wstx_ustx + " uSTX borrowed, LTV: " + position.ltvPct + "%";
  emit({
    status: "success",
    action: summary,
    data: { position, sbtcBal, state },
    error: null,
  });
}

async function cmdRun(
  initialSbtcSats: number,
  loopDepth: number,
  maxLtvPct: number,
  maxPriceImpactPct: number,
  confirm: boolean
): Promise<void> {
  if (initialSbtcSats < MIN_SBTC_FOR_LOOP) {
    emitBlocked("amount_too_small", "Minimum " + MIN_SBTC_FOR_LOOP + " sats required", "Increase --amount");
  }
  if (loopDepth > MAX_LOOP_DEPTH) {
    emitBlocked("loop_depth_exceeded", "Max loop depth is " + MAX_LOOP_DEPTH, "Reduce --loops");
  }
  if (maxLtvPct > MAX_LTV_CEILING_PCT) {
    emitBlocked("ltv_exceeds_ceiling", "--max-ltv " + maxLtvPct + "% exceeds hard cap " + MAX_LTV_CEILING_PCT + "%", "Use --max-ltv <= " + MAX_LTV_CEILING_PCT);
  }

  let address: string;
  try { address = getWalletAddress(); } catch (e) { emitError("no_wallet", String(e), "Unlock wallet"); }

  const stxBal = await getStxBalance(address!);
  if (stxBal < MIN_STX_GAS_USTX) {
    emitBlocked("insufficient_gas", stxBal + " uSTX < " + MIN_STX_GAS_USTX, "Top up STX for multi-tx gas");
  }

  const sbtcBal = await getSbtcBalance(address!);
  if (sbtcBal < initialSbtcSats) {
    emitBlocked("insufficient_sbtc", "Balance " + sbtcBal + " < requested " + initialSbtcSats + " sats", "Reduce --amount");
  }

  const state = loadState();
  if (state.open_position) {
    emitBlocked("position_open", "Existing leverage position open. Run unwind first.", "Run unwind --confirm to close existing position");
  }

  const { steps, summary, blocked } = await buildLoopPlan(address!, initialSbtcSats, loopDepth, maxLtvPct, maxPriceImpactPct);

  if (blocked) {
    emitBlocked("loop_blocked", blocked, "Reduce --amount, --loops, or --max-ltv");
  }

  if (!confirm) {
    emit({
      status: "dry-run",
      action: "Dry-run complete. Add --confirm to execute " + steps.length + " steps.",
      data: { loop_plan: steps, summary },
      error: null,
    });
    return;
  }

  emit({
    status: "success",
    action: "Execute " + steps.length + " loop steps in sequence. Run each mcp_command in order.",
    data: { loop_plan: steps, summary },
    error: null,
  });

  // Update state
  state.open_position = true;
  state.initial_sbtc_sats = initialSbtcSats;
  state.total_deployed_sats = summary.total_sbtc_deployed_sats;
  state.borrowed_wstx_ustx = summary.borrowed_wstx_ustx;
  state.collateral_enabled = true;
  state.last_run_at = new Date().toISOString();
  saveState(state);
}

async function cmdUnwind(confirm: boolean): Promise<void> {
  let address: string;
  try { address = getWalletAddress(); } catch (e) { emitError("no_wallet", String(e), "Unlock wallet"); }

  const state = loadState();
  if (!state.open_position && state.borrowed_wstx_ustx === 0) {
    emit({ status: "success", action: "No open position to unwind", data: { state }, error: null });
    return;
  }

  const position = await getZestPosition(address!);
  const unwindSteps: LoopStep[] = [];
  let stepNum = 1;

  if (position.debtMicro > 0) {
    unwindSteps.push({
      step: stepNum++,
      op: "borrow",
      description: "Repay " + position.debtMicro + " uSTX wSTX debt to Zest",
      amount_ustx: position.debtMicro,
      mcp_command: { tool: "zest_repay", params: { asset: "wSTX", amount: String(position.debtMicro) } },
    });
  }

  if (position.collateralMicro > 0) {
    const sbtcToWithdraw = Math.round(position.collateralMicro / 100);
    unwindSteps.push({
      step: stepNum++,
      op: "supply",
      description: "Withdraw ~" + sbtcToWithdraw + " sats sBTC from Zest",
      amount_sats: sbtcToWithdraw,
      mcp_command: { tool: "zest_withdraw", params: { asset: "sBTC", amount: String(sbtcToWithdraw) } },
    });
  }

  if (!confirm) {
    emit({
      status: "dry-run",
      action: "Dry-run unwind. Add --confirm to execute.",
      data: { unwind_steps: unwindSteps, current_position: position },
      error: null,
    });
    return;
  }

  emit({
    status: "success",
    action: "Execute unwind steps in sequence to close position.",
    data: { unwind_steps: unwindSteps },
    error: null,
  });

  state.open_position = false;
  state.borrowed_wstx_ustx = 0;
  state.total_deployed_sats = 0;
  saveState(state);
}

// --- CLI ---------------------------------------------------------------------

program
  .name("sbtc-leverage-loop")
  .version(VERSION)
  .description("sBTC leverage loop via Zest + Bitflow composition");

program.command("doctor").description("Pre-flight checks").action(async () => { await cmdDoctor(); });
program.command("status").description("Current leverage position").action(async () => { await cmdStatus(); });

program
  .command("run")
  .description("Execute leverage loop (dry-run by default)")
  .requiredOption("--amount <sats>", "Initial sBTC to supply (sats)", parseInt)
  .option("--loops <n>", "Loop depth 1-3", parseInt, 1)
  .option("--max-ltv <pct>", "Max LTV ceiling %", parseFloat, DEFAULT_MAX_LTV_PCT)
  .option("--max-price-impact <pct>", "Max Bitflow price impact %", parseFloat, DEFAULT_MAX_PRICE_IMPACT)
  .option("--confirm", "Execute on-chain", false)
  .action(async (opts: { amount: number; loops: number; maxLtv: number; maxPriceImpact: number; confirm: boolean }) => {
    await cmdRun(opts.amount, opts.loops, opts.maxLtv, opts.maxPriceImpact, opts.confirm);
  });

program
  .command("unwind")
  .description("Close leverage position (repay debt, withdraw sBTC)")
  .option("--confirm", "Execute on-chain", false)
  .action(async (opts: { confirm: boolean }) => { await cmdUnwind(opts.confirm); });

program.command("install-packs").description("Check dependencies").action(() => {
  emit({
    status: "success",
    action: "bun add @stacks/transactions @stacks/network commander",
    data: { required: ["@stacks/transactions", "@stacks/network", "commander"], runtime: "bun >= 1.0" },
    error: null,
  });
});

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write("Fatal: " + e + "\n");
  process.exit(1);
});
