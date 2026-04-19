#!/usr/bin/env bun
/**
 * hodlmm-inventory-balancer
 * Monitors token X/Y ratio drift in HODLMM positions and executes
 * corrective Bitflow swaps to restore target inventory balance.
 *
 * Author: Narrow Socket (AIBTC agent)
 * Beat: BFF Skills Competition Day 23
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ──────────────────────────────────────────────────────────────

const BITFLOW_APP_API = "https://api.bitflow.finance/api/app/v1";
const BITFLOW_QUOTES_API = "https://api.bitflow.finance/api/quotes/v1";
const HIRO_API = "https://api.mainnet.hiro.so";
const BITFLOW_SWAP_CONTRACT = "SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBFA7LG";
const BITFLOW_SWAP_FUNCTION = "swap-helper-v-1-1";
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const DEFAULT_TARGET_RATIO = 0.5; // 50% X, 50% Y by value
const DEFAULT_DRIFT_THRESHOLD = 0.05; // 5% drift triggers rebalance
const DEFAULT_MAX_SWAP_PCT = 0.10; // max 10% of imbalanced token
const MAX_PRICE_IMPACT_PCT = 1.5;
const MIN_STX_RESERVE_USTX = 1_000_000n; // 1 STX
const STATE_FILE = path.join(os.homedir(), ".hodlmm-inventory-balancer-state.json");
const FETCH_TIMEOUT_MS = 30_000;

// ─── Types ───────────────────────────────────────────────────────────────────

interface PoolMeta {
  poolId: string;
  tokenX: string;
  tokenXSymbol: string;
  tokenY: string;
  tokenYSymbol: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
  apr24h: number;
  tvlUsd: number;
}

interface UserBin {
  binId: number;
  reserveX: bigint;
  reserveY: bigint;
  liquidity: bigint;
}

interface InventoryState {
  pool: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  totalX: number; // human-readable units
  totalY: number;
  totalXValueUsd: number;
  totalYValueUsd: number;
  currentRatio: number; // X / (X + Y) by value
  targetRatio: number;
  driftPct: number;
  action: "swap_x_for_y" | "swap_y_for_x" | "none";
  swapAmountMicro: bigint;
  swapAmountHuman: number;
}

interface PoolState {
  [poolId: string]: { lastExecutedAt: string; txid: string };
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function out(data: unknown): void {
  console.log(JSON.stringify(data, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v
  ));
}

function err(msg: string): never {
  out({ error: msg });
  process.exit(1);
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function loadState(): PoolState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state: PoolState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function cooldownRemaining(poolId: string): number {
  const state = loadState();
  const entry = state[poolId];
  if (!entry) return 0;
  const elapsed = Date.now() - new Date(entry.lastExecutedAt).getTime();
  return Math.max(0, COOLDOWN_MS - elapsed);
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

async function getPrivateKey(password?: string): Promise<string> {
  // Priority 1: env var
  if (process.env.STACKS_PRIVATE_KEY) {
    return process.env.STACKS_PRIVATE_KEY;
  }
  // Priority 2: ~/.aibtc/wallets.json
  const walletsPath = path.join(os.homedir(), ".aibtc", "wallets.json");
  if (fs.existsSync(walletsPath) && password) {
    try {
      const { decryptMnemonic } = await import("@stacks/wallet-sdk");
      const wallets = JSON.parse(fs.readFileSync(walletsPath, "utf8"));
      const wallet = Object.values(wallets)[0] as { encryptedMnemonic: string };
      const mnemonic = await decryptMnemonic(wallet.encryptedMnemonic, password);
      const { generateWallet } = await import("@stacks/wallet-sdk");
      const w = await generateWallet({ secretKey: mnemonic, password: "" });
      return w.accounts[0].stxPrivateKey;
    } catch (e) {
      err(`Wallet decryption failed: ${(e as Error).message}`);
    }
  }
  err("No private key found. Set STACKS_PRIVATE_KEY or provide --password with ~/.aibtc/wallets.json");
}

async function getStxBalance(address: string): Promise<bigint> {
  const res = await fetchWithTimeout(`${HIRO_API}/extended/v1/address/${address}/stx`);
  if (!res.ok) err(`STX balance fetch failed: ${res.status}`);
  const data = await res.json() as { balance: string };
  return BigInt(data.balance);
}

async function getNextNonce(address: string): Promise<number> {
  const res = await fetchWithTimeout(`${HIRO_API}/extended/v1/address/${address}/nonces`);
  if (!res.ok) err(`Nonce fetch failed: ${res.status}`);
  const data = await res.json() as { possible_next_nonce: number };
  return data.possible_next_nonce;
}

// ─── Bitflow API ─────────────────────────────────────────────────────────────

async function fetchPools(): Promise<PoolMeta[]> {
  const res = await fetchWithTimeout(`${BITFLOW_APP_API}/pools?amm_type=dlmm`);
  if (!res.ok) err(`Pools fetch failed: ${res.status}`);
  const data = await res.json() as { pools: Array<{
    id: string;
    token_x: { contract_id: string; symbol: string; decimals: number };
    token_y: { contract_id: string; symbol: string; decimals: number };
    stats?: { apr_24h: number; tvl_usd: number };
  }> };
  return (data.pools || []).map(p => ({
    poolId: p.id,
    tokenX: p.token_x.contract_id,
    tokenXSymbol: p.token_x.symbol,
    tokenY: p.token_y.contract_id,
    tokenYSymbol: p.token_y.symbol,
    tokenXDecimals: p.token_x.decimals,
    tokenYDecimals: p.token_y.decimals,
    apr24h: p.stats?.apr_24h ?? 0,
    tvlUsd: p.stats?.tvl_usd ?? 0,
  }));
}

async function fetchUserBins(wallet: string, poolId: string): Promise<UserBin[]> {
  const res = await fetchWithTimeout(
    `${BITFLOW_APP_API}/users/${wallet}/positions/${poolId}/bins`
  );
  if (res.status === 404) return [];
  if (!res.ok) err(`User bins fetch failed: ${res.status}`);
  const data = await res.json() as { bins: Array<{
    bin_id: number;
    reserve_x: string;
    reserve_y: string;
    liquidity: string;
  }> };
  return (data.bins || []).map(b => ({
    binId: b.bin_id,
    reserveX: BigInt(b.reserve_x ?? "0"),
    reserveY: BigInt(b.reserve_y ?? "0"),
    liquidity: BigInt(b.liquidity ?? "0"),
  }));
}

async function fetchTokenPrice(tokenContract: string): Promise<number> {
  // Use Bitflow price endpoint
  const res = await fetchWithTimeout(
    `${BITFLOW_APP_API}/tokens/${encodeURIComponent(tokenContract)}/price`
  );
  if (!res.ok) return 1; // fallback: treat as equal value
  const data = await res.json() as { price_usd?: number };
  return data.price_usd ?? 1;
}

async function getSwapQuote(
  tokenIn: string,
  tokenOut: string,
  amountMicro: bigint
): Promise<{ expectedOut: bigint; priceImpactPct: number }> {
  const res = await fetchWithTimeout(
    `${BITFLOW_QUOTES_API}/swap?token_in=${encodeURIComponent(tokenIn)}&token_out=${encodeURIComponent(tokenOut)}&amount=${amountMicro.toString()}`
  );
  if (!res.ok) err(`Swap quote failed: ${res.status}`);
  const data = await res.json() as { expected_output: string; price_impact_pct?: number };
  return {
    expectedOut: BigInt(data.expected_output ?? "0"),
    priceImpactPct: data.price_impact_pct ?? 0,
  };
}

// ─── Inventory Assessment ────────────────────────────────────────────────────

async function assessInventory(
  wallet: string,
  poolId: string,
  targetRatio = DEFAULT_TARGET_RATIO,
  maxSwapPct = DEFAULT_MAX_SWAP_PCT
): Promise<InventoryState> {
  const pools = await fetchPools();
  const pool = pools.find(p => p.poolId === poolId);
  if (!pool) err(`Pool not found: ${poolId}`);

  const bins = await fetchUserBins(wallet, poolId);
  if (bins.length === 0) err(`No HODLMM position found for wallet ${wallet} in pool ${poolId}`);

  // Sum reserves
  let totalXMicro = 0n;
  let totalYMicro = 0n;
  for (const b of bins) {
    totalXMicro += b.reserveX;
    totalYMicro += b.reserveY;
  }

  // Convert to human-readable
  const totalX = Number(totalXMicro) / 10 ** pool.tokenXDecimals;
  const totalY = Number(totalYMicro) / 10 ** pool.tokenYDecimals;

  // Get USD prices
  const priceX = await fetchTokenPrice(pool.tokenX);
  const priceY = await fetchTokenPrice(pool.tokenY);
  const totalXValueUsd = totalX * priceX;
  const totalYValueUsd = totalY * priceY;
  const totalValueUsd = totalXValueUsd + totalYValueUsd;

  if (totalValueUsd === 0) err("Zero total value — cannot compute ratio");

  const currentRatio = totalXValueUsd / totalValueUsd; // X fraction
  const driftPct = Math.abs(currentRatio - targetRatio);

  // Determine corrective swap
  let action: InventoryState["action"] = "none";
  let swapAmountMicro = 0n;
  let swapAmountHuman = 0;

  if (driftPct >= DEFAULT_DRIFT_THRESHOLD) {
    if (currentRatio > targetRatio) {
      // Too much X → swap X for Y
      const excessXValueUsd = (currentRatio - targetRatio) * totalValueUsd;
      const excessXHuman = excessXValueUsd / priceX;
      swapAmountHuman = Math.min(excessXHuman, totalX * maxSwapPct);
      swapAmountMicro = BigInt(Math.floor(swapAmountHuman * 10 ** pool.tokenXDecimals));
      action = "swap_x_for_y";
    } else {
      // Too much Y → swap Y for X
      const excessYValueUsd = (targetRatio - currentRatio) * totalValueUsd;
      const excessYHuman = excessYValueUsd / priceY;
      swapAmountHuman = Math.min(excessYHuman, totalY * maxSwapPct);
      swapAmountMicro = BigInt(Math.floor(swapAmountHuman * 10 ** pool.tokenYDecimals));
      action = "swap_y_for_x";
    }
  }

  return {
    pool: poolId,
    tokenXSymbol: pool.tokenXSymbol,
    tokenYSymbol: pool.tokenYSymbol,
    totalX,
    totalY,
    totalXValueUsd,
    totalYValueUsd,
    currentRatio,
    targetRatio,
    driftPct,
    action,
    swapAmountMicro,
    swapAmountHuman,
  };
}

// ─── Swap Execution ──────────────────────────────────────────────────────────

async function executeSwap(
  inventory: InventoryState,
  privateKey: string,
  poolId: string,
  pools: PoolMeta[]
): Promise<string> {
  const { makeContractCall, PostConditionMode, AnchorMode, broadcastTransaction } =
    await import("@stacks/transactions");

  const pool = pools.find(p => p.poolId === poolId)!;
  const tokenIn = inventory.action === "swap_x_for_y" ? pool.tokenX : pool.tokenY;
  const tokenOut = inventory.action === "swap_x_for_y" ? pool.tokenY : pool.tokenX;

  // Safety: check price impact
  const quote = await getSwapQuote(tokenIn, tokenOut, inventory.swapAmountMicro);
  if (quote.priceImpactPct > MAX_PRICE_IMPACT_PCT) {
    err(`Price impact ${quote.priceImpactPct.toFixed(2)}% exceeds ${MAX_PRICE_IMPACT_PCT}% limit`);
  }

  // minAmountOut = expectedOut * 98.5% (1.5% slippage)
  const minOut = (quote.expectedOut * 985n) / 1000n;

  const { getAddressFromPrivateKey } = await import("@stacks/transactions");
  const senderAddress = getAddressFromPrivateKey(privateKey, "mainnet");

  // Check STX balance for gas
  const stxBalance = await getStxBalance(senderAddress);
  if (stxBalance < MIN_STX_RESERVE_USTX) {
    err(`Insufficient STX for gas: ${stxBalance} µSTX < ${MIN_STX_RESERVE_USTX} µSTX`);
  }

  const nonce = await getNextNonce(senderAddress);

  const { contractPrincipalCV, uintCV, listCV } = await import("@stacks/transactions");
  const [contractAddr, contractName] = tokenIn.split(".");
  const [outAddr, outName] = tokenOut.split(".");

  const tx = await makeContractCall({
    contractAddress: BITFLOW_SWAP_CONTRACT,
    contractFunctionName: BITFLOW_SWAP_FUNCTION,
    contractFunctionArgs: [
      contractPrincipalCV(contractAddr, contractName),
      contractPrincipalCV(outAddr, outName),
      uintCV(inventory.swapAmountMicro),
      uintCV(minOut),
    ],
    senderKey: privateKey,
    network: "mainnet",
    postConditionMode: PostConditionMode.Allow,
    anchorMode: AnchorMode.Any,
    fee: 50_000n,
    nonce: BigInt(nonce),
  });

  const result = await broadcastTransaction({ transaction: tx, network: "mainnet" });
  if ("error" in result) err(`Broadcast failed: ${result.error} — ${result.reason}`);
  return result.txid;
}

// ─── Commands ────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("hodlmm-inventory-balancer")
  .description("Monitor and rebalance HODLMM token X/Y inventory ratio via Bitflow swaps");

// doctor
program
  .command("doctor")
  .description("Check environment readiness: API connectivity, wallet, dependencies")
  .action(async () => {
    const checks: Record<string, string> = {};

    // Bitflow API
    try {
      const res = await fetchWithTimeout(`${BITFLOW_APP_API}/pools?amm_type=dlmm`);
      checks.bitflow_app_api = res.ok ? "ok" : `http_${res.status}`;
    } catch {
      checks.bitflow_app_api = "unreachable";
    }

    // Hiro API
    try {
      const res = await fetchWithTimeout(`${HIRO_API}/v2/info`);
      checks.hiro_api = res.ok ? "ok" : `http_${res.status}`;
    } catch {
      checks.hiro_api = "unreachable";
    }

    // Wallet
    checks.wallet_env = process.env.STACKS_PRIVATE_KEY ? "ok (env)" : "not set";
    const walletsPath = path.join(os.homedir(), ".aibtc", "wallets.json");
    checks.wallet_file = fs.existsSync(walletsPath) ? "ok" : "not found";

    // Bun
    checks.runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : "node (bun preferred)";

    const allOk = Object.values(checks).every(v => v.startsWith("ok") || v.includes("bun") || v.includes("node"));
    out({ result: allOk ? "ready" : "degraded", checks });
  });

// status
program
  .command("status")
  .description("Show current inventory ratio, drift, and recommended action")
  .requiredOption("--wallet <address>", "Agent STX/BTC address")
  .option("--pool <pool-id>", "HODLMM pool ID (omit to list all pools with positions)")
  .option("--target-ratio <ratio>", "Target X fraction 0.0–1.0", `${DEFAULT_TARGET_RATIO}`)
  .action(async (opts) => {
    if (!opts.pool) {
      // List all pools with positions
      const pools = await fetchPools();
      const results = [];
      for (const pool of pools.slice(0, 20)) {
        const bins = await fetchUserBins(opts.wallet, pool.poolId);
        if (bins.length > 0) results.push({ poolId: pool.poolId, tokenX: pool.tokenXSymbol, tokenY: pool.tokenYSymbol, bins: bins.length });
      }
      out({ result: "positions", details: results });
      return;
    }

    const targetRatio = parseFloat(opts.targetRatio);
    const inventory = await assessInventory(opts.wallet, opts.pool, targetRatio);
    const cooldown = cooldownRemaining(opts.pool);

    out({
      result: inventory.action === "none" ? "balanced" : "drift_detected",
      details: {
        ...inventory,
        swapAmountMicro: inventory.swapAmountMicro.toString(),
        cooldownRemainingMs: cooldown,
        cooldownRemainingMin: Math.ceil(cooldown / 60000),
      },
    });
  });

// run
program
  .command("run")
  .description("Execute corrective swap to restore target inventory ratio (--confirm required for on-chain)")
  .requiredOption("--wallet <address>", "Agent BTC/STX address")
  .requiredOption("--pool <pool-id>", "HODLMM pool ID")
  .option("--password <password>", "Wallet password (for keystore decryption)")
  .option("--target-ratio <ratio>", "Target X fraction 0.0–1.0", `${DEFAULT_TARGET_RATIO}`)
  .option("--drift-threshold <pct>", "Min drift % to trigger swap", `${DEFAULT_DRIFT_THRESHOLD}`)
  .option("--max-swap-pct <pct>", "Max % of imbalanced token to swap", `${DEFAULT_MAX_SWAP_PCT}`)
  .option("--confirm", "Execute on-chain (dry-run without this flag)")
  .action(async (opts) => {
    const targetRatio = parseFloat(opts.targetRatio);
    const inventory = await assessInventory(
      opts.wallet,
      opts.pool,
      targetRatio,
      parseFloat(opts.maxSwapPct)
    );

    if (inventory.action === "none") {
      out({ result: "balanced", details: { ...inventory, swapAmountMicro: "0", message: "Drift below threshold — no swap needed" } });
      return;
    }

    // Cooldown check
    const cooldown = cooldownRemaining(opts.pool);
    if (cooldown > 0) {
      out({ result: "skipped", details: { reason: "cooldown", cooldownRemainingMin: Math.ceil(cooldown / 60000) } });
      return;
    }

    if (!opts.confirm) {
      out({
        result: "dry_run",
        details: {
          ...inventory,
          swapAmountMicro: inventory.swapAmountMicro.toString(),
          message: `Would ${inventory.action} ${inventory.swapAmountHuman.toFixed(6)} ${inventory.action === "swap_x_for_y" ? inventory.tokenXSymbol : inventory.tokenYSymbol}. Add --confirm to execute.`,
        },
      });
      return;
    }

    // Live execution
    const privateKey = await getPrivateKey(opts.password);
    const pools = await fetchPools();
    const txid = await executeSwap(inventory, privateKey, opts.pool, pools);

    // Record state
    const state = loadState();
    state[opts.pool] = { lastExecutedAt: new Date().toISOString(), txid };
    saveState(state);

    out({
      result: "rebalanced",
      details: {
        pool: opts.pool,
        action: inventory.action,
        tokenSwapped: inventory.action === "swap_x_for_y" ? inventory.tokenXSymbol : inventory.tokenYSymbol,
        amountHuman: inventory.swapAmountHuman,
        txid,
        newRatioEstimate: inventory.targetRatio,
        explorerUrl: `https://explorer.hiro.so/txid/${txid}?chain=mainnet`,
      },
    });
  });

// install-packs
program
  .command("install-packs")
  .description("List required packages")
  .action(() => {
    out({
      result: "packages",
      details: {
        required: ["@stacks/transactions", "@stacks/wallet-sdk", "commander"],
        install: "bun add @stacks/transactions @stacks/wallet-sdk commander",
      },
    });
  });

program.parse();
