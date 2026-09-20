// Consensus Hardening Protocol — gate-only integration for the desk.
//
// Ported from the pattern proven in erp-control-plane (api/genbi/chp.py,
// commit 70678cc — port the shape, not the code) and aligned with the
// published CHP 0.1.1 semantics:
//
//   1. R0 gate            — before the consequential trade decision: "is this
//                           trade solvable from the current portfolio state?"
//                           Result keys are capitalized (Solvable, Scoped,
//                           Valid, Worth_it); failed criteria report FATAL;
//                           any FATAL ⇒ HALT with nothing executed.
//   2. Guardrails         — the desk's existing deterministic risk gates
//                           (runRiskGates) play the guardrail role.
//   3. Foundation pass    — a deterministic adversary scores the guardrailed
//                           decision out of 100: guardrails 40 + bounded
//                           order 30 + parity 30. Domain floor: blockchain /
//                           DeFi = 85 (CHP FOUNDATION_FLOORS); unknown
//                           domains fall back to the general floor (70).
//   4. Profile B gate     — spend limits + HITL threshold via the published
//                           @cubiczan/chp package (evaluateGate).
//   5. Human lock         — sessions start EXPLORING; an explicit transition
//                           opens PROVISIONAL_LOCK; a named confirmer locks it
//                           (LOCKED). DREAMDESK_CHP_REQUIRE_HUMAN_LOCK (default
//                           ON) makes the lock mandatory for LIVE execution.
//
// Divergences from the reference implementation, documented honestly:
//   - The npm package (@cubiczan/chp 0.1.1) exposes the Profile B capital
//     gate + canonical JSON, NOT the R0 gate, foundation scoring, payload
//     envelope, or session states — those are ported here from the CHP spec
//     shapes (the Python reference package is the normative source).
//   - There is no golden QA set for trades. Parity evidence reconciles the
//     decision against recomputed portfolio/market state; where no
//     independent recomputation is possible, state assertions stand in as
//     parity evidence and score no points (see assessTradeFoundation).
//   - validate_payload_envelope is STRUCTURE-ONLY, not content integrity —
//     the ledger (chp-ledger.ts) stores its own SHA-256 body digest.

import { evaluateGate, canonicalJson, type GatePolicy, type GateResult, type ProposedAction } from "@cubiczan/chp";
import { DESK, type DeskMode } from "./config";
import type { RiskGate } from "./risk";

/* ---------------------------------- R0 ---------------------------------- */

export type ChpVerdict = "PASS" | "HALT" | "REFRAME";
export type R0Criterion = "Solvable" | "Scoped" | "Valid" | "Worth_it";
export type R0Results = Record<R0Criterion, "PASS" | "FATAL">;
export type R0Evaluation = { results: R0Results; verdict: ChpVerdict };

/**
 * R0 gate (CHP spec): refuse an ill-posed trade before anything runs.
 * Mirrors chp.gates.evaluate_r0_gate exactly — capitalized result keys,
 * FATAL on failure, HALT verdict unless every criterion passes.
 */
export function evaluateR0Gate(c: {
  solvable: boolean;
  scoped: boolean;
  valid: boolean;
  worthIt: boolean;
}): R0Evaluation {
  const results: R0Results = {
    Solvable: c.solvable ? "PASS" : "FATAL",
    Scoped: c.scoped ? "PASS" : "FATAL",
    Valid: c.valid ? "PASS" : "FATAL",
    Worth_it: c.worthIt ? "PASS" : "FATAL",
  };
  const verdict: ChpVerdict = Object.values(results).every((v) => v === "PASS") ? "PASS" : "HALT";
  return { results, verdict };
}

/* ------------------------------ foundation ------------------------------ */

// CHP spec §5.3 floors — exact match, case-insensitive; unknown domains fall
// back to the general floor rather than failing open (0) or closed (100).
export const DEFAULT_FOUNDATION_FLOOR = 70;
export const FOUNDATION_FLOORS: Record<string, number> = {
  general: 70,
  ai: 70,
  agents: 70,
  blockchain: 85,
  defi: 85,
  finance: 100,
  cfo: 100,
  capital_allocation: 100,
  board_decision: 100,
};

export function foundationFloor(domain?: string | null): number {
  const key = (domain ?? "").trim().toLowerCase();
  return FOUNDATION_FLOORS[key] ?? DEFAULT_FOUNDATION_FLOOR;
}

/** PASS at or above the domain floor, REFRAME below (chp.foundation.foundation_verdict). */
export function foundationVerdict(score: number, domain: string): ChpVerdict {
  return score >= foundationFloor(domain) ? "PASS" : "REFRAME";
}

export type ParityCheck = { name: string; assertion: string; pass: boolean | null };
export type ParityEvidence = {
  // "portfolio_market_state": checks recomputed from live portfolio/market data.
  // "state_assertions": no independent recomputation existed — the decision's
  // own claims stood in as parity evidence and earned no points.
  source: "portfolio_market_state" | "state_assertions";
  checks: ParityCheck[];
  consistent: boolean | null;
};
export type FoundationAssessment = {
  score: number; // out of 100
  domain: string;
  verdict: ChpVerdict; // PASS | REFRAME | HALT
  findings: string[];
  parity: ParityEvidence | null;
  fatal: string | null;
};

// Deterministic adversary scoring (out of 100) — same weights as the
// erp-control-plane promotion gate.
const GUARDRAILS_POINTS = 40;
const BOUNDED_ORDER_POINTS = 30;
const PARITY_POINTS = 30;
const FULL_SCORE = GUARDRAILS_POINTS + BOUNDED_ORDER_POINTS + PARITY_POINTS;

// The council anchors modelProb on the venue mid (± conviction), so a healthy
// decision never strays far from the book; a wilder gap means corrupted inputs.
const MODEL_VENUE_MAX_GAP = 0.5;

export type TradeFoundationInput = {
  side: "YES" | "NO";
  modelProb: number;
  notional: number;
  equity: number;
  venue: { bestBid: number | null; bestAsk: number | null } | null;
  riskGatesPassed: boolean;
  riskGateCount: number;
  riskGatesPassedCount: number;
};

/**
 * The deterministic adversary scores the guardrailed trade decision (0-100).
 * Guardrails points are only awarded when every deterministic risk gate
 * passed; a parity contradiction is fatal regardless of score — a decision
 * contradicting its own portfolio/market state must not execute, and no
 * human confirmer can wave it through.
 */
export function assessTradeFoundation(input: TradeFoundationInput): FoundationAssessment {
  const findings: string[] = [];
  const domain = "defi";
  let score = 0;
  let fatal: string | null = null;

  if (input.riskGatesPassed) {
    score += GUARDRAILS_POINTS;
    findings.push(
      `guardrails passed: all ${input.riskGateCount} deterministic risk gates held (${input.riskGatesPassedCount}/${input.riskGateCount})`
    );
  } else {
    findings.push("guardrails failed: the risk governor vetoed this decision");
  }

  // Bounded order: fully specified, positively sized, inside the per-trade
  // bounds — the trade-side analog of a bounded, non-empty result.
  const notionalBounded =
    Number.isFinite(input.notional) &&
    input.notional > 0 &&
    input.notional <= input.equity * DESK.perTradeEquityShare * 1.01 + 1e-9 &&
    input.notional <= (chpPolicy().max_notional + 1e-9);
  if (input.riskGatesPassed && notionalBounded) {
    score += BOUNDED_ORDER_POINTS;
    findings.push(
      `bounded order: ${input.notional.toFixed(2)} notional (per-trade share ${(DESK.perTradeEquityShare * 100).toFixed(0)}% of ${input.equity.toFixed(2)} equity)`
    );
  } else {
    findings.push("order not bounded: size unknown, non-positive, or outside per-trade bounds");
  }

  // Parity: reconcile the decision's state assertions against recomputation
  // from the portfolio and the venue book. There is no golden trade source;
  // when the book is unavailable the assertions stand unverified and earn
  // nothing — documented honestly rather than self-certified.
  const ask = input.venue?.bestAsk ?? null;
  const bid = input.venue?.bestBid ?? null;
  let parity: ParityEvidence | null = null;

  if (bid != null && ask != null) {
    const mid = (bid + ask) / 2;
    const bookSane = bid > 0 && bid < 1 && ask > 0 && ask < 1 && bid <= ask;
    const modelAnchored = Math.abs(input.modelProb - mid) <= MODEL_VENUE_MAX_GAP;
    const sizingConsistent = input.notional > 0 && input.notional <= input.equity;
    parity = {
      source: "portfolio_market_state",
      checks: [
        { name: "venue_book", assertion: "bid/ask within (0,1) and crossed sanely", pass: bookSane },
        { name: "model_vs_venue", assertion: `modelProb within ${MODEL_VENUE_MAX_GAP} of venue mid ${mid.toFixed(3)}`, pass: modelAnchored },
        { name: "portfolio_sizing", assertion: "notional does not exceed portfolio equity", pass: sizingConsistent },
      ],
      consistent: bookSane && modelAnchored && sizingConsistent,
    };
    if (parity.consistent) {
      score += PARITY_POINTS;
      findings.push(
        `parity: portfolio/market state reconciled (book ${bid.toFixed(3)}/${ask.toFixed(3)}, model ${input.modelProb.toFixed(3)}, notional ${input.notional.toFixed(2)} ≤ equity ${input.equity.toFixed(2)})`
      );
    } else {
      const broken = parity.checks.filter((c) => !c.pass).map((c) => c.name);
      fatal = `parity MISMATCH: ${broken.join(", ")} — the decision contradicts its own portfolio/market state and must not execute`;
      findings.push(fatal);
    }
  } else {
    parity = {
      source: "state_assertions",
      checks: [{ name: "venue_book", assertion: "venue book unavailable — assertions unverified", pass: null }],
      consistent: null,
    };
    findings.push("no venue book to reconcile against — state assertions stand as parity evidence, unverified (no points)");
  }

  score = Math.min(score, FULL_SCORE);
  const verdict: ChpVerdict = fatal != null ? "HALT" : foundationVerdict(score, domain);
  return { score, domain, verdict, findings, parity, fatal };
}

/* ------------------------- payload envelope (port) ----------------------- */

export type PayloadEnvelope = { route: string; payload_id: string; body: string };

// Short uppercase id in the shape of the reference implementation's ids.
export function makePayloadId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
  let id = "";
  for (let i = 0; i < 6; i += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
}

export function buildPayloadEnvelope(body: string, route = "RX"): PayloadEnvelope {
  return { route, payload_id: makePayloadId(), body };
}

export function renderPayloadEnvelope(e: PayloadEnvelope): string {
  return `BEGIN_PAYLOAD [${e.route}] [${e.payload_id}]\n${e.body}\nEND_PAYLOAD [${e.route}] [${e.payload_id}]`;
}

/**
 * STRUCTURE-ONLY validation, ported from chp.payloads.validate_payload_envelope.
 * This checks the envelope frame matches, NOT that the body is intact —
 * content integrity is the ledger's own body_sha256 (chp-ledger.ts).
 */
export function validatePayloadEnvelope(rendered: string): boolean {
  const lines = rendered.trim().split("\n").map((l) => l.trimEnd());
  if (lines.length < 3) return false;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first.startsWith("BEGIN_PAYLOAD [") || !last.startsWith("END_PAYLOAD [")) return false;
  return first.replace("BEGIN_PAYLOAD", "").trim() === last.replace("END_PAYLOAD", "").trim();
}

/* ------------------------------ session lock ----------------------------- */

export type SessionLockState = "EXPLORING" | "PROVISIONAL_LOCK" | "LOCKED";

export type ThirdPartyValidation = {
  validator: string;
  item: string;
  challenge: string;
  result: "CONFIRM";
  rationale: string;
};

export type LockTransition =
  | { ok: true; state: SessionLockState; validation: ThirdPartyValidation | null }
  | { ok: false; state: SessionLockState; detail: string };

/**
 * Session lock lifecycle. Sessions start EXPLORING; PROVISIONAL_LOCK must be
 * opened explicitly before third-party validation; a named confirmer is
 * required before LOCKED. In-memory by design: a process restart returns a
 * LIVE session to EXPLORING — the fail-closed direction (capital re-locks).
 */
export class SessionLock {
  state: SessionLockState = "EXPLORING";
  confirmedBy: string | null = null;
  private validation: ThirdPartyValidation | null = null;

  /** Explicit transition EXPLORING → PROVISIONAL_LOCK. */
  openProvisional(): LockTransition {
    if (this.state === "LOCKED") {
      return { ok: false, state: this.state, detail: "Session already LOCKED — no further transition" };
    }
    if (this.state === "PROVISIONAL_LOCK") {
      return { ok: true, state: this.state, validation: null };
    }
    this.state = "PROVISIONAL_LOCK";
    return { ok: true, state: this.state, validation: null };
  }

  /** Third-party validation: PROVISIONAL_LOCK → LOCKED; requires a named confirmer. */
  confirm(confirmedBy: string, item: string): LockTransition {
    if (this.state === "EXPLORING") {
      return {
        ok: false,
        state: this.state,
        detail: "Cannot confirm an EXPLORING session — open PROVISIONAL_LOCK explicitly first",
      };
    }
    if (this.state === "LOCKED") {
      return { ok: false, state: this.state, detail: "Session already LOCKED" };
    }
    if (!confirmedBy || !confirmedBy.trim()) {
      return { ok: false, state: this.state, detail: "confirmed_by is required to reach LOCKED" };
    }
    this.validation = {
      validator: confirmedBy.trim(),
      item,
      challenge: "Confirm the desk may move capital under the hardened decision protocol",
      result: "CONFIRM",
      rationale: "Named confirmer approved the session via the desk API",
    };
    this.confirmedBy = confirmedBy.trim();
    this.state = "LOCKED";
    return { ok: true, state: this.state, validation: this.validation };
  }

  /** The third-party validation record once locked (for the decision ledger). */
  lastValidation(): ThirdPartyValidation | null {
    return this.validation;
  }
}

/* ------------------------------- policy --------------------------------- */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Profile B capital-gate policy, derived from the desk config and env knobs. */
export function chpPolicy(): GatePolicy {
  const maxNotional = envNumber("CHP_MAX_NOTIONAL", 500);
  return {
    max_notional: maxNotional,
    daily_cap: envNumber("CHP_DAILY_CAP", 2500),
    hitl_threshold: envNumber("CHP_HITL_THRESHOLD", 250),
    min_confidence: DESK.minConfidence,
    allowed_actions: ["TRADE"],
    per_asset_limits: { BTC: maxNotional, ETH: maxNotional },
  };
}

export const TRADE_ACTION = "TRADE";

/* ----------------------------- composite gate ---------------------------- */

export type ChpTradeContext = {
  decisionId: string;
  asset: string;
  side: "YES" | "NO";
  modelProb: number;
  /** Signed value edge for the chosen side (model worth − venue price). */
  signedEdge: number | null;
  notional: number;
  equity: number;
  quote: { bestBid: number | null; bestAsk: number | null } | null;
  riskGates: RiskGate[];
  councilConfidence: number;
  mode: DeskMode;
  lock: SessionLockState;
  committedToday: number;
  requireHumanLock: boolean;
  policy: GatePolicy;
};

export type ChpTradeGateResult = {
  allowed: boolean;
  stage: "r0" | "risk_gates" | "profile_b" | "foundation" | "human_lock" | "approved";
  r0: R0Evaluation;
  foundation: FoundationAssessment | null;
  profileB: GateResult | null;
  reason: string;
};

/**
 * The full gate-only CHP pass for one consequential trade decision, in order:
 * R0 → guardrails (re-checked) → Profile B capital gate → foundation →
 * human lock. R0 HALT refuses with nothing executed — the desk's executor
 * never sees it.
 */
export function runChpTradeGate(ctx: ChpTradeContext): ChpTradeGateResult {
  // 1 — R0: is this trade solvable from the current portfolio state?
  // Solvability is about the portfolio (equity can express a positive-size
  // trade); a missing venue book is a parity-evidence gap, scored in the
  // foundation pass, not an ill-posed decision.
  const solvable = ctx.equity > 0 && ctx.notional > 0;
  const scoped =
    DESK.perTradeEquityShare > 0 &&
    DESK.perTradeEquityShare <= 1 &&
    DESK.maxOpenPositions >= 1 &&
    DESK.cooldownMs >= 0 &&
    DESK.minEdgeProb >= 0;
  const valid = (ctx.side === "YES" || ctx.side === "NO") && ctx.modelProb > 0 && ctx.modelProb < 1;
  const worthIt = ctx.signedEdge != null && ctx.signedEdge > 0;
  const r0 = evaluateR0Gate({ solvable, scoped, valid, worthIt });
  if (r0.verdict !== "PASS") {
    const failed = (Object.keys(r0.results) as R0Criterion[]).filter((k) => r0.results[k] === "FATAL");
    return { allowed: false, stage: "r0", r0, foundation: null, profileB: null, reason: `R0 HALT: ${failed.join(", ")} FATAL` };
  }

  // 2 — guardrails: the deterministic risk governor must have held.
  if (!ctx.riskGates.every((g) => g.passed)) {
    return {
      allowed: false, stage: "risk_gates", r0, foundation: null, profileB: null,
      reason: "risk governor vetoed the decision before the CHP foundation pass",
    };
  }

  // 3 — Profile B capital gate (published @cubiczan/chp): hard limits BLOCK,
  // threshold crossings require a human countersign the desk cannot give itself.
  const action: ProposedAction = {
    action: TRADE_ACTION,
    asset: ctx.asset,
    notional: Number(ctx.notional.toFixed(6)),
    confidence: ctx.councilConfidence,
    rationale: `trade ${ctx.side} on ${ctx.asset} event contract`,
  };
  const profileB = evaluateGate(action, ctx.policy, ctx.committedToday);
  if (profileB.state === "BLOCKED") {
    return { allowed: false, stage: "profile_b", r0, foundation: null, profileB, reason: `Profile B BLOCKED: ${profileB.reason}` };
  }
  if (profileB.state === "HITL_REQUIRED") {
    return {
      allowed: false, stage: "profile_b", r0, foundation: null, profileB,
      reason: `Profile B HITL_REQUIRED: ${profileB.reason} — a named human must countersign; the desk cannot self-approve`,
    };
  }

  // 4 — foundation: deterministic adversary score against the DeFi floor.
  const foundation = assessTradeFoundation({
    side: ctx.side,
    modelProb: ctx.modelProb,
    notional: ctx.notional,
    equity: ctx.equity,
    venue: ctx.quote,
    riskGatesPassed: true,
    riskGateCount: ctx.riskGates.length,
    riskGatesPassedCount: ctx.riskGates.filter((g) => g.passed).length,
  });
  if (foundation.verdict !== "PASS") {
    const reason =
      foundation.verdict === "HALT"
        ? `foundation HALT (score ${foundation.score}/100, floor ${foundationFloor(foundation.domain)}): ${foundation.fatal}`
        : `foundation REFRAME (score ${foundation.score}/100, floor ${foundationFloor(foundation.domain)}): insufficient evidence to self-certify this trade`;
    return { allowed: false, stage: "foundation", r0, foundation, profileB, reason };
  }

  // 5 — human lock: LIVE capital requires a locked session when the flag is on.
  if (ctx.requireHumanLock && ctx.mode === "LIVE" && ctx.lock !== "LOCKED") {
    return {
      allowed: false, stage: "human_lock", r0, foundation, profileB,
      reason: `human lock required: LIVE execution needs a LOCKED session (state ${ctx.lock}) — open PROVISIONAL_LOCK and confirm with a named confirmer`,
    };
  }

  return { allowed: true, stage: "approved", r0, foundation, profileB, reason: "CHP gate approved the trade" };
}

/** Canonical JSON body for a trade decision record (published canonicalization). */
export function chpBody(payload: Record<string, unknown>): string {
  return canonicalJson(payload);
}
