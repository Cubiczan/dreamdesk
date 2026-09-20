// DeskEngine — the orchestrator.
//
// Owns the decision loop: gather signals → (maybe) convene the council →
// run risk gates → execute through the adapter → settle expiries — appending
// a hash-chained audit event for every step, and broadcasting UI snapshots.

import { EventEmitter } from "events";
import { createHash } from "crypto";
import { db } from "@/lib/db";
import { computeAuditHash, GENESIS_HASH } from "./ledger";
import { DESK, CHP, DREAMDEX, chpLedgerPath, chpRequireHumanLock, resolveMode, type DeskMode } from "./config";
import { prices } from "./prices";
import { momentumAgent, volatilityAgent, sentimentAgent, type SignalPacket, type AgentName } from "./agents";
import { conveneCouncil, type JurorBallot, type CouncilContext, type CouncilOutcome } from "./council";
import { runRiskGates, type RiskGate } from "./risk";
import {
  runChpTradeGate,
  chpPolicy,
  chpBody,
  buildPayloadEnvelope,
  renderPayloadEnvelope,
  SessionLock,
  type SessionLockState,
  type ChpTradeGateResult,
} from "./chp";
import { ChpTradeLedger } from "./chp-ledger";
import { PaperAdapter, LiveAdapter, type ExecutionAdapter, priceForSide } from "./adapters";
import { findMarket, fetchUpQuote, getExchange, getAnyExchange, walletAddress, collateralBalance, type MarketCandidate, type BookQuote } from "./exchange";
import type { Tick } from "./indicators";

export type Phase = "idle" | "gathering" | "convening" | "risk" | "chp" | "executing" | "settling" | "cooldown";
export type DecisionView = {
  id: string;
  cycle: number;
  status: string;
  consensus: string | null;
  summary: string;
  chosenSide: string | null;
  entryProb: number | null;
  marketSymbol: string | null;
  secondsLeft: number | null;
  votes: JurorBallot[];
  riskGates: RiskGate[];
  signals: SignalPacket[];
  modelProb: number | null;
  venueProb: number | null;
  execDetail: string | null;
  txHash: string | null;
  at: string;
};
export type TradeView = {
  id: string;
  symbol: string;
  side: string;
  price: number;
  size: number;
  notional: number;
  status: string;
  txHash: string | null;
  entryProb: number;
  lastProb: number | null;
  pnl: number;
  markProb: number | null;
  settleProb?: number | null;
  secondsLeft: number | null;
  mode: string;
  openedAt: string;
};
export type Snapshot = {
  status: "IDLE" | "RUNNING";
  mode: DeskMode;
  modeReason: string;
  asset: string;
  cadenceSec: number;
  cycle: number;
  phase: Phase;
  sessionId: string | null;
  wallet: string | null;
  collateral: number | null;
  equity: number;
  startingEquity: number;
  realizedPnl: number;
  price: { asset: string; price: number; ema: number | null; source: string; history: Tick[] } | null;
  prices: { asset: string; price: number; source: string }[];
  agents: Record<AgentName, SignalPacket>;
  decision: DecisionView | null;
  openTrades: TradeView[];
  settledTrades: TradeView[];
  stats: { trades: number; wins: number; losses: number; winRate: number; cycles: number; convenings: number };
  auditTail: { seq: number; kind: string; actor: string; hash: string; payload: string; at: string }[];
  auditCount: number;
  chainOk: boolean;
  oracleHealthy: boolean;
  chp: { lockState: SessionLockState; confirmedBy: string | null; requireHumanLock: boolean };
  lastError: string | null;
  at: string;
};

type AuditRow = { seq: number; kind: string; actor: string; hash: string; payload: string; createdAt: Date };

const EMPTY_PACKET = (agent: AgentName): SignalPacket => ({
  agent, direction: "FLAT", strength: 0, confidence: 0, detail: "No reading yet.", data: {},
});

class DeskEngine extends EventEmitter {
  status: "IDLE" | "RUNNING" = "IDLE";
  sessionId: string | null = null;
  mode: DeskMode = "PAPER";
  modeReason = "";
  asset = "BTC";
  cadenceSec = 300;
  cycle = 0;
  phase: Phase = "idle";
  wallet: string | null = null;
  collateral: number | null = null;
  startingEquity = 1000;
  equity = 1000;
  realizedPnl = 0;
  lastExecAt: number | null = null;
  agentPackets: Record<AgentName, SignalPacket> = {
    MOMENTUM: EMPTY_PACKET("MOMENTUM"),
    VOLATILITY: EMPTY_PACKET("VOLATILITY"),
    SENTIMENT: EMPTY_PACKET("SENTIMENT"),
  };
  decision: DecisionView | null = null;
  openTrades: TradeView[] = [];
  settledTrades: TradeView[] = [];
  stats = { trades: 0, wins: 0, losses: 0, winRate: 0, cycles: 0, convenings: 0 };
  auditTail: AuditRow[] = [];
  auditCount = 0;
  chainOk = true;
  private auditSeq = 0;
  private prevHash = GENESIS_HASH;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private pendingForce = false;
  private adapter: ExecutionAdapter = new PaperAdapter();
  private activeMarket: MarketCandidate | null = null;
  private lastQuote: BookQuote | null = null;
  // CHP gate-only layer: every session starts EXPLORING; the trade decision
  // ledger is opened lazily (its path is env-resolvable per call).
  chpLock = new SessionLock();
  lastError: string | null = null;

  /* ------------------------------ lifecycle ------------------------------ */

  async start(asset: string, cadenceSec: number, forcedMode?: DeskMode): Promise<{ ok: boolean; detail: string }> {
    if (this.status === "RUNNING") return { ok: false, detail: "Session already running" };
    const resolved = resolveMode();
    this.mode = forcedMode && forcedMode !== resolved.mode ? (getExchange() ? forcedMode : "PAPER") : resolved.mode;
    this.modeReason = this.mode === resolved.mode ? resolved.reason : `Requested ${forcedMode} but no funded desk wallet is configured — running PAPER`;
    this.asset = asset.toUpperCase();
    this.cadenceSec = cadenceSec;
    this.cycle = 0;
    this.realizedPnl = 0;
    this.lastExecAt = null;
    this.lastError = null;
    this.auditSeq = 0;
    this.prevHash = GENESIS_HASH;
    this.auditTail = [];
    this.auditCount = 0;
    this.chpLock = new SessionLock(); // sessions start EXPLORING — fail-closed for LIVE capital
    this.agentPackets = { MOMENTUM: EMPTY_PACKET("MOMENTUM"), VOLATILITY: EMPTY_PACKET("VOLATILITY"), SENTIMENT: EMPTY_PACKET("SENTIMENT") };
    this.decision = null;
    this.openTrades = [];
    this.settledTrades = [];
    this.stats = { trades: 0, wins: 0, losses: 0, winRate: 0, cycles: 0, convenings: 0 };
    this.adapter = this.mode === "LIVE" ? new LiveAdapter() : new PaperAdapter();
    this.wallet = walletAddress();
    this.collateral = this.mode === "LIVE" && this.wallet ? await collateralBalance(this.wallet) : null;
    this.startingEquity = 1000;
    this.equity = this.mode === "LIVE" ? (this.collateral ?? 0) : this.startingEquity;

    const session = await db.session.create({
      data: {
        mode: this.mode,
        asset: this.asset,
        cadenceSec: this.cadenceSec,
        status: "RUNNING",
        wallet: this.wallet,
        startingEquity: this.startingEquity,
        equity: this.equity,
        collateral: this.collateral ?? 0,
        modeReason: this.modeReason,
      },
    });
    this.sessionId = session.id;
    this.status = "RUNNING";
    this.phase = "idle";
    prices.ensurePolling(["BTC", "ETH"]);
    await this.audit("SESSION_START", "ENGINE", {
      mode: this.mode, asset: this.asset, cadenceSec: this.cadenceSec, adapter: this.adapter.name,
      wallet: this.wallet, reason: this.modeReason, chp_lock: this.chpLock.state,
    });
    this.timer = setInterval(() => void this.tickCycle(), DESK.cycleIntervalMs);
    this.broadcast();
    void this.tickCycle(); // first cycle immediately
    return { ok: true, detail: `${this.mode} session started on ${this.asset} ${this.cadenceSec / 60}-minute contracts` };
  }

  async stop(): Promise<{ ok: boolean; detail: string }> {
    if (this.status !== "RUNNING") return { ok: false, detail: "No running session" };
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status = "IDLE";
    this.phase = "idle";
    await this.audit("SESSION_END", "ENGINE", { cycles: this.stats.cycles, realizedPnl: this.realizedPnl, trades: this.stats.trades });
    if (this.sessionId) {
      await db.session.update({
        where: { id: this.sessionId },
        data: { status: "STOPPED", endedAt: new Date(), realizedPnl: this.realizedPnl, equity: this.equity },
      });
    }
    this.broadcast();
    return { ok: true, detail: "Session stopped — ledger finalized" };
  }

  /** Force one full decision cycle now (demo button). If a tick is mid-flight, queue the force so it can't be swallowed. */
  forceCycle() {
    if (this.status !== "RUNNING") return;
    if (this.busy) {
      this.pendingForce = true;
      return;
    }
    void this.tickCycle(true);
  }

  /* ---------------------------- decision loop ---------------------------- */

  private async tickCycle(forced = false) {
    if (this.busy || this.status !== "RUNNING" || !this.sessionId) return;
    this.busy = true;
    try {
      this.cycle += 1;
      this.stats.cycles += 1;

      // 1 — GATHER: signals from the three agents.
      this.phase = "gathering";
      this.broadcast();
      const series = prices.series(this.asset);
      const mom = momentumAgent(this.asset, series);
      const vol = volatilityAgent(this.asset, series);
      const senti = await sentimentAgent(this.asset);
      this.agentPackets = { MOMENTUM: mom, VOLATILITY: vol, SENTIMENT: senti };
      for (const s of [mom, vol, senti]) {
        await db.signal.create({ data: { sessionId: this.sessionId, agent: s.agent, direction: s.direction, strength: s.strength, confidence: s.confidence, detail: s.detail, data: JSON.stringify(s.data) } });
        await this.audit("SIGNAL", s.agent, { direction: s.direction, strength: Number(s.strength.toFixed(3)), confidence: Number(s.confidence.toFixed(3)), detail: s.detail });
      }

      const activity =
        (mom.direction !== "FLAT" ? mom.strength * 0.45 : 0) +
        (vol.direction !== "FLAT" ? vol.strength * 0.35 : 0) +
        (senti.direction !== "FLAT" ? senti.strength * 0.2 : 0);

      // 2 — Quiet cycle: no convene. Persist an audit heartbeat and move on.
      if (!forced && activity < DESK.quorumActivityThreshold) {
        await this.audit("CYCLE", "ENGINE", { cycle: this.cycle, activity: Number(activity.toFixed(3)), verdict: "quiet — below quorum threshold", spot: prices.get(this.asset)?.price ?? 0 });
        this.phase = "cooldown";
        this.broadcast();
        return;
      }

      // 3 — CONVENE: pick the market, quote it, seat the council.
      this.phase = "convening";
      this.broadcast();
      this.activeMarket = await findMarket(this.asset, this.cadenceSec, DESK.minExpiryHeadroomSec);
      this.lastQuote = this.activeMarket ? await fetchUpQuote(this.activeMarket.upSymbol) : null;
      const priceState = prices.get(this.asset);
      const recent = await db.decision.findMany({
        where: { sessionId: this.sessionId },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { cycle: true, status: true, consensus: true, summary: true },
      });
      const recentForm = recent.map((d) => ({ cycle: d.cycle, status: d.status, consensus: d.consensus, pnl: null as number | null }));

      const ctx: CouncilContext = {
        asset: this.asset,
        cadenceSec: this.activeMarket?.intervalSec ?? this.cadenceSec,
        marketSymbol: this.activeMarket ? `${this.activeMarket.upSymbol.split("#")[0]} (${Math.round(this.activeMarket.secondsLeft)}s left)` : null,
        secondsLeft: this.activeMarket?.secondsLeft ?? null,
        upBid: this.lastQuote?.bestBid ?? null,
        upAsk: this.lastQuote?.bestAsk ?? null,
        spot: priceState?.price ?? 0,
        priceSource: priceState?.source ?? "—",
        signals: [mom, vol, senti],
        recentForm,
      };
      const outcome = await conveneCouncil(ctx);
      this.stats.convenings += 1;

      // Record the verdict + ballots (decision id first, votes reference it directly).
      const decision = await db.decision.create({
        data: {
          sessionId: this.sessionId,
          cycle: this.cycle,
          asset: this.asset,
          marketSymbol: this.activeMarket ? this.activeMarket.upSymbol.split("#")[0] : null,
          marketId: this.activeMarket?.marketId ?? null,
          expiry: this.activeMarket?.expiry ?? null,
          entryProb: null,
          chosenSide: outcome.consensus === "SPLIT" ? null : outcome.consensus === "DOWN" ? "NO" : "YES",
          status: "CONVENED",
          consensus: outcome.consensus,
          summary: outcome.summary,
          signals: JSON.stringify({ MOMENTUM: mom, VOLATILITY: vol, SENTIMENT: senti }),
        },
      });
      for (const b of outcome.ballots) {
        await db.councilVote.create({ data: { sessionId: this.sessionId!, decisionId: decision.id, juror: b.juror, vote: b.vote, confidence: b.confidence, rationale: b.rationale } });
        await this.audit("VOTE", "COUNCIL", { juror: b.juror, vote: b.vote, confidence: Number(b.confidence.toFixed(2)), engine: b.engine, rationale: b.rationale });
      }
      await this.audit("CONSENSUS", "COUNCIL", { consensus: outcome.consensus, modelProb: Number(outcome.modelProb.toFixed(3)), summary: outcome.summary });

      // Market + book audit trail
      if (this.activeMarket) {
        await this.audit("MARKET", "ENGINE", {
          symbol: this.activeMarket.upSymbol.split("#")[0], asset: this.activeMarket.asset,
          intervalSec: this.activeMarket.intervalSec, secondsLeft: Math.round(this.activeMarket.secondsLeft),
          upBid: this.lastQuote?.bestBid ?? null, upAsk: this.lastQuote?.bestAsk ?? null,
          onchainStatus: this.activeMarket.onchainStatus,
        });
      }

      // 4 — RISK: deterministic gates.
      this.phase = "risk";
      this.broadcast();
      const venueProb = this.lastQuote?.bestAsk ?? this.activeMarket?.lastUpProb ?? null;
      const side: "YES" | "NO" = outcome.consensus === "DOWN" ? "NO" : "YES";
      const sideVenueProb = venueProb != null ? priceForSide(side, venueProb) : null;
      const winningConfidence =
        outcome.consensus === "SPLIT"
          ? 0
          : outcome.ballots.filter((b) => b.vote === (outcome.consensus === "UP" ? "YES" : "NO")).reduce((a, b) => a + b.confidence, 0) / Math.max(1, outcome.ballots.filter((b) => b.vote === (outcome.consensus === "UP" ? "YES" : "NO")).length);
      // Signed value edge for the chosen side: what we think the side is worth
      // minus what the venue charges for it. Positive = mispricing in our favor.
      //   YES: modelProb − upAsk   ·   NO: (1 − modelProb) − (1 − upAsk) = upAsk − modelProb
      const signedEdge =
        sideVenueProb != null
          ? side === "YES"
            ? outcome.modelProb - sideVenueProb
            : sideVenueProb - outcome.modelProb
          : null;
      const gatesResult = runRiskGates({
        now: Date.now(),
        lastExecAt: this.lastExecAt,
        openPositions: this.openTrades.length,
        realizedPnl: this.realizedPnl,
        sessionAgeMs: 0,
        councilConfidence: winningConfidence,
        edge: signedEdge ?? -1, // unknown venue price ⇒ no provable value ⇒ veto
        secondsLeft: this.activeMarket?.secondsLeft ?? null,
        onchainStatusOk: this.activeMarket?.onchainStatus === 1,
        hasMarket: !!this.activeMarket,
      });
      for (const gate of gatesResult.gates) {
        await this.audit("RISK", "RISK", { gate: gate.gate, passed: gate.passed, detail: gate.detail });
      }

      // Decision row already exists above — gates are persisted after evaluation.

      let execDetail: string | null = null;
      let txHash: string | null = null;
      let entryProb: number | null = null;
      let chpRefused = false;

      if (outcome.consensus === "SPLIT") {
        await db.decision.update({ where: { id: decision.id }, data: { status: "NO_QUORUM" } });
        execDetail = "Council split — no trade ordered";
      } else if (!gatesResult.pass) {
        await db.decision.update({ where: { id: decision.id }, data: { status: "VETOED" } });
        execDetail = `Risk governor vetoed: ${gatesResult.gates.filter((g) => !g.passed).map((g) => g.gate).join(", ")}`;
      } else {
        // 5 — CHP GATE: R0 → foundation → Profile B → human lock. A HALT here
        // refuses the trade with nothing executed — the executor never sees it.
        this.phase = "chp";
        this.broadcast();
        const notional = this.mode === "LIVE" ? Math.max(1, (this.collateral ?? 0) * DESK.perTradeEquityShare) : this.equity * DESK.perTradeEquityShare;
        const chpResult = runChpTradeGate({
          decisionId: decision.id,
          asset: this.asset,
          side,
          modelProb: outcome.modelProb,
          signedEdge,
          notional,
          equity: this.equity,
          quote: this.lastQuote ? { bestBid: this.lastQuote.bestBid, bestAsk: this.lastQuote.bestAsk } : null,
          riskGates: gatesResult.gates,
          councilConfidence: winningConfidence,
          mode: this.mode,
          lock: this.chpLock.state,
          committedToday: await this.ledger().committedToday(),
          requireHumanLock: chpRequireHumanLock(),
          policy: chpPolicy(),
        });
        await this.audit("CHP", "CHP", {
          stage: chpResult.stage, allowed: chpResult.allowed, reason: chpResult.reason,
          r0: chpResult.r0.results,
          foundation_score: chpResult.foundation?.score ?? null,
          foundation_verdict: chpResult.foundation?.verdict ?? null,
          parity_source: chpResult.foundation?.parity?.source ?? null,
          profile_b: chpResult.profileB?.state ?? null,
          lock_state: this.chpLock.state,
          notional: Number(notional.toFixed(2)),
        });
        if (!chpResult.allowed) {
          chpRefused = true;
          await db.decision.update({ where: { id: decision.id }, data: { status: "CHP_REFUSED" } });
          execDetail = `CHP ${chpResult.stage} refusal — ${chpResult.reason}`;
        } else {
        // 6 — EXECUTE.
        this.phase = "executing";
        this.broadcast();
        const result = await this.adapter.execute({
          symbol: this.activeMarket!.upSymbol,
          side,
          notional,
          quote: this.lastQuote ?? { bestBid: null, bestAsk: null, askDepth: null },
          modelProb: outcome.modelProb,
        });
        execDetail = result.detail;
        txHash = result.txHash;
        await this.audit("EXECUTION", "EXECUTOR", {
          adapter: this.adapter.name, side, notional: Number(notional.toFixed(2)),
          filled: result.filled, price: Number(result.price.toFixed(4)), size: Number(result.size.toFixed(4)), detail: result.detail, txHash: result.txHash,
        });
        if (result.ok && result.filled) {
          entryProb = result.price;
          this.lastExecAt = Date.now();
          const trade = await db.trade.create({
            data: {
              sessionId: this.sessionId, decisionId: decision.id,
              symbol: this.activeMarket!.upSymbol.split("#")[0], marketId: this.activeMarket!.marketId,
              side, price: result.price, size: result.size, notional: result.notional,
              mode: this.mode, status: "PLACED", txHash: result.txHash, entryProb: result.price,
            },
          });
          await db.decision.update({ where: { id: decision.id }, data: { status: "TRADED", entryProb: result.price } });
          this.stats.trades += 1;
          this.openTrades.unshift({
            id: trade.id, symbol: trade.symbol, side: trade.side, price: trade.price, size: trade.size,
            notional: trade.notional, status: "PLACED", txHash: trade.txHash, entryProb: trade.entryProb,
            lastProb: null, pnl: 0, markProb: sideVenueProb, secondsLeft: this.activeMarket?.secondsLeft ?? null,
            mode: this.mode, openedAt: trade.openedAt.toISOString(),
          });
        } else if (!result.ok) {
          await db.decision.update({ where: { id: decision.id }, data: { status: "EXEC_FAILED" } });
          this.lastError = result.detail;
        } else {
          await db.decision.update({ where: { id: decision.id }, data: { status: "HELD" } });
        }

        // Seal the gate-approved decision into the append-only trade ledger.
        await this.recordChpDecision(decision.id, outcome, chpResult, side, notional, result);
        }
      }

      await db.riskCheck.createMany({
        data: gatesResult.gates.map((g) => ({ sessionId: this.sessionId!, decisionId: decision.id, gate: g.gate, passed: g.passed, detail: g.detail })),
      });

      // 6 — SETTLE: resolve any expired positions.
      this.phase = "settling";
      await this.settleExpired();

      this.decision = {
        id: decision.id, cycle: this.cycle,
        status: outcome.consensus === "SPLIT" ? "NO_QUORUM" : !gatesResult.pass ? "VETOED" : chpRefused ? "CHP_REFUSED" : entryProb != null ? "TRADED" : "HELD",
        consensus: outcome.consensus, summary: outcome.summary, chosenSide: outcome.consensus === "SPLIT" ? null : side,
        entryProb, marketSymbol: this.activeMarket ? this.activeMarket.upSymbol.split("#")[0] : null,
        secondsLeft: this.activeMarket?.secondsLeft ?? null,
        votes: outcome.ballots, riskGates: gatesResult.gates, signals: [mom, vol, senti],
        modelProb: outcome.modelProb, venueProb,
        execDetail, txHash, at: new Date().toISOString(),
      };
      await this.audit("CYCLE", "ENGINE", {
        cycle: this.cycle, consensus: outcome.consensus, status: this.decision.status,
        modelProb: Number(outcome.modelProb.toFixed(3)), venueProb: venueProb != null ? Number(venueProb.toFixed(3)) : null,
        exec: execDetail,
      });
      this.phase = "cooldown";
      this.lastError = null;
      this.broadcast();
    } catch (e) {
      this.lastError = (e as Error).message;
      this.phase = "cooldown";
      try {
        await this.audit("ERROR", "ENGINE", { message: this.lastError?.slice(0, 300) });
      } catch { /* ledger itself failed — nothing more to do here */ }
      this.broadcast();
    } finally {
      this.busy = false;
      // A forced cycle requested mid-tick runs right after this one lands.
      if (this.pendingForce && this.status === "RUNNING") {
        this.pendingForce = false;
        void this.tickCycle(true);
      }
    }
  }

  /* ------------------------------ settlement ----------------------------- */

  private async settleExpired() {
    if (!this.sessionId || this.openTrades.length === 0) return;
    const now = Date.now() / 1000;
    const stillOpen: TradeView[] = [];
    for (const t of this.openTrades) {
      const trade = await db.trade.findUnique({ where: { id: t.id } });
      if (!trade || !trade.decisionId) { stillOpen.push(t); continue; }
      const dec = await db.decision.findUnique({ where: { id: trade.decisionId } });
      const expirySec = dec?.expiry ?? null;
      if (expirySec == null || expirySec > now) { stillOpen.push(t); continue; }

      // Expired — resolve outcome from the venue (works without a wallet).
      let win: boolean | null = null;
      let voided = false;
      let settleProb: number | null = null;
      try {
        const exchange = getAnyExchange();
        if (exchange && trade.marketId) {
          const row = await exchange.client.getBinaryMarket(trade.marketId as `0x${string}`).catch(() => null);
          const winner = row?.winningOutcome ?? null;
          const payout = (row as unknown as { payoutNumerators?: string[] | null })?.payoutNumerators ?? null;
          if (winner != null) {
            win = winner === 0 ? trade.side === "YES" : trade.side === "NO";
            settleProb = winner === 0 ? 1 : 0;
          } else if (payout && payout.length === 2) {
            const [a, b] = payout.map(Number);
            if (a > 0 && b > 0) voided = true; // uniform vector — refunded
          }
        }
      } catch { /* fall through to heuristic */ }
      if (win == null && !voided && trade.lastProb != null) {
        // Heuristic: near-expiry Up probability above 50¢ ⇒ Up side wins.
        win = trade.lastProb >= 0.5 ? trade.side === "YES" : trade.side === "NO";
      }

      let pnl = 0;
      let status = "PLACED";
      if (voided) {
        status = "REDEEMED";
        pnl = 0;
      } else if (win == null) {
        stillOpen.push(t);
        continue; // not resolvable yet — keep waiting
      } else {
        // Fixed-payout accounting: each contract pays 1 on the winning side.
        pnl = win ? trade.size * (1 - trade.price) : -trade.size * trade.price;
        status = win ? "SETTLED_WIN" : "SETTLED_LOSS";
        this.realizedPnl += pnl;
        if (win) this.stats.wins += 1; else this.stats.losses += 1;
        this.equity = this.mode === "LIVE" ? (this.collateral ?? 0) + this.realizedPnl : this.startingEquity + this.realizedPnl;

        if (this.mode === "LIVE" && win) {
          try {
            const exchange = getExchange();
            if (exchange) {
              const raw = BigInt(Math.max(1, Math.round(trade.size * 10 ** DREAMDEX.collateralDecimals)));
              await exchange.trader.redeem({ marketId: trade.marketId as `0x${string}`, outcomeIdx: trade.side === "YES" ? 0 : 1, amount: raw });
              status = "REDEEMED";
            }
          } catch (e) {
            await this.audit("SETTLEMENT", "SETTLER", { note: "auto-redeem deferred", detail: (e as Error).message.slice(0, 160), tradeId: trade.id });
          }
        }
        await this.audit("SETTLEMENT", "SETTLER", {
          tradeId: trade.id, symbol: trade.symbol, side: trade.side, outcome: win ? "WIN" : "LOSS",
          pnl: Number(pnl.toFixed(4)), settleProb, entryProb: trade.entryProb,
        });
      }
      await db.trade.update({ where: { id: trade.id }, data: { status, pnl, settleProb, settledAt: new Date(), lastProb: trade.lastProb } });
      this.settledTrades.unshift({ ...t, status, pnl, settleProb, secondsLeft: 0 });
      if (this.settledTrades.length > 30) this.settledTrades.pop();
    }
    this.openTrades = stillOpen;
    this.stats.winRate = this.stats.wins + this.stats.losses > 0 ? this.stats.wins / (this.stats.wins + this.stats.losses) : 0;
  }

  /** Refresh mark-to-market on open positions each broadcast. */
  private async markOpen() {
    if (!this.activeMarket || this.openTrades.length === 0) return;
    const q = await fetchUpQuote(this.activeMarket.upSymbol).catch(() => null);
    const mid = q && q.bestAsk != null && q.bestBid != null ? (q.bestAsk + q.bestBid) / 2 : q?.bestAsk ?? this.activeMarket.lastUpProb ?? null;
    if (mid == null) return;
    for (const t of this.openTrades) {
      t.lastProb = mid;
      // Contracts mark at the side's own probability; NO = 1 − Up.
      const sideProb = priceForSide(t.side as "YES" | "NO", mid);
      t.markProb = sideProb;
      t.pnl = t.size * (sideProb - t.price);
      t.secondsLeft = this.activeMarket.secondsLeft;
    }
    const unrealized = this.openTrades.reduce((a, t) => a + t.pnl, 0);
    this.equity = this.mode === "LIVE" ? (this.collateral ?? 0) + this.realizedPnl + unrealized : this.startingEquity + this.realizedPnl + unrealized;
  }

  /* --------------------------------- CHP ---------------------------------- */

  /** Trade decision ledger at the env-resolvable path (re-opened per use). */
  private ledger(): ChpTradeLedger {
    return new ChpTradeLedger(chpLedgerPath());
  }

  /** Seal a gate-approved trade decision into the CHP ledger (envelope + own SHA-256 body digest). */
  private async recordChpDecision(
    decisionId: string,
    outcome: CouncilOutcome,
    chp: ChpTradeGateResult,
    side: "YES" | "NO",
    notional: number,
    result: { price: number; size: number; filled: boolean; txHash: string | null; detail: string; notional: number },
  ) {
    const body = chpBody({
      decision_id: decisionId,
      asset: this.asset,
      side,
      model_prob: Number(outcome.modelProb.toFixed(6)),
      r0_verdict: chp.r0.verdict,
      r0_results: chp.r0.results,
      foundation_verdict: chp.foundation?.verdict ?? null,
      foundation_score: chp.foundation?.score ?? null,
      parity: chp.foundation?.parity ?? null,
      profile_b_state: chp.profileB?.state ?? null,
      mode: this.mode,
      lock_state: this.chpLock.state,
      confirmed_by: this.chpLock.confirmedBy,
      notional: Number(notional.toFixed(6)),
    });
    const envelope = buildPayloadEnvelope(body, "TRADE");
    await this.ledger().append({
      decision_id: decisionId,
      payload_id: envelope.payload_id,
      created_at: new Date().toISOString(),
      session_id: this.sessionId,
      cycle: this.cycle,
      asset: this.asset,
      domain: CHP.foundationDomain,
      mode: this.mode,
      session_status: this.chpLock.state,
      r0_verdict: chp.r0.verdict,
      r0_results: chp.r0.results,
      foundation_verdict: chp.foundation?.verdict ?? "REFRAME",
      foundation_score: chp.foundation?.score ?? 0,
      parity: chp.foundation?.parity ?? null,
      profile_b: chp.profileB
        ? { state: chp.profileB.state, reason: chp.profileB.reason, content_hash: chp.profileB.content_hash }
        : null,
      lock_validation: this.chpLock.lastValidation(),
      confirmed_by: this.chpLock.confirmedBy,
      execution: {
        side,
        notional: Number(result.notional.toFixed(6)),
        price: result.price,
        size: result.size,
        filled: result.filled,
        txHash: result.txHash,
        detail: result.detail,
      },
      body,
      body_sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      envelope: renderPayloadEnvelope(envelope),
    });
    await this.audit("CHP", "CHP", { event: "decision_record", decision_id: decisionId, payload_id: envelope.payload_id });
  }

  /* ---------------------------- CHP human lock ---------------------------- */

  chpStateView(): { lockState: SessionLockState; confirmedBy: string | null; requireHumanLock: boolean } {
    return { lockState: this.chpLock.state, confirmedBy: this.chpLock.confirmedBy, requireHumanLock: chpRequireHumanLock() };
  }

  /** Explicit EXPLORING → PROVISIONAL_LOCK transition (precondition for third-party validation). */
  async chpOpenProvisional() {
    const t = this.chpLock.openProvisional();
    await this.audit("CHP", "CHP", {
      event: "lock_transition", ok: t.ok, state: t.state,
      detail: t.ok ? "session opened PROVISIONAL_LOCK" : t.detail,
    });
    this.broadcast();
    return t;
  }

  /** Third-party validation: PROVISIONAL_LOCK → LOCKED with a named confirmer. */
  async chpConfirm(confirmedBy: string) {
    const t = this.chpLock.confirm(confirmedBy, this.sessionId ?? "no-session");
    await this.audit("CHP", "CHP", {
      event: "third_party_validation", ok: t.ok, state: t.state,
      validation: t.ok ? t.validation : null,
      detail: t.ok ? `session LOCKED by ${t.validation?.validator}` : t.detail,
    });
    this.broadcast();
    return t;
  }

  /* ------------------------------ audit trail ---------------------------- */

  private async audit(kind: string, actor: string, payload: unknown) {
    if (!this.sessionId) return;
    const seq = ++this.auditSeq;
    const ts = new Date();
    const payloadStr = JSON.stringify(payload);
    const hash = computeAuditHash({ seq, kind, actor, payload: payloadStr, prevHash: this.prevHash, ts });
    await db.auditEvent.create({ data: { sessionId: this.sessionId, seq, kind, actor, hash, prevHash: this.prevHash, payload: payloadStr, createdAt: ts } });
    this.prevHash = hash;
    this.auditCount = seq;
    this.auditTail.unshift({ seq, kind, actor, hash, payload: payloadStr, createdAt: ts });
    if (this.auditTail.length > 60) this.auditTail.pop();
  }

  /* ------------------------------- snapshot ------------------------------ */

  broadcast() {
    void this.markOpen().finally(() => this.emit("update", this.snapshot()));
  }

  snapshot(): Snapshot {
    const ps = prices.get(this.asset);
    return {
      status: this.status,
      mode: this.mode,
      modeReason: this.modeReason,
      asset: this.asset,
      cadenceSec: this.cadenceSec,
      cycle: this.cycle,
      phase: this.phase,
      sessionId: this.sessionId,
      wallet: this.wallet,
      collateral: this.collateral,
      equity: this.equity,
      startingEquity: this.startingEquity,
      realizedPnl: this.realizedPnl,
      price: ps ? { asset: ps.asset, price: ps.price, ema: ps.ema, source: ps.source, history: ps.history.slice(-120) } : null,
      prices: prices.all().map((p) => ({ asset: p.asset, price: p.price, source: p.source })),
      agents: this.agentPackets,
      decision: this.decision,
      openTrades: this.openTrades,
      settledTrades: this.settledTrades,
      stats: this.stats,
      auditTail: this.auditTail.map((a) => ({ seq: a.seq, kind: a.kind, actor: a.actor, hash: a.hash, payload: a.payload, at: a.createdAt.toISOString() })),
      auditCount: this.auditCount,
      chainOk: this.chainOk,
      oracleHealthy: prices.oracleHealthy,
      chp: this.chpStateView(),
      lastError: this.lastError,
      at: new Date().toISOString(),
    };
  }
}

const g = globalThis as unknown as { __dreamdeskEngine?: DeskEngine };
export const engine: DeskEngine = g.__dreamdeskEngine ?? new DeskEngine();
g.__dreamdeskEngine = engine;
