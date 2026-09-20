// Row-4 calibration (propagation matrix, origin pythia engine.py):
// per-juror Brier scoring against settled trade outcomes, softmax'd into
// bounded per-juror weights that the council applies to ballot confidence.
//
// All functions here are pure — the engine supplies the persisted record join
// (CouncilVote ballots × settled Trade outcomes), so this module stays
// unit-testable without a database. Cold start (no scoreable history) maps to
// neutral weights of 1.0: the council behaves exactly as before calibration
// has anything to learn from.
//
// Bounded by construction: weights are clamped to [minWeight, maxWeight] and
// share softmax is temperature-scaled, so one settled trade can tilt
// conviction but cannot capture the council.

import type { JurorName, Vote } from "./council";

export type JurorWeights = Partial<Record<JurorName, number>>;

export type ScoredBallot = {
  juror: JurorName;
  /** Juror's implied probability that the UP outcome wins (null for abstains). */
  impliedProbUp: number | null;
  /** Objective outcome: 1 if UP won, 0 if DOWN won. */
  outcomeUp: number;
};

export const DEFAULT_TEMPERATURE = 0.35;
export const DEFAULT_MIN_WEIGHT = 0.6;
export const DEFAULT_MAX_WEIGHT = 1.4;

/**
 * Only genuine LLM ballots may feed Brier scoring. Heuristic fallbacks are
 * deterministic rule outputs, not the juror's probability estimate — the
 * paper run's votes were 40% heuristic, so scoring them corrupts the signal
 * in both directions (a good juror with a poor fallback is penalized; a rule
 * that gets lucky is rewarded). Rows persisted before the engine label
 * existed (null) fail closed: excluded.
 */
export function isScoreableEngine(engine: string | null | undefined): boolean {
  return engine === "llm";
}

/**
 * Join settled-outcome votes into scoreable records. Only genuine LLM
 * ballots score (`isScoreableEngine`); heuristic/null-engine ballots,
 * abstains, and votes without a settled outcome are dropped. Pure — the
 * engine supplies the persisted join.
 */
export function buildScoredBallots(
  votes: Array<{
    decisionId: string;
    juror: string;
    vote: string;
    confidence: number;
    engine: string | null;
  }>,
  outcomeUpByDecision: ReadonlyMap<string, number>,
): ScoredBallot[] {
  const jurors: JurorName[] = ["TREND", "CONTRARIAN", "SENTINEL"];
  const records: ScoredBallot[] = [];
  for (const v of votes) {
    const outcomeUp = outcomeUpByDecision.get(v.decisionId);
    if (outcomeUp == null) continue;
    const juror = jurors.find((j) => j === v.juror);
    if (!juror) continue;
    const impliedProbUp = impliedProbForUp(v.vote as "YES" | "NO" | "ABSTAIN", v.confidence);
    if (impliedProbUp == null) continue;
    if (!isScoreableEngine(v.engine)) continue;
    records.push({ juror, impliedProbUp, outcomeUp });
  }
  return records;
}

/**
 * A YES ballot on the Up contract prices Up at `confidence`; a NO ballot
 * prices Up at `1 - confidence`; ABSTAIN carries no probability.
 */
export function impliedProbForUp(vote: Vote, confidence: number): number | null {
  if (vote !== "YES" && vote !== "NO") return null; // ABSTAIN and anything unparseable carry no probability
  const conf = Math.min(1, Math.max(0, confidence));
  if (!Number.isFinite(conf)) return null;
  return vote === "YES" ? conf : 1 - conf;
}

/** Brier score of a probability against a binary outcome (0 or 1). */
export function brier(prob: number, outcome: number): number {
  return (prob - outcome) ** 2;
}

/** Mean Brier per juror over scoreable (non-abstain) records. */
export function jurorMeanBrier(
  records: ScoredBallot[],
): Partial<Record<JurorName, number>> {
  const sums: Partial<Record<JurorName, { total: number; n: number }>> = {};
  for (const r of records) {
    if (r.impliedProbUp == null || !Number.isFinite(r.impliedProbUp)) continue;
    const acc = sums[r.juror] ?? { total: 0, n: 0 };
    acc.total += brier(r.impliedProbUp, r.outcomeUp);
    acc.n += 1;
    sums[r.juror] = acc;
  }
  const means: Partial<Record<JurorName, number>> = {};
  for (const [juror, { total, n }] of Object.entries(sums) as [JurorName, { total: number; n: number }][]) {
    if (n > 0) means[juror] = total / n;
  }
  return means;
}

/**
 * Softmax over negative mean Brier (lower error → larger share), stabilized
 * by subtracting the best exponent. Jurors without a scoreable mean get the
 * floor share; shares always sum to 1.
 */
export function softmaxShares(
  meanBrier: Partial<Record<JurorName, number>>,
  temperature = DEFAULT_TEMPERATURE,
  floor = 0.05,
): Record<JurorName, number> {
  const jurors: JurorName[] = ["TREND", "CONTRARIAN", "SENTINEL"];
  const scored = jurors.filter((j) => meanBrier[j] != null && Number.isFinite(meanBrier[j] as number));
  const shares = {} as Record<JurorName, number>;
  if (scored.length === 0) {
    for (const j of jurors) shares[j] = 1 / jurors.length;
    return shares;
  }

  const finite = scored.map((j) => meanBrier[j] as number);
  const median = finite.slice().sort((a, b) => a - b)[Math.floor(finite.length / 2)];
  const scale = median > 0 ? median : 1; // avoid exp overflow on tiny errors

  const exps = scored.map((j) => -((meanBrier[j] as number) / scale) / temperature);
  const maxExp = Math.max(...exps);
  const rawSum = exps.reduce((a, e) => a + Math.exp(e - maxExp), 0);
  for (let i = 0; i < scored.length; i++) shares[scored[i]] = Math.exp(exps[i] - maxExp) / rawSum;

  // Un-scored jurors take the floor; renormalize so shares sum to 1.
  const unscored = jurors.filter((j) => !scored.includes(j));
  if (unscored.length > 0) {
    const scoredTotal = scored.reduce((a, j) => a + shares[j], 0);
    const give = Math.min(floor, scoredTotal * 0.5); // floor can never dominate
    for (const j of scored) shares[j] *= 1 - give / scoredTotal; // proportional shave
    for (const j of unscored) shares[j] = give / unscored.length;
  }
  return shares;
}

/**
 * Convert normalized shares to per-juror multipliers: an equal three-way split
 * is exactly 1.0; share deficits/surpluses scale conviction, clamped.
 */
export function weightsFromShares(
  shares: Record<JurorName, number>,
  minWeight = DEFAULT_MIN_WEIGHT,
  maxWeight = DEFAULT_MAX_WEIGHT,
): JurorWeights {
  const jurors = Object.keys(shares) as JurorName[];
  const n = jurors.length || 1;
  const weights: JurorWeights = {};
  for (const j of jurors) {
    weights[j] = Math.min(maxWeight, Math.max(minWeight, (shares[j] ?? 0) * n));
  }
  return weights;
}

/**
 * Full pipeline: scored ballots → per-juror weights. Returns {} when no
 * record is scoreable — callers treat that as all-neutral (cold start).
 */
export function computeJurorWeights(
  records: ScoredBallot[],
  opts?: { temperature?: number; minWeight?: number; maxWeight?: number },
): JurorWeights {
  const means = jurorMeanBrier(records);
  if (Object.keys(means).length === 0) return {};
  const shares = softmaxShares(means, opts?.temperature);
  return weightsFromShares(shares, opts?.minWeight, opts?.maxWeight);
}
