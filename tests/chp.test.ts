// CHP gate-only integration — the desk-side mirror of the erp-control-plane
// CHP suite (tests/test_genbi_chp.py): R0 refusal, deterministic foundation
// scoring against the DeFi floor, the human-lock progression, the Profile B
// capital gate, and the append-only decision ledger with tamper detection.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FOUNDATION_FLOOR,
  FOUNDATION_FLOORS,
  SessionLock,
  assessTradeFoundation,
  buildPayloadEnvelope,
  chpBody,
  chpPolicy,
  evaluateR0Gate,
  foundationFloor,
  renderPayloadEnvelope,
  runChpTradeGate,
  validatePayloadEnvelope,
  type ChpTradeContext,
} from "@/lib/desk/chp";
import { ChpTradeLedger, type ChpTradeRecord } from "@/lib/desk/chp-ledger";

const PASSING_GATES = (n = 8) =>
  Array.from({ length: n }, (_, i) => ({ gate: `gate ${i}`, passed: true, detail: "ok" }));

function gateContext(overrides: Partial<ChpTradeContext> = {}): ChpTradeContext {
  return {
    decisionId: "dec_test",
    asset: "BTC",
    side: "YES",
    modelProb: 0.6,
    signedEdge: 0.18,
    notional: 50,
    equity: 1000,
    quote: { bestBid: 0.4, bestAsk: 0.42 },
    riskGates: PASSING_GATES(),
    councilConfidence: 0.8,
    mode: "PAPER",
    lock: "EXPLORING",
    committedToday: 0,
    requireHumanLock: true,
    policy: chpPolicy(),
    ...overrides,
  };
}

describe("R0 gate", () => {
  it("passes a solvable, scoped, valid, worth-it trade", () => {
    const r0 = evaluateR0Gate({ solvable: true, scoped: true, valid: true, worthIt: true });
    expect(r0.verdict).toBe("PASS");
    expect(Object.values(r0.results).every((v) => v === "PASS")).toBe(true);
  });

  it("uses the capitalized result keys", () => {
    const r0 = evaluateR0Gate({ solvable: false, scoped: false, valid: false, worthIt: false });
    expect(Object.keys(r0.results)).toEqual(["Solvable", "Scoped", "Valid", "Worth_it"]);
  });

  it("reports FATAL per failed criterion and HALTs", () => {
    const r0 = evaluateR0Gate({ solvable: true, scoped: false, valid: true, worthIt: false });
    expect(r0.verdict).toBe("HALT");
    expect(r0.results.Solvable).toBe("PASS");
    expect(r0.results.Scoped).toBe("FATAL");
    expect(r0.results.Valid).toBe("PASS");
    expect(r0.results.Worth_it).toBe("FATAL");
  });

  it("refuses a trade unsolvable from the current portfolio state", () => {
    const r0 = evaluateR0Gate({ solvable: false, scoped: true, valid: true, worthIt: true });
    expect(r0.verdict).toBe("HALT");
    expect(r0.results.Solvable).toBe("FATAL");
  });
});

describe("foundation floors", () => {
  it("gates blockchain and DeFi at 85", () => {
    expect(FOUNDATION_FLOORS.blockchain).toBe(85);
    expect(FOUNDATION_FLOORS.defi).toBe(85);
    expect(foundationFloor("blockchain")).toBe(85);
    expect(foundationFloor("DeFi")).toBe(85); // case-insensitive
  });

  it("keeps the reference floors for other domains", () => {
    expect(foundationFloor("finance")).toBe(100);
    expect(FOUNDATION_FLOORS.cfo).toBe(100);
  });

  it("falls back to the general floor for unknown or missing domains", () => {
    expect(DEFAULT_FOUNDATION_FLOOR).toBe(70);
    expect(foundationFloor(undefined)).toBe(70);
    expect(foundationFloor("defi_trading_bot")).toBe(70); // exact match, not prefix
  });
});

describe("deterministic adversary foundation pass", () => {
  it("scores a fully evidenced trade 100 and passes the DeFi floor", () => {
    const a = assessTradeFoundation({
      side: "YES", modelProb: 0.6, notional: 50, equity: 1000,
      venue: { bestBid: 0.4, bestAsk: 0.42 },
      riskGatesPassed: true, riskGateCount: 8, riskGatesPassedCount: 8,
    });
    expect(a.score).toBe(100);
    expect(a.domain).toBe("defi");
    expect(a.verdict).toBe("PASS");
    expect(a.parity?.source).toBe("portfolio_market_state");
    expect(a.parity?.consistent).toBe(true);
  });

  it("refuses below the 85 floor when parity evidence is unavailable", () => {
    // No venue book → assertions stand as parity evidence, unverified, 0 points
    // → guardrails 40 + bounded 30 = 70 < 85 → REFRAME.
    const a = assessTradeFoundation({
      side: "YES", modelProb: 0.6, notional: 50, equity: 1000,
      venue: null,
      riskGatesPassed: true, riskGateCount: 8, riskGatesPassedCount: 8,
    });
    expect(a.score).toBe(70);
    expect(a.verdict).toBe("REFRAME");
    expect(a.parity?.source).toBe("state_assertions");
    expect(a.parity?.consistent).toBeNull();
    expect(a.findings.some((f) => f.includes("no venue book"))).toBe(true);
  });

  it("treats a parity mismatch as fatal regardless of score", () => {
    const a = assessTradeFoundation({
      side: "YES", modelProb: 0.6, notional: 50, equity: 1000,
      venue: { bestBid: 0.9, bestAsk: 0.2 }, // crossed book — contradicts market state
      riskGatesPassed: true, riskGateCount: 8, riskGatesPassedCount: 8,
    });
    expect(a.verdict).toBe("HALT");
    expect(a.fatal).toContain("parity MISMATCH");
    expect(a.fatal).toContain("venue_book");
  });

  it("awards no guardrails or bounded points when the risk governor vetoed", () => {
    // Guardrails 40 and bounded-order 30 are both refused on a veto; parity is
    // an independent dimension and still holds (30/100 → REFRAME below 85).
    const a = assessTradeFoundation({
      side: "YES", modelProb: 0.6, notional: 50, equity: 1000,
      venue: { bestBid: 0.4, bestAsk: 0.42 },
      riskGatesPassed: false, riskGateCount: 8, riskGatesPassedCount: 7,
    });
    expect(a.score).toBe(30);
    expect(a.verdict).toBe("REFRAME");
  });
});

describe("payload envelope (structure-only port)", () => {
  it("renders and validates the BEGIN/END frame", () => {
    const env = buildPayloadEnvelope('{"k":1}', "TRADE");
    const rendered = renderPayloadEnvelope(env);
    expect(rendered.split("\n")[0]).toMatch(/^BEGIN_PAYLOAD \[TRADE\] \[/);
    expect(rendered.split("\n").at(-1)).toMatch(/^END_PAYLOAD \[TRADE\] \[/);
    expect(validatePayloadEnvelope(rendered)).toBe(true);
  });

  it("rejects non-envelope or mismatched frames", () => {
    expect(validatePayloadEnvelope("no envelope here")).toBe(false);
    expect(validatePayloadEnvelope("BEGIN_PAYLOAD [TRADE] [X]\nbody")).toBe(false);
    const env = buildPayloadEnvelope("body", "TRADE");
    const tampered = renderPayloadEnvelope(env).replace("END_PAYLOAD [TRADE]", "END_PAYLOAD [RX]");
    expect(validatePayloadEnvelope(tampered)).toBe(false);
  });

  it("is structure-only: a tampered body inside the frame still validates", () => {
    // The documented CHP gap — envelope validation never proves body integrity;
    // content integrity is the ledger's own body_sha256.
    const env = buildPayloadEnvelope('{"amount":50}', "TRADE");
    const tamperedBody = renderPayloadEnvelope(env).replace('{"amount":50}', '{"amount":5000}');
    expect(validatePayloadEnvelope(tamperedBody)).toBe(true);
  });
});

describe("session human lock", () => {
  it("starts every session EXPLORING", () => {
    expect(new SessionLock().state).toBe("EXPLORING");
  });

  it("cannot confirm an EXPLORING session — PROVISIONAL_LOCK must be explicit", () => {
    const lock = new SessionLock();
    const t = lock.confirm("sam@cubiczan.com", "sess_1");
    expect(t.ok).toBe(false);
    if (!t.ok) expect(t.detail).toContain("PROVISIONAL_LOCK");
    expect(lock.state).toBe("EXPLORING");
  });

  it("requires confirmed_by to reach LOCKED", () => {
    const lock = new SessionLock();
    lock.openProvisional();
    const noName = lock.confirm("", "sess_1");
    expect(noName.ok).toBe(false);
    if (!noName.ok) expect(noName.detail).toContain("confirmed_by");
    const t = lock.confirm("sam@cubiczan.com", "sess_1");
    expect(t.ok).toBe(true);
    expect(lock.state).toBe("LOCKED");
    expect(lock.confirmedBy).toBe("sam@cubiczan.com");
    expect(lock.lastValidation()).toMatchObject({
      validator: "sam@cubiczan.com",
      item: "sess_1",
      result: "CONFIRM",
    });
  });

  it("is terminal once LOCKED", () => {
    const lock = new SessionLock();
    lock.openProvisional();
    lock.confirm("sam@cubiczan.com", "sess_1");
    expect(lock.openProvisional().ok).toBe(false);
    expect(lock.confirm("again@example.com", "sess_1").ok).toBe(false);
    expect(lock.state).toBe("LOCKED");
  });
});

describe("Profile B capital gate", () => {
  it("auto-clears small trades within limits (LOCKED)", () => {
    const r = runChpTradeGate(gateContext());
    expect(r.allowed).toBe(true);
    expect(r.stage).toBe("approved");
    expect(r.profileB?.state).toBe("LOCKED");
  });

  it("BLOCKS trades over the per-trade notional cap", () => {
    const r = runChpTradeGate(gateContext({ notional: 501 }));
    expect(r.allowed).toBe(false);
    expect(r.stage).toBe("profile_b");
    expect(r.profileB?.state).toBe("BLOCKED");
  });

  it("refuses HITL_REQUIRED trades — the desk cannot countersign itself", () => {
    const r = runChpTradeGate(gateContext({ notional: 250 }));
    expect(r.allowed).toBe(false);
    expect(r.stage).toBe("profile_b");
    expect(r.profileB?.state).toBe("HITL_REQUIRED");
    expect(r.reason).toContain("human");
  });

  it("BLOCKS once the daily cap is committed", () => {
    const r = runChpTradeGate(gateContext({ notional: 50, committedToday: 2500 }));
    expect(r.allowed).toBe(false);
    expect(r.profileB?.state).toBe("BLOCKED");
  });
});

describe("composite trade gate refusals", () => {
  it("halts on R0 failure before anything runs", () => {
    const r = runChpTradeGate(gateContext({ equity: 0 }));
    expect(r.allowed).toBe(false);
    expect(r.stage).toBe("r0");
    expect(r.r0.results.Solvable).toBe("FATAL");
    expect(r.reason).toContain("Solvable");
  });

  it("halts when the model has no provable value edge (not worth it)", () => {
    const r = runChpTradeGate(gateContext({ signedEdge: -0.02 }));
    expect(r.allowed).toBe(false);
    expect(r.stage).toBe("r0");
    expect(r.r0.results.Worth_it).toBe("FATAL");
  });

  it("refuses when the risk governor vetoed (guardrails before foundation)", () => {
    const gates = PASSING_GATES();
    gates[2] = { gate: "Expiry headroom", passed: false, detail: "90s left" };
    const r = runChpTradeGate(gateContext({ riskGates: gates }));
    expect(r.allowed).toBe(false);
    expect(r.stage).toBe("risk_gates");
    expect(r.foundation).toBeNull();
  });

  it("reframes when foundation evidence is below the DeFi floor", () => {
    const r = runChpTradeGate(gateContext({ quote: null }));
    expect(r.allowed).toBe(false);
    expect(r.stage).toBe("foundation");
    expect(r.foundation?.verdict).toBe("REFRAME");
    expect(r.foundation?.score).toBe(70);
  });

  it("requires a LOCKED session for LIVE execution while the flag is ON", () => {
    const r = runChpTradeGate(gateContext({ mode: "LIVE", lock: "EXPLORING" }));
    expect(r.allowed).toBe(false);
    expect(r.stage).toBe("human_lock");
    expect(r.reason).toContain("LOCKED");
  });

  it("still refuses LIVE execution in PROVISIONAL_LOCK — confirmation completes the lock", () => {
    const r = runChpTradeGate(gateContext({ mode: "LIVE", lock: "PROVISIONAL_LOCK" }));
    expect(r.allowed).toBe(false);
    expect(r.stage).toBe("human_lock");
  });

  it("approves LIVE execution once LOCKED", () => {
    const r = runChpTradeGate(gateContext({ mode: "LIVE", lock: "LOCKED" }));
    expect(r.allowed).toBe(true);
    expect(r.stage).toBe("approved");
  });

  it("exempts PAPER exploration from the human lock (flag ON, EXPLORING)", () => {
    const r = runChpTradeGate(gateContext({ mode: "PAPER", lock: "EXPLORING" }));
    expect(r.allowed).toBe(true);
  });

  it("skips the human lock for LIVE when the flag is OFF", () => {
    const r = runChpTradeGate(gateContext({ mode: "LIVE", lock: "EXPLORING", requireHumanLock: false }));
    expect(r.allowed).toBe(true);
  });
});

describe("trade decision ledger", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chp-ledger-"));
    path = join(dir, "chp-decisions.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sealedRecord = (decisionId: string): ChpTradeRecord => {
    const body = chpBody({ decision_id: decisionId, notional: 50, r0_verdict: "PASS" });
    const envelope = buildPayloadEnvelope(body, "TRADE");
    return {
      decision_id: decisionId,
      payload_id: envelope.payload_id,
      created_at: new Date().toISOString(),
      session_id: "sess_1",
      cycle: 3,
      asset: "BTC",
      domain: "defi",
      mode: "PAPER",
      session_status: "EXPLORING",
      r0_verdict: "PASS",
      r0_results: { Solvable: "PASS", Scoped: "PASS", Valid: "PASS", Worth_it: "PASS" },
      foundation_verdict: "PASS",
      foundation_score: 100,
      parity: null,
      profile_b: { state: "LOCKED", reason: "within limits", content_hash: "0xabc" },
      lock_validation: null,
      confirmed_by: null,
      execution: { side: "YES", notional: 50, price: 0.43, size: 116.27, filled: true, txHash: null, detail: "fill" },
      body,
      body_sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      envelope: renderPayloadEnvelope(envelope),
    };
  };

  it("round-trips a record with envelope and integrity valid", async () => {
    const ledger = new ChpTradeLedger(path);
    await ledger.append(sealedRecord("dec_1"));
    const list = await ledger.list();
    expect(list).toHaveLength(1);
    expect(list[0].decision_id).toBe("dec_1");
    expect(list[0].envelope_valid).toBe(true);
    expect(list[0].integrity_valid).toBe(true);
  });

  /** Rewrite the sealed body inside stored records, leaving the digest stale. */
  const tamperStoredBodies = async (ledgerFile: string) => {
    const lines = (await readFile(ledgerFile, "utf8")).trim().split("\n").map((line) => {
      const rec = JSON.parse(line) as { body: string };
      rec.body = rec.body.replace('"notional":50', '"notional":5000');
      return JSON.stringify(rec);
    });
    await writeFile(ledgerFile, lines.join("\n") + "\n", "utf8");
  };

  it("detects a tampered body via body_sha256 (integrity_valid false)", async () => {
    const ledger = new ChpTradeLedger(path);
    await ledger.append(sealedRecord("dec_1"));

    // A tamperer rewrites the notional inside the sealed body without resealing.
    await tamperStoredBodies(path);

    const list = await ledger.list();
    expect(list[0].integrity_valid).toBe(false);
    expect(list[0].envelope_valid).toBe(true); // frame untouched — structure-only passes
  });

  it("detects an envelope tamper via the structure check", async () => {
    const ledger = new ChpTradeLedger(path);
    await ledger.append(sealedRecord("dec_1"));
    const raw = (await readFile(path, "utf8")).replace("END_PAYLOAD [TRADE]", "END_PAYLOAD [RX]");
    await writeFile(path, raw, "utf8");
    const list = await ledger.list();
    expect(list[0].envelope_valid).toBe(false);
    expect(list[0].integrity_valid).toBe(true);
  });

  it("excludes tampered records from committed-today capital", async () => {
    const ledger = new ChpTradeLedger(path);
    await ledger.append(sealedRecord("dec_1"));
    expect(await ledger.committedToday()).toBe(50);
    await tamperStoredBodies(path);
    expect(await ledger.committedToday()).toBe(0);
  });

  it("returns null for an unknown decision and empty for a missing file", async () => {
    const ledger = new ChpTradeLedger(path);
    expect(await ledger.get("nope")).toBeNull();
    expect(await ledger.list()).toEqual([]);
  });
});
