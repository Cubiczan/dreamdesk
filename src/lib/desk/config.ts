// DreamDesk configuration — all knobs in one place.
// LIVE testnet trading activates only when DREAMDESK_PRIVATE_KEY is provided;
// otherwise the desk runs in PAPER mode against real market data.

export type DeskMode = "LIVE" | "PAPER";

export const DREAMDEX = {
  indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
  wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
  chainName: "Somnia Shannon Testnet",
  chainId: 50312,
  explorerUrl: "https://shannon-explorer.somnia.network",
  collateralToken: "tUSDC",
  collateralDecimals: 6,
} as const;

export const DESK = {
  name: "DreamDesk",
  tagline: "The auditable agent trading desk for dreamDEX Event Contracts",
  version: "1.0.0",
  // Decision loop cadence while a session is RUNNING (ms)
  cycleIntervalMs: 12_000,
  // LLM council convenes only when signal activity exceeds this (or forced)
  quorumActivityThreshold: 0.32,
  // Risk governor gates
  minConfidence: 0.6,
  maxOpenPositions: 3,
  perTradeEquityShare: 0.05, // 5% of equity per trade
  sessionLossLimit: -15, // stop trading after -15 tUSDC realized
  cooldownMs: 20_000, // min gap between executions
  minExpiryHeadroomSec: 120, // skip markets expiring sooner than this
  minEdgeProb: 0.08, // require |modelProb - marketProb| edge
  // CHP Profile B capital-gate policy (overridable via CHP_MAX_NOTIONAL /
  // CHP_DAILY_CAP / CHP_HITL_THRESHOLD env vars — see lib/desk/chp.ts)
  chpMaxNotional: 500, // hard per-trade notional cap
  chpDailyCap: 2500, // hard daily committed-notional cap
  chpHitlThreshold: 250, // notional at or above this requires a human countersign
  paperSlippage: 0.01, // paper fills cross the touch by this
  sentimentCacheMs: 10 * 60_000, // sentiment agent refresh window
  priceHistoryLimit: 600, // ticks kept per asset for indicators
} as const;

// CHP knobs — the gate-only Consensus Hardening Protocol layer.
export const CHP = {
  // Domain for foundation scoring: DeFi event contracts gate at CHP's
  // blockchain/DeFi floor of 85 (of 100: guardrails 40 + bounded 30 + parity 30).
  foundationDomain: "defi",
  // Human lock enforcement: when ON (default), LIVE execution requires the
  // session to reach LOCKED (explicit PROVISIONAL_LOCK, then a named
  // confirmer). PAPER sessions are exploration and stay exempt.
  requireHumanLockDefault: true,
} as const;

export function chpRequireHumanLock(): boolean {
  const raw = process.env.DREAMDESK_CHP_REQUIRE_HUMAN_LOCK;
  if (raw == null || raw.trim() === "") return CHP.requireHumanLockDefault;
  return !/^(0|false|off)$/i.test(raw.trim());
}

/** Ledger path — gitignored state tree by default; env override for deployments and tests. */
export function chpLedgerPath(): string {
  return process.env.DREAMDESK_CHP_LEDGER_PATH?.trim() || "state/chp-decisions.jsonl";
}

export function deskPrivateKey(): string | null {
  const key = process.env.DREAMDESK_PRIVATE_KEY;
  if (!key || key.length < 64) return null;
  return key.startsWith("0x") ? key : `0x${key}`;
}

export function resolveMode(): { mode: DeskMode; reason: string } {
  if (deskPrivateKey()) {
    return { mode: "LIVE", reason: "Desk wallet configured — orders route to dreamDEX testnet" };
  }
  return {
    mode: "PAPER",
    reason: "No DREAMDESK_PRIVATE_KEY set — simulating fills on real testnet market data",
  };
}
