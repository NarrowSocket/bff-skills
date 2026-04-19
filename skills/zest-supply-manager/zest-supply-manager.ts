#!/usr/bin/env bun
/**
 * zest-supply-manager — Supply-side Zest Protocol manager
 * Deposit sBTC/wSTX/stSTX to Zest, withdraw, track yield.
 *
 * Commands: doctor | status | supply | withdraw | install-packs
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const ZEST_API_BASE = "https://api.zestprotocol.com";
const ZEST_MARKET_CONTRACT = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market";
const MIN_STX_GAS_USTX = 100_000; // 0.1 STX minimum reserved for gas

const SUPPORTED_ASSETS = ["sBTC", "wSTX", "stSTX"] as const;
type SupportedAsset = (typeof SUPPORTED_ASSETS)[number];

// Zest reserve/aToken contract addresses (Stacks mainnet)
const ASSET_CONFIGS: Record<SupportedAsset, {
  token: string;
  aToken: string;
  decimals: number;
  unit: string;
}> = {
  sBTC: {
    token: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ.sbtc-token",
    aToken: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.pool-vault",
    decimals: 8,
    unit: "sats",
  },
  wSTX: {
    token: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx",
    aToken: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.pool-vault",
    decimals: 6,
    unit: "uSTX",
  },
  stSTX: {
    token: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",
    aToken: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.pool-vault",
    decimals: 6,
    unit: "uSTX",
  },
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface SkillResult {
  status: "success" | "dry-run" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: string | null;
}

interface ZestReserveData {
  asset: string;
  liquidityRate: string; // supply APY as decimal string
  totalLiquidity: string;
  utilizationRate: string;
}

interface WalletInfo {
  stx_address: string;
  btc_address: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function out(result: SkillResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function err(message: string, data: Record<string, unknown> = {}): void {
  out({ status: "error", action: "Fix error before retrying", data, error: message });
  process.exit(1);
}

async function fetchJson(url: string, opts?: RequestInit): Promise<unknown> {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function fmtAmount(amount: number, asset: SupportedAsset): string {
  const { unit } = ASSET_CONFIGS[asset];
  return `${amount.toLocaleString()} ${unit}`;
}

// ─── Zest API ────────────────────────────────────────────────────────────────

async function fetchZestReserves(): Promise<ZestReserveData[]> {
  try {
    const data = await fetchJson(`${ZEST_API_BASE}/api/v2/markets`) as { reserves?: ZestReserveData[] };
    return data.reserves ?? [];
  } catch {
    return [];
  }
}

async function fetchZestUserData(stxAddress: string): Promise<Record<string, unknown>> {
  try {
    return await fetchJson(`${ZEST_API_BASE}/api/v2/user/${stxAddress}`) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function getStxBalance(stxAddress: string): Promise<number> {
  try {
    const data = await fetchJson(
      `https://api.mainnet.hiro.so/v2/accounts/${stxAddress}?proof=0`
    ) as { balance: string };
    return parseInt(data.balance, 16);
  } catch {
    return 0;
  }
}

async function getSbtcBalance(stxAddress: string): Promise<number> {
  try {
    const data = await fetchJson(
      `https://api.mainnet.hiro.so/v2/contracts/interface/SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ/sbtc-token`
    ) as unknown;
    void data; // type hint only
    // Use token balance endpoint
    const balRes = await fetchJson(
      `https://api.mainnet.hiro.so/extended/v1/address/${stxAddress}/balances`
    ) as { fungible_tokens?: Record<string, { balance: string }> };
    const sbtcKey = Object.keys(balRes.fungible_tokens ?? {}).find(k =>
      k.includes("sbtc-token")
    );
    if (!sbtcKey) return 0;
    return parseInt(balRes.fungible_tokens![sbtcKey].balance, 10);
  } catch {
    return 0;
  }
}

async function getWalletInfo(): Promise<WalletInfo | null> {
  // Read from CLAUDE.md or env — hardcoded for this agent
  return {
    stx_address: "SP3DWEB288XW3NJSDJ0SXK256Y5S53ZXKNY0FRHQK",
    btc_address: "bc1q0l4j6fnlpz028xp889ywrrvxguqu86y4ssw3av",
  };
}

// ─── MCP Command Builders ────────────────────────────────────────────────────

function buildSupplyCommand(asset: SupportedAsset, amount: number): Record<string, unknown> {
  return {
    tool: "zest_supply",
    params: {
      asset,
      amount,
      contract: ZEST_MARKET_CONTRACT,
    },
  };
}

function buildWithdrawCommand(asset: SupportedAsset, amount: number): Record<string, unknown> {
  return {
    tool: "zest_withdraw",
    params: {
      asset,
      amount,
      contract: ZEST_MARKET_CONTRACT,
    },
  };
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, string> = {};

  // 1. Wallet
  const wallet = await getWalletInfo();
  if (!wallet) { err("Wallet not configured"); return; }
  checks.wallet = "ok";

  // 2. STX gas balance
  const stxBal = await getStxBalance(wallet.stx_address);
  checks.stx_gas = stxBal >= MIN_STX_GAS_USTX
    ? `ok (${stxBal} uSTX)`
    : `LOW (${stxBal} uSTX — need ${MIN_STX_GAS_USTX})`;

  // 3. sBTC balance
  const sbtcBal = await getSbtcBalance(wallet.stx_address);
  checks.sbtc_balance = `${sbtcBal} sats`;

  // 4. Zest API
  const reserves = await fetchZestReserves();
  checks.zest_api = reserves.length > 0 ? "ok" : "unreachable";

  const allOk = !Object.values(checks).some(v => v.startsWith("LOW") || v === "unreachable");
  out({
    status: allOk ? "success" : "blocked",
    action: allOk ? "Pre-flight passed — ready to supply/withdraw" : "Fix issues before proceeding",
    data: {
      stx_address: wallet.stx_address,
      checks,
    },
    error: null,
  });
}

async function cmdStatus(): Promise<void> {
  const wallet = await getWalletInfo();
  if (!wallet) { err("Wallet not configured"); return; }

  const [reserves, userData] = await Promise.all([
    fetchZestReserves(),
    fetchZestUserData(wallet.stx_address),
  ]);

  // Extract per-asset APY from reserves
  const apyByAsset: Record<string, number> = {};
  for (const r of reserves) {
    // liquidityRate is in ray units (1e27) or a decimal string depending on API version
    const rate = parseFloat(r.liquidityRate);
    // If > 1, it's ray format: convert to pct
    const apyPct = rate > 1 ? (rate / 1e27) * 100 : rate * 100;
    apyByAsset[r.asset] = Math.round(apyPct * 100) / 100;
  }

  // Extract user positions from userData
  const positions: Array<{
    asset: string;
    atoken_balance: number;
    yield_earned_approx: number;
    supply_apy_pct: number;
  }> = [];

  const userReserves = (userData as { reserves?: Array<{ asset: string; aTokenBalance?: string; scaledATokenBalance?: string }> }).reserves ?? [];
  for (const ur of userReserves) {
    const bal = parseInt((ur.aTokenBalance ?? ur.scaledATokenBalance ?? "0"), 10);
    if (bal > 0) {
      positions.push({
        asset: ur.asset,
        atoken_balance: bal,
        yield_earned_approx: 0, // requires historical data
        supply_apy_pct: apyByAsset[ur.asset] ?? 0,
      });
    }
  }

  out({
    status: "success",
    action: positions.length > 0
      ? `Active positions: ${positions.map(p => `${p.asset} (${p.atoken_balance})`).join(", ")}`
      : "No active supply positions. Use 'supply' to start earning.",
    data: {
      stx_address: wallet.stx_address,
      positions,
      market_apys: apyByAsset,
      zest_api_reachable: reserves.length > 0,
    },
    error: null,
  });
}

async function cmdSupply(asset: SupportedAsset, amount: number, confirm: boolean): Promise<void> {
  const wallet = await getWalletInfo();
  if (!wallet) { err("Wallet not configured"); return; }

  if (!SUPPORTED_ASSETS.includes(asset)) {
    err(`Unsupported asset: ${asset}. Supported: ${SUPPORTED_ASSETS.join(", ")}`);
    return;
  }

  if (amount <= 0) { err("--amount must be > 0"); return; }

  // Balance checks
  const stxBal = await getStxBalance(wallet.stx_address);
  if (stxBal < MIN_STX_GAS_USTX) {
    err(`Insufficient STX for gas: ${stxBal} uSTX (need ${MIN_STX_GAS_USTX})`);
    return;
  }

  if (asset === "sBTC") {
    const sbtcBal = await getSbtcBalance(wallet.stx_address);
    if (sbtcBal < amount) {
      err(`Insufficient sBTC: have ${sbtcBal} sats, need ${amount} sats`);
      return;
    }
  }

  const mcpCmd = buildSupplyCommand(asset, amount);

  if (!confirm) {
    out({
      status: "dry-run",
      action: `Supply ${fmtAmount(amount, asset)} to Zest — add --confirm to execute`,
      data: {
        asset,
        amount_base_units: amount,
        stx_address: wallet.stx_address,
        mcp_command: mcpCmd,
        estimated_gas_ustx: 5000,
      },
      error: null,
    });
    return;
  }

  out({
    status: "success",
    action: `Executing supply of ${fmtAmount(amount, asset)} to Zest`,
    data: {
      asset,
      amount_base_units: amount,
      stx_address: wallet.stx_address,
      mcp_command: mcpCmd,
    },
    error: null,
  });
}

async function cmdWithdraw(
  asset: SupportedAsset,
  amount: number | "all",
  confirm: boolean
): Promise<void> {
  const wallet = await getWalletInfo();
  if (!wallet) { err("Wallet not configured"); return; }

  if (!SUPPORTED_ASSETS.includes(asset)) {
    err(`Unsupported asset: ${asset}. Supported: ${SUPPORTED_ASSETS.join(", ")}`);
    return;
  }

  const stxBal = await getStxBalance(wallet.stx_address);
  if (stxBal < MIN_STX_GAS_USTX) {
    err(`Insufficient STX for gas: ${stxBal} uSTX (need ${MIN_STX_GAS_USTX})`);
    return;
  }

  // Resolve amount
  let withdrawAmount: number;
  if (amount === "all") {
    const userData = await fetchZestUserData(wallet.stx_address) as {
      reserves?: Array<{ asset: string; aTokenBalance?: string }>;
    };
    const userReserves = userData.reserves ?? [];
    const ur = userReserves.find(r => r.asset === asset);
    withdrawAmount = ur ? parseInt(ur.aTokenBalance ?? "0", 10) : 0;
    if (withdrawAmount === 0) {
      err(`No ${asset} supply position found to withdraw`);
      return;
    }
  } else {
    withdrawAmount = amount;
  }

  const mcpCmd = buildWithdrawCommand(asset, withdrawAmount);

  if (!confirm) {
    out({
      status: "dry-run",
      action: `Withdraw ${fmtAmount(withdrawAmount, asset)} from Zest — add --confirm to execute`,
      data: {
        asset,
        amount_base_units: withdrawAmount,
        withdraw_all: amount === "all",
        stx_address: wallet.stx_address,
        mcp_command: mcpCmd,
        estimated_gas_ustx: 5000,
      },
      error: null,
    });
    return;
  }

  out({
    status: "success",
    action: `Executing withdrawal of ${fmtAmount(withdrawAmount, asset)} from Zest`,
    data: {
      asset,
      amount_base_units: withdrawAmount,
      stx_address: wallet.stx_address,
      mcp_command: mcpCmd,
    },
    error: null,
  });
}

async function cmdInstallPacks(): Promise<void> {
  console.log("Installing zest-supply-manager dependencies...");
  const { spawnSync } = await import("child_process");
  const result = spawnSync("bun", ["add", "@zest-protocol/sdk", "@stacks/network", "@stacks/transactions"], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    err("bun add failed — ensure bun is installed and network is available");
    return;
  }
  out({
    status: "success",
    action: "Dependencies installed",
    data: { packages: ["@zest-protocol/sdk", "@stacks/network", "@stacks/transactions"] },
    error: null,
  });
}

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

function parseArgs(): {
  command: string;
  asset?: SupportedAsset;
  amount?: number;
  all?: boolean;
  confirm: boolean;
} {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  const getFlag = (flag: string): string | undefined =>
    args.find(a => a.startsWith(`--${flag}=`))?.split("=")[1];

  const hasFlag = (flag: string): boolean => args.includes(`--${flag}`);

  const rawAsset = getFlag("asset");
  const asset = SUPPORTED_ASSETS.includes(rawAsset as SupportedAsset)
    ? (rawAsset as SupportedAsset)
    : undefined;

  const rawAmount = getFlag("amount");
  const amount = rawAmount ? parseInt(rawAmount, 10) : undefined;
  const all = hasFlag("all");
  const confirm = hasFlag("confirm");

  return { command, asset, amount, all, confirm };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, asset, amount, all, confirm } = parseArgs();

  switch (command) {
    case "doctor":
      await cmdDoctor();
      break;

    case "status":
      await cmdStatus();
      break;

    case "supply": {
      if (!asset) { err("--asset required (sBTC, wSTX, or stSTX)"); return; }
      if (!amount || amount <= 0) { err("--amount required and must be > 0"); return; }
      await cmdSupply(asset, amount, confirm);
      break;
    }

    case "withdraw": {
      if (!asset) { err("--asset required (sBTC, wSTX, or stSTX)"); return; }
      if (!all && (!amount || amount <= 0)) {
        err("--amount required, or use --all to withdraw full position");
        return;
      }
      await cmdWithdraw(asset, all ? "all" : amount!, confirm);
      break;
    }

    case "install-packs":
      await cmdInstallPacks();
      break;

    default:
      console.log(`
zest-supply-manager — Zest Protocol supply-side manager

Commands:
  doctor                                    Pre-flight checks
  status                                    Show positions + yield
  supply --asset=<A> --amount=<N> [--confirm]
  withdraw --asset=<A> [--amount=<N>|--all] [--confirm]
  install-packs                             Install dependencies

Assets: sBTC | wSTX | stSTX
`);
  }
}

main().catch(e => {
  err(e instanceof Error ? e.message : String(e));
});
