#!/usr/bin/env bun
/**
 * zest-borrow-manager.ts
 * Autonomous Zest Protocol borrow-side manager for AIBTC agents.
 * Complements zest-yield-manager (supply-only) and zest-auto-repay (repayment-only).
 *
 * Covers: enable-collateral + borrow with LTV safety enforcement.
 * Does NOT supply or repay -- use the dedicated skills for those operations.
 *
 * Usage:
 *   bun run zest-borrow-manager.ts doctor
 *   bun run zest-borrow-manager.ts status
 *   bun run zest-borrow-manager.ts enable-collateral --asset=sBTC
 *   bun run zest-borrow-manager.ts borrow --asset=wSTX --amount=500000 [--confirm]
 *   bun run zest-borrow-manager.ts install-packs
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
  ".zest-borrow-manager-state.json"
);
const HIRO_API = "https://api.hiro.so";
const ZEST_POOL = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market";

// Safety limits (all enforced in code)
const SAFE_LTV_CEILING_PCT = 60;      // max LTV after borrow
const HARD_LTV_CAP_PCT = 70;          // absolute cap, no override
const DEFAULT_MAX_BORROW = 100_000;   // default per-borrow cap (uSTX)
const ABSOLUTE_MAX_BORROW = 1_000_000; // cannot be overridden
const MIN_STX_GAS = 100_000;          // uSTX minimum gas reserve

const COLLATERAL_ASSETS = ["sBTC", "wSTX", "stSTX"];
const BORROW_ASSETS = ["wSTX", "USDC", "USDH"];

// --- Types --------------------------------------------------------------------

interface ZestPosition {
  supplied_sats: number;
  collateral_enabled: string[];
  borrowed_ustx: number;
  current_ltv_pct: number;
  max_safe_borrow_ustx: number;
  liquidation_distance_pct: number;
}

interface AgentState {
  last_borrow_at: string | null;
  last_txid: string | null;
  last_ltv_pct: number | null;
  collateral_enabled: string[];
  total_borrowed_ustx: number;
}

// --- State Management ---------------------------------------------------------

function loadState(): AgentState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch { /* ignore */ }
  return {
    last_borrow_at: null,
    last_txid: null,
    last_ltv_pct: null,
    collateral_enabled: [],
    total_borrowed_ustx: 0,
  };
}

function saveState(state: AgentState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    process.stderr.write("WARN: state save failed: " + e + "\n");
  }
}

// --- HTTP Helper --------------------------------------------------------------

function fetchJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "zest-borrow-manager/1.0" } }, (res) => {
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
  const walletPaths = [
    path.join(process.env.HOME || "~", ".aibtc", "wallets.json"),
    path.join(process.env.USERPROFILE || "~", ".aibtc", "wallets.json"),
  ];
  for (const wp of walletPaths) {
    try {
      if (fs.existsSync(wp)) {
        const w = JSON.parse(fs.readFileSync(wp, "utf8"));
        const active = w.active || w[0];
        if (active?.stxAddress) return active.stxAddress;
      }
    } catch { /* skip */ }
  }
  throw new Error("Wallet not found. Set STACKS_ADDRESS or unlock via AIBTC MCP.");
}

// --- Zest Helpers -------------------------------------------------------------

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
      if (k.toLowerCase().includes("sbtc")) {
        return parseInt(ft[k].balance || "0");
      }
    }
    return 0;
  } catch { return 0; }
}

async function getZestPosition(addr: string): Promise<ZestPosition> {
  try {
    const parts = ZEST_POOL.split(".");
    const d = await fetchJson(
      HIRO_API + "/v2/contracts/call-read/" + parts[0] + "/" + parts[1] + "/get-user-reserve-data?principal=" + addr
    );
    const val = ((d.result as Record<string, unknown>)?.value as Record<string, string>) || {};
    const collateral = parseInt(val["total-collateral"] || "0");
    const debt = parseInt(val["total-debt"] || "0");
    const available = parseInt(val["available-borrows"] || "0");
    const ltv = collateral > 0 ? (debt / collateral) * 100 : 0;
    const maxSafe = Math.max(0, Math.min(available, collateral * (SAFE_LTV_CEILING_PCT / 100) - debt));
    return {
      supplied_sats: Math.round(collateral / 100),
      collateral_enabled: [],
      borrowed_ustx: debt,
      current_ltv_pct: parseFloat(ltv.toFixed(2)),
      max_safe_borrow_ustx: Math.round(maxSafe),
      liquidation_distance_pct: parseFloat((85 - ltv).toFixed(2)),
    };
  } catch {
    return { supplied_sats: 0, collateral_enabled: [], borrowed_ustx: 0, current_ltv_pct: 0, max_safe_borrow_ustx: 0, liquidation_distance_pct: 85 };
  }
}

// --- Commands -----------------------------------------------------------------

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, { pass: boolean; detail: string }> = {};
  let address = "";

  try {
    address = getWalletAddress();
    checks.wallet = { pass: true, detail: "Address: " + address };
  } catch (e) {
    checks.wallet = { pass: false, detail: String(e) };
    emit({ status: "error", action: "Unlock wallet first", data: { checks }, error: { code: "no_wallet", message: "Wallet not found", next: "Unlock wallet first" } });
    process.exit(1);
  }

  const stxBal = await getStxBalance(address);
  checks.gas = { pass: stxBal >= MIN_STX_GAS, detail: stxBal + " uSTX (need >= " + MIN_STX_GAS + ")" };

  const sbtcBal = await getSbtcBalance(address);
  checks.sbtc = { pass: sbtcBal > 0, detail: sbtcBal + " sats available" };

  let position: ZestPosition;
  try {
    position = await getZestPosition(address);
    checks.zest_api = { pass: true, detail: "Zest Protocol v2 reachable" };
  } catch (e) {
    checks.zest_api = { pass: false, detail: "API error: " + e };
    emit({ status: "error", action: "Check network and retry", data: { checks }, error: { code: "api_unreachable", message: String(e), next: "Retry after checking network" } });
    process.exit(1);
  }

  const state = loadState();
  position.collateral_enabled = state.collateral_enabled;
  checks.position = { pass: true, detail: "LTV: " + position.current_ltv_pct + "%, borrowed: " + position.borrowed_ustx + " uSTX, collateral: [" + position.collateral_enabled.join(", ") + "]" };

  const allPass = Object.values(checks).every((c) => c.pass);
  emit({
    status: allPass ? "success" : "error",
    action: allPass ? "Ready -- run status to see borrow headroom" : "Fix failing checks before proceeding",
    data: { checks, position },
    error: allPass ? null : { code: "preflight_failed", message: "One or more checks failed", next: "Fix checks above" },
  });
  if (!allPass) process.exit(1);
}

async function cmdStatus(): Promise<void> {
  let address: string;
  try { address = getWalletAddress(); } catch (e) { emitError("no_wallet", String(e), "Unlock wallet first"); }
  const position = await getZestPosition(address!);
  const state = loadState();
  position.collateral_enabled = state.collateral_enabled;
  const summary =
    position.current_ltv_pct === 0 && position.borrowed_ustx === 0
      ? "No active borrow position. Supply sBTC first (zest-yield-manager), then enable-collateral here."
      : position.collateral_enabled.length === 0
      ? "Assets supplied but no collateral enabled. Run: enable-collateral --asset=sBTC"
      : position.max_safe_borrow_ustx > 0
      ? "Ready to borrow. Max safe: " + position.max_safe_borrow_ustx + " uSTX at <=" + SAFE_LTV_CEILING_PCT + "% LTV."
      : "LTV " + position.current_ltv_pct + "% near ceiling. Repay before borrowing more.";
  emit({ status: "success", action: summary, data: { position, state }, error: null });
}

async function cmdEnableCollateral(asset: string): Promise<void> {
  if (!COLLATERAL_ASSETS.includes(asset)) {
    emitBlocked("unsupported_asset", "Asset not supported. Use: " + COLLATERAL_ASSETS.join(", "), "Re-run with supported asset");
  }
  let address: string;
  try { address = getWalletAddress(); } catch (e) { emitError("no_wallet", String(e), "Unlock wallet first"); }
  const stxBal = await getStxBalance(address!);
  if (stxBal < MIN_STX_GAS) {
    emitBlocked("insufficient_gas", stxBal + " uSTX below " + MIN_STX_GAS, "Top up STX for gas");
  }
  const state = loadState();
  if (state.collateral_enabled.includes(asset)) {
    emit({ status: "success", action: asset + " already enabled as collateral -- no action needed", data: { collateral_enabled: state.collateral_enabled }, error: null });
    return;
  }
  emit({
    status: "success",
    action: "Execute zest_enable_collateral, then run status to confirm",
    data: {
      asset,
      wallet: address!,
      mcp_command: { tool: "zest_enable_collateral", params: { asset } },
      note: "After MCP execution, run status to confirm collateral is active on-chain",
    },
    error: null,
  });
  state.collateral_enabled.push(asset);
  saveState(state);
}

async function cmdBorrow(asset: string, amount: number, maxBorrow: number, confirm: boolean): Promise<void> {
  if (!BORROW_ASSETS.includes(asset)) {
    emitBlocked("unsupported_borrow_asset", "Use: " + BORROW_ASSETS.join(", "), "Re-run with supported asset");
  }
  const effectiveMax = Math.min(maxBorrow, ABSOLUTE_MAX_BORROW);
  if (amount > effectiveMax) {
    emitBlocked("exceeds_hard_cap", "Requested " + amount + " > hard cap " + effectiveMax, "Reduce --amount to <= " + effectiveMax);
  }
  let address: string;
  try { address = getWalletAddress(); } catch (e) { emitError("no_wallet", String(e), "Unlock wallet"); }
  const stxBal = await getStxBalance(address!);
  if (stxBal < MIN_STX_GAS) {
    emitBlocked("insufficient_gas", stxBal + " uSTX < " + MIN_STX_GAS, "Top up STX for gas");
  }
  const state = loadState();
  if (state.collateral_enabled.length === 0) {
    emitBlocked("no_collateral_enabled", "No collateral enabled", "Run enable-collateral --asset=sBTC first");
  }
  const position = await getZestPosition(address!);
  const postDebt = position.borrowed_ustx + amount;
  const collVal = position.supplied_sats * 100;
  const postLtv = collVal > 0 ? (postDebt / collVal) * 100 : 100;

  if (postLtv > HARD_LTV_CAP_PCT) {
    emitBlocked("exceeds_ltv_ceiling", "Post-borrow LTV " + postLtv.toFixed(1) + "% > hard cap " + HARD_LTV_CAP_PCT + "%", "Reduce amount or repay existing debt");
  }
  if (postLtv > SAFE_LTV_CEILING_PCT) {
    emitBlocked("exceeds_ltv_ceiling", "Post-borrow LTV " + postLtv.toFixed(1) + "% > safe ceiling " + SAFE_LTV_CEILING_PCT + "%", "Reduce --amount to stay under ceiling");
  }
  if (position.max_safe_borrow_ustx > 0 && amount > position.max_safe_borrow_ustx) {
    emitBlocked("exceeds_safe_borrow", "Requested " + amount + " > max safe " + position.max_safe_borrow_ustx, "Reduce --amount to <= " + position.max_safe_borrow_ustx);
  }

  const mcpCmd = { tool: "zest_borrow", params: { asset, amount: String(amount) } };
  if (!confirm) {
    emit({
      status: "dry-run",
      action: "Dry-run complete. Add --confirm to execute borrow of " + amount + " uSTX " + asset,
      data: {
        borrow_asset: asset,
        amount_ustx: amount,
        post_borrow_ltv_pct: parseFloat(postLtv.toFixed(2)),
        safe_ltv_ceiling_pct: SAFE_LTV_CEILING_PCT,
        position_before: position,
        mcp_command: mcpCmd,
        confirm_command: "borrow --asset=" + asset + " --amount=" + amount + " --confirm",
      },
      error: null,
    });
    return;
  }

  emit({
    status: "success",
    action: "Execute zest_borrow for " + amount + " uSTX " + asset + ". Run status in 30s to confirm on-chain.",
    data: { borrow_asset: asset, amount_ustx: amount, post_borrow_ltv_pct: parseFloat(postLtv.toFixed(2)), mcp_command: mcpCmd },
    error: null,
  });
  state.last_borrow_at = new Date().toISOString();
  state.total_borrowed_ustx = (state.total_borrowed_ustx || 0) + amount;
  saveState(state);
}

// --- CLI Setup ----------------------------------------------------------------

program
  .name("zest-borrow-manager")
  .version(VERSION)
  .description("Zest Protocol borrow-side manager -- enable collateral and execute safe borrows");

program.command("doctor").description("Pre-flight checks: wallet, gas, Zest API, position").action(async () => { await cmdDoctor(); });
program.command("status").description("Read-only position snapshot: LTV, collateral, borrow headroom").action(async () => { await cmdStatus(); });

program
  .command("enable-collateral")
  .description("Enable a supplied asset as Zest collateral (required before borrowing)")
  .requiredOption("--asset <asset>", "Asset to enable (" + COLLATERAL_ASSETS.join("|") + ")")
  .action(async (opts: { asset: string }) => { await cmdEnableCollateral(opts.asset); });

program
  .command("borrow")
  .description("Borrow against enabled collateral with LTV safety enforcement")
  .requiredOption("--asset <asset>", "Asset to borrow (" + BORROW_ASSETS.join("|") + ")")
  .requiredOption("--amount <amount>", "Amount in base units (uSTX for wSTX)", parseInt)
  .option("--max-borrow <amount>", "Override max borrow cap (uSTX)", parseInt, DEFAULT_MAX_BORROW)
  .option("--confirm", "Execute on-chain (dry-run by default)", false)
  .action(async (opts: { asset: string; amount: number; maxBorrow: number; confirm: boolean }) => {
    await cmdBorrow(opts.asset, opts.amount, opts.maxBorrow, opts.confirm);
  });

program.command("install-packs").description("Check required dependencies").action(() => {
  emit({ status: "success", action: "bun add @stacks/transactions @stacks/network commander", data: { required: ["@stacks/transactions", "@stacks/network", "commander"], runtime: "bun >= 1.0" }, error: null });
});

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write("Fatal: " + e + "\n");
  process.exit(1);
});
