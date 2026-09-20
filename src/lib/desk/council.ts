// The Council — where quant signals meet judgment.
//
// Three LLM jurors with distinct mandates (trend, contrarian, risk) each weigh
// the agent packet, the live book, and the desk's recent form, then vote
// YES (buy Up) / NO (buy Down) / ABSTAIN with a rationale. Votes are recorded
// verbatim — dissents included — so every fill traces to a debatable argument.

import { type SignalPacket } from "./agents";
import { startActiveObservation } from "@langfuse/tracing";
import type { JurorWeights } from "./calibration";

export type JurorName = "TREND" | "CONTRARIAN" | "SENTINEL";
export type Vote = "YES" | "NO" | "ABSTAIN"; // YES = buy the Up contract

export type JurorBallot = {
  juror: JurorName;
  vote: Vote;
  confidence: number;
  rationale: string;
  engine: "llm" | "heuristic";
};

export type CouncilOutcome = {
  ballots: JurorBallot[];
  consensus: "UP" | "DOWN" | "SPLIT";
  modelProb: number; // council's implied Up probability
  netConviction: number; // signed −1..1
  summary: string;
};

/**
 * Weighted net conviction: calibrated juror weights tilt the signed vote
 * balance without touching vote counts (quorum stays structural — README
 * row 4). Pure so the modelProb path that feeds the 8-cent edge gate
 * stays testable against prelint's vectors.
 */
export function weightedNetConviction(ballots: JurorBallot[], weights?: JurorWeights): number {
  const yesWeight = ballots.filter((b) => b.vote === "YES").reduce((a, b) => a + b.confidence * (weights?.[b.juror] ?? 1), 0);
  const noWeight = ballots.filter((b) => b.vote === "NO").reduce((a, b) => a + b.confidence * (weights?.[b.juror] ?? 1), 0);
  const total = yesWeight + noWeight;
  return total > 0 ? (yesWeight - noWeight) / Math.max(total, 0.001) : 0;
}

const JUROR_MANDATES: Record<JurorName, string> = {
  TREND: "You vote with momentum. You favor trades where the quant packet shows aligned directional pressure and penalize mixed readings. You would rather miss a reversal than fight a trend.",
  CONTRARIAN: "You hunt for over-reaction. When the tape looks one-way and the venue price leans extreme, you fade it. You vote against the crowd when the edge is in the reversion, not the continuation.",
  SENTINEL: "You protect capital. You abstain unless conviction is high, the tape is calm enough to trade, and the downside scenario is contained. You are the last line before money moves.",
};

export type CouncilContext = {
  asset: string;
  cadenceSec: number;
  marketSymbol: string | null;
  secondsLeft: number | null;
  upBid: number | null;
  upAsk: number | null;
  spot: number;
  priceSource: string;
  signals: SignalPacket[];
  recentForm: { cycle: number; status: string; consensus: string | null; pnl: number | null }[];
};

function packetBlock(ctx: CouncilContext): string {
  const lines = ctx.signals.map(
    (s) =>
      `- ${s.agent}: ${s.direction} (strength ${s.strength.toFixed(2)}, confidence ${s.confidence.toFixed(2)}) — ${s.detail}`
  );
  const form = ctx.recentForm.length
    ? ctx.recentForm.map((f) => `cycle ${f.cycle}: ${f.status}${f.consensus ? ` (${f.consensus})` : ""}${f.pnl != null ? ` pnl ${f.pnl.toFixed(2)}` : ""}`).join("; ")
    : "no prior cycles";
  return `ASSET: ${ctx.asset} — ${ctx.cadenceSec / 60}-minute Up/Down event contract
VENUE: dreamDEX (Somnia testnet)
MARKET: ${ctx.marketSymbol ?? "none selected"}
TIME LEFT: ${ctx.secondsLeft != null ? Math.round(ctx.secondsLeft) + "s" : "unknown"}
BOOK (Up probability): bid ${ctx.upBid != null ? (ctx.upBid * 100).toFixed(1) + "¢" : "—"} / ask ${ctx.upAsk != null ? (ctx.upAsk * 100).toFixed(1) + "¢" : "—"}
SPOT (${ctx.priceSource}): $${ctx.spot.toFixed(2)}

AGENT PACKET:
${lines.join("\n") || "(no signals)"}

DESK RECENT FORM: ${form}`;
}

function heuristicBallot(juror: JurorName, ctx: CouncilContext): JurorBallot {
  // Deterministic fallback so the demo never stalls if the LLM is unreachable.
  const momentum = ctx.signals.find((s) => s.agent === "MOMENTUM");
  const vol = ctx.signals.find((s) => s.agent === "VOLATILITY");
  const senti = ctx.signals.find((s) => s.agent === "SENTIMENT");
  const dirScore =
    (momentum?.direction === "UP" ? momentum.strength : momentum?.direction === "DOWN" ? -momentum.strength : 0) * 0.5 +
    (vol?.direction === "UP" ? vol.strength : vol?.direction === "DOWN" ? -vol.strength : 0) * 0.25 +
    (senti?.direction === "UP" ? senti.strength : senti?.direction === "DOWN" ? -senti.strength : 0) * 0.25;

  const quiet = vol?.data?.regime === "quiet";
  if (juror === "TREND") {
    const vote = dirScore > 0.25 ? "YES" : dirScore < -0.25 ? "NO" : "ABSTAIN";
    return { juror, vote, confidence: Math.min(0.9, Math.abs(dirScore) + 0.2), rationale: `Heuristic trend read: directional score ${dirScore.toFixed(2)}.`, engine: "heuristic" };
  }
  if (juror === "CONTRARIAN") {
    const lean = ctx.upAsk ?? 0.5;
    const vote = lean > 0.62 && dirScore < 0.4 ? "NO" : lean < 0.38 && dirScore > -0.4 ? "YES" : dirScore > 0.3 ? "YES" : dirScore < -0.3 ? "NO" : "ABSTAIN";
    return { juror, vote, confidence: 0.5 + Math.abs(dirScore) * 0.2, rationale: `Heuristic contrarian read: Up ask ${(lean * 100).toFixed(1)}¢ vs score ${dirScore.toFixed(2)}.`, engine: "heuristic" };
  }
  const calm = !quiet && (vol?.data?.regime === "normal" || vol?.data?.regime === undefined);
  const vote = calm && Math.abs(dirScore) > 0.3 ? (dirScore > 0 ? "YES" : "NO") : "ABSTAIN";
  return { juror, vote, confidence: calm ? 0.55 : 0.3, rationale: `Heuristic sentinel read: regime ${String(vol?.data?.regime ?? "unknown")}, score ${dirScore.toFixed(2)}.`, engine: "heuristic" };
}

async function llmBallot(juror: JurorName, ctx: CouncilContext): Promise<JurorBallot> {
  return await startActiveObservation("desk-ballot", async (span) => {
    span.update({ input: { juror, asset: ctx.asset, cadenceSec: ctx.cadenceSec } });

    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();
    const ask = () =>
      zai.chat.completions.create({
        messages: [
          {
            role: "system",
            content: `You are ${juror}, a juror on the DreamDesk trading council for dreamDEX event contracts. Your mandate: ${JUROR_MANDATES[juror]} An event contract pays a fixed payout if ${ctx.asset} closes at-or-above its opening price when the window expires ("YES"/Up) or below it ("NO"/Down). You are buying a probability, not the asset. Respond with ONLY a JSON object: {"vote":"YES"|"NO"|"ABSTAIN","confidence":0..1,"rationale":"two sentences max"}`,
          },
          { role: "user", content: packetBlock(ctx) },
        ],
        temperature: 0.4,
      });

    // One polite retry on rate limiting — then fall to the heuristic quorum.
    let completion;
    try {
      completion = await ask();
    } catch (err) {
      if (!/429|Too many/i.test(String(err))) throw err;
      await new Promise((r) => setTimeout(r, 1_800));
      completion = await ask();
    }

    const raw = completion.choices[0]?.message?.content ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no JSON in LLM response");
    const parsed = JSON.parse(match[0]) as { vote: string; confidence: number; rationale: string };
    const vote = ["YES", "NO", "ABSTAIN"].includes(parsed.vote) ? (parsed.vote as Vote) : "ABSTAIN";
    const ballot = {
      juror,
      vote,
      confidence: Math.min(1, Math.max(0, parsed.confidence)),
      rationale: parsed.rationale?.slice(0, 400) || "No rationale given.",
      engine: "llm" as const,
    };
    span.update({ output: ballot });
    return ballot;
  });
}

async function voteJuror(juror: JurorName, ctx: CouncilContext): Promise<JurorBallot> {
  try {
    return await llmBallot(juror, ctx);
  } catch {
    return heuristicBallot(juror, ctx);
  }
}

export async function conveneCouncil(ctx: CouncilContext, weights?: JurorWeights): Promise<CouncilOutcome> {
  return await startActiveObservation("desk-council", async (span) => {
    span.update({ input: { asset: ctx.asset, cadenceSec: ctx.cadenceSec, marketSymbol: ctx.marketSymbol } });

    const ballots = await Promise.all([
      voteJuror("TREND", ctx),
      voteJuror("CONTRARIAN", ctx),
      voteJuror("SENTINEL", ctx),
    ]);

    const netConviction = weightedNetConviction(ballots, weights);

    let consensus: CouncilOutcome["consensus"] = "SPLIT";
    if (netConviction > 0 && ballots.filter((b) => b.vote === "YES").length >= 2) consensus = "UP";
    else if (netConviction < 0 && ballots.filter((b) => b.vote === "NO").length >= 2) consensus = "DOWN";

    // Implied model probability: venue mid anchored by weighted conviction.
    // NOTE (row 4, documented in the README): this IS the edge-gate input —
    // calibrated weights reach it via weightedNetConviction, so under the
    // [0.6, 1.4] band a max-spread 2v1 split can move modelProb ~4 cents.
    const mid = ctx.upAsk != null && ctx.upBid != null ? (ctx.upAsk + ctx.upBid) / 2 : ctx.upAsk ?? 0.5;
    const modelProb = Math.min(0.95, Math.max(0.05, mid + netConviction * 0.15));

    const yesCount = ballots.filter((b) => b.vote === "YES").length;
    const noCount = ballots.filter((b) => b.vote === "NO").length;
    const dissent = ballots.find((b) => b.vote !== (consensus === "UP" ? "YES" : "NO") && b.vote !== "ABSTAIN");
    const summary =
      consensus === "SPLIT"
        ? `Council split ${yesCount}↑/${noCount}↓ — no trade. ${ballots.map((b) => `${b.juror}:${b.vote}`).join(" ")}`
        : `Council ${consensus === "UP" ? "UP" : "DOWN"} ${consensus === "UP" ? yesCount : noCount}/3${dissent ? ` — dissent from ${dissent.juror}` : " — unanimous"}. Model prob ${(modelProb * 100).toFixed(1)}¢ vs venue ${(mid * 100).toFixed(1)}¢.`;

    const outcome = { ballots, consensus, modelProb, netConviction, summary };
    span.update({ output: outcome });
    return outcome;
  });
}
