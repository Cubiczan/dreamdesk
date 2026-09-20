// Trading-loop integration: the CHP gate sits between the risk governor and
// the executor inside DeskEngine.tickCycle — refusals leave the adapter
// untouched, approvals seal a ledger record, and the human lock governs LIVE.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  quote: { bestBid: 0.4, bestAsk: 0.42, askDepth: null as number | null },
  market: {
    marketId: "0xMARKET",
    upSymbol: "BTC-5m#UP",
    intervalSec: 300,
    secondsLeft: 240,
    expiry: Math.floor(Date.now() / 1000) + 240,
    asset: "BTC",
    onchainStatus: 1,
    lastUpProb: 0.41,
  },
  council: {
    ballots: [
      { juror: "TREND", vote: "YES", confidence: 0.8, rationale: "mock", engine: "heuristic" as const },
      { juror: "CONTRARIAN", vote: "YES", confidence: 0.8, rationale: "mock", engine: "heuristic" as const },
      { juror: "SENTINEL", vote: "YES", confidence: 0.8, rationale: "mock", engine: "heuristic" as const },
    ],
    consensus: "UP" as "UP" | "DOWN" | "SPLIT",
    modelProb: 0.6,
    netConviction: 0.8,
    summary: "mock council — UP",
  },
  collateral: 10000,
}));

vi.mock("@/lib/db", () => {
  const row = (data: Record<string, unknown>) => ({
    ...data,
    id: `id_${Math.random().toString(36).slice(2, 9)}`,
    createdAt: new Date(),
    openedAt: new Date(),
  });
  const make = () => ({
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
    createMany: vi.fn(async () => ({ count: 0 })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
    findMany: vi.fn(async () => []),
    findUnique: vi.fn(async () => null),
  });
  return {
    db: {
      session: make(),
      signal: make(),
      decision: make(),
      councilVote: make(),
      riskCheck: make(),
      trade: make(),
      auditEvent: make(),
    },
  };
});

vi.mock("@/lib/desk/prices", () => ({
  prices: {
    ensurePolling: vi.fn(),
    series: vi.fn(() => []),
    get: vi.fn(() => ({ asset: "BTC", price: 50000, ema: null, source: "mock-oracle", history: [] })),
    all: vi.fn(() => [{ asset: "BTC", price: 50000, source: "mock-oracle" }]),
    oracleHealthy: true,
  },
}));

vi.mock("@/lib/desk/agents", () => ({
  // momentumAgent/volatilityAgent are synchronous in the real module — the
  // engine calls them without await. Mocks must match or tickCycle throws.
  momentumAgent: vi.fn(() => ({ agent: "MOMENTUM", direction: "UP", strength: 0.6, confidence: 0.7, detail: "mock", data: {} })),
  volatilityAgent: vi.fn(() => ({ agent: "VOLATILITY", direction: "FLAT", strength: 0.2, confidence: 0.5, detail: "mock", data: { regime: "normal" } })),
  sentimentAgent: vi.fn(async () => ({ agent: "SENTIMENT", direction: "UP", strength: 0.4, confidence: 0.6, detail: "mock", data: {} })),
}));

vi.mock("@/lib/desk/council", () => ({
  conveneCouncil: vi.fn(async () => h.council),
}));

vi.mock("@/lib/desk/exchange", () => ({
  findMarket: vi.fn(async () => h.market),
  fetchUpQuote: vi.fn(async () => h.quote),
  getExchange: vi.fn(() => ({ stub: true })),
  getAnyExchange: vi.fn(() => null),
  walletAddress: vi.fn(() => "0xWALLET"),
  collateralBalance: vi.fn(async () => h.collateral),
}));

import { db } from "@/lib/db";
import { engine } from "@/lib/desk/engine";
import { SessionLock } from "@/lib/desk/chp";
import { ChpTradeLedger } from "@/lib/desk/chp-ledger";
import type { ExecResult } from "@/lib/desk/adapters";

let dir: string;
let ledgerPath: string;
const executeStub = vi.fn(async (): Promise<ExecResult> => ({
  ok: true, filled: true, price: 0.44, size: 113.64, notional: 50, txHash: null, detail: "stub fill",
}));

function armEngine(mode: "PAPER" | "LIVE") {
  engine.status = "RUNNING";
  engine.sessionId = "sess_test";
  engine.mode = mode;
  engine.asset = "BTC";
  engine.cadenceSec = 300;
  engine.equity = mode === "LIVE" ? h.collateral : 1000;
  engine.startingEquity = mode === "LIVE" ? h.collateral : 1000;
  engine.collateral = mode === "LIVE" ? h.collateral : null;
  engine.realizedPnl = 0;
  engine.lastExecAt = null;
  engine.openTrades = [];
  (engine as unknown as { chpLock: SessionLock }).chpLock = new SessionLock();
  (engine as unknown as { adapter: unknown }).adapter = { name: "stub", execute: executeStub };
}

/** The status of the last decision row update the engine issued. */
function lastDecisionStatus(): string | undefined {
  const calls = vi.mocked(db.decision.update).mock.calls as { data: { status: string } }[][];
  return calls.at(-1)?.[0]?.data?.status;
}

async function runCycle() {
  await (engine as unknown as { tickCycle(forced?: boolean): Promise<void> }).tickCycle(true);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chp-engine-"));
  ledgerPath = join(dir, "chp-decisions.jsonl");
  process.env.DREAMDESK_CHP_LEDGER_PATH = ledgerPath;
  delete process.env.DREAMDESK_CHP_REQUIRE_HUMAN_LOCK; // default ON
  delete process.env.CHP_HITL_THRESHOLD;
  delete process.env.DREAMDESK_PRIVATE_KEY;
  h.quote = { bestBid: 0.4, bestAsk: 0.42, askDepth: null };
  h.council.consensus = "UP";
  h.council.modelProb = 0.6;
  h.collateral = 10000;
  executeStub.mockClear();
  executeStub.mockImplementation(async (): Promise<ExecResult> => ({
    ok: true, filled: true, price: 0.44, size: 113.64, notional: 50, txHash: null, detail: "stub fill",
  }));
  vi.mocked(db.decision.update).mockClear();
});

afterEach(async () => {
  engine.status = "IDLE";
  engine.sessionId = null;
  await rm(dir, { recursive: true, force: true });
});

describe("DeskEngine × CHP gate (trading loop)", () => {
  it("PAPER happy path: gate approves, the executor trades, the ledger seals the decision", async () => {
    armEngine("PAPER");
    await runCycle();

    expect(executeStub).toHaveBeenCalledTimes(1);
    expect(lastDecisionStatus()).toBe("TRADED");

    const ledger = new ChpTradeLedger(ledgerPath);
    const records = await ledger.list();
    expect(records).toHaveLength(1);
    expect(records[0].decision_id).toBeTruthy();
    expect(records[0].r0_verdict).toBe("PASS");
    expect(records[0].r0_results).toEqual({ Solvable: "PASS", Scoped: "PASS", Valid: "PASS", Worth_it: "PASS" });
    expect(records[0].foundation_score).toBe(100);
    expect(records[0].foundation_verdict).toBe("PASS");
    expect(records[0].profile_b?.state).toBe("LOCKED");
    expect(records[0].session_status).toBe("EXPLORING");
    expect(records[0].envelope_valid).toBe(true);
    expect(records[0].integrity_valid).toBe(true);
    expect(records[0].execution?.filled).toBe(true);
  });

  it("R0 refusal: zero-equity portfolio halts the trade before the executor", async () => {
    armEngine("LIVE");
    h.collateral = 0;
    engine.collateral = 0;
    engine.equity = 0;
    await runCycle();

    expect(executeStub).not.toHaveBeenCalled();
    expect(lastDecisionStatus()).toBe("CHP_REFUSED");
    const records = await new ChpTradeLedger(ledgerPath).list();
    expect(records).toHaveLength(0); // nothing executed, nothing sealed
  });

  it("human lock: LIVE execution refused while EXPLORING, executes after PROVISIONAL_LOCK → confirm", async () => {
    process.env.CHP_HITL_THRESHOLD = "1000"; // keep LIVE notional (500) under the HITL threshold
    armEngine("LIVE");

    await runCycle();
    expect(executeStub).not.toHaveBeenCalled();
    expect(lastDecisionStatus()).toBe("CHP_REFUSED");

    // Explicit transition to PROVISIONAL_LOCK — still not enough to trade.
    await engine.chpOpenProvisional();
    await runCycle();
    expect(executeStub).not.toHaveBeenCalled();
    expect(lastDecisionStatus()).toBe("CHP_REFUSED");

    // A named confirmer completes the lock; the next decision executes.
    await engine.chpConfirm("sam@cubiczan.com");
    await runCycle();
    expect(executeStub).toHaveBeenCalledTimes(1);
    expect(lastDecisionStatus()).toBe("TRADED");

    const records = await new ChpTradeLedger(ledgerPath).list();
    expect(records).toHaveLength(1);
    expect(records[0].session_status).toBe("LOCKED");
    expect(records[0].confirmed_by).toBe("sam@cubiczan.com");
  });

  it("flag OFF: LIVE execution proceeds without a human lock (recorded, fail-open)", async () => {
    process.env.CHP_HITL_THRESHOLD = "1000";
    process.env.DREAMDESK_CHP_REQUIRE_HUMAN_LOCK = "0";
    armEngine("LIVE");
    await runCycle();

    expect(executeStub).toHaveBeenCalledTimes(1);
    expect(lastDecisionStatus()).toBe("TRADED");
    const records = await new ChpTradeLedger(ledgerPath).list();
    expect(records[0].session_status).toBe("EXPLORING");
  });

  it("council SPLIT never reaches the gate or the executor", async () => {
    h.council.consensus = "SPLIT";
    armEngine("PAPER");
    await runCycle();

    expect(executeStub).not.toHaveBeenCalled();
    expect(lastDecisionStatus()).toBe("NO_QUORUM");
    expect(await new ChpTradeLedger(ledgerPath).list()).toHaveLength(0);
  });
});
