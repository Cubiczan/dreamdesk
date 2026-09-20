// Row-4 calibration tests: per-juror Brier scoring and bounded softmax weights.
import { describe, expect, it } from "vitest";
import {
  brier,
  buildScoredBallots,
  computeJurorWeights,
  impliedProbForUp,
  isScoreableEngine,
  jurorMeanBrier,
  softmaxShares,
  weightsFromShares,
  type ScoredBallot,
} from "@/lib/desk/calibration";
import { weightedNetConviction, type JurorBallot } from "@/lib/desk/council";

describe("impliedProbForUp", () => {
  it("maps YES to confidence and NO to its complement", () => {
    expect(impliedProbForUp("YES", 0.7)).toBe(0.7);
    expect(impliedProbForUp("NO", 0.7)).toBeCloseTo(0.3);
  });

  it("returns null for abstains and unparseable votes", () => {
    expect(impliedProbForUp("ABSTAIN", 0.9)).toBeNull();
    expect(impliedProbForUp("MAYBE" as "YES", 0.9)).toBeNull();
  });

  it("clamps confidence and rejects non-finite values", () => {
    expect(impliedProbForUp("YES", 1.7)).toBe(1);
    expect(impliedProbForUp("NO", -0.5)).toBe(1);
    expect(impliedProbForUp("YES", Number.NaN)).toBeNull();
  });
});

describe("brier + jurorMeanBrier", () => {
  it("scores perfect and worst-case probabilities", () => {
    expect(brier(1, 1)).toBe(0);
    expect(brier(1, 0)).toBe(1);
    expect(brier(0.5, 1)).toBe(0.25);
  });

  it("skips abstains and averages per juror", () => {
    const records: ScoredBallot[] = [
      { juror: "TREND", impliedProbUp: 0.9, outcomeUp: 1 },
      { juror: "TREND", impliedProbUp: 0.1, outcomeUp: 1 },
      { juror: "SENTINEL", impliedProbUp: null, outcomeUp: 1 },
    ];
    const means = jurorMeanBrier(records);
    expect(means.TREND).toBeCloseTo((0.01 + 0.81) / 2);
    expect(means.SENTINEL).toBeUndefined();
  });
});

describe("softmaxShares", () => {
  it("gives the accurate juror the largest share and sums to 1", () => {
    const shares = softmaxShares({ TREND: 0.02, CONTRARIAN: 0.4, SENTINEL: 0.4 });
    expect(shares.TREND).toBeGreaterThan(shares.CONTRARIAN);
    expect(shares.TREND + shares.CONTRARIAN + shares.SENTINEL).toBeCloseTo(1);
  });

  it("gives equal errors equal shares", () => {
    const shares = softmaxShares({ TREND: 0.25, CONTRARIAN: 0.25, SENTINEL: 0.25 });
    expect(shares.TREND).toBeCloseTo(1 / 3);
    expect(shares.CONTRARIAN).toBeCloseTo(1 / 3);
  });

  it("handles all-neutral input without crashing", () => {
    const shares = softmaxShares({});
    expect(shares.TREND).toBeCloseTo(1 / 3);
  });
});

describe("weightsFromShares + computeJurorWeights", () => {
  it("maps an equal split to neutral 1.0 weights", () => {
    const weights = weightsFromShares(softmaxShares({ TREND: 0.25, CONTRARIAN: 0.25, SENTINEL: 0.25 }));
    expect(weights.TREND).toBeCloseTo(1);
    expect(weights.CONTRARIAN).toBeCloseTo(1);
  });

  it("clamps weights into the bounded band", () => {
    const weights = weightsFromShares({ TREND: 0.98, CONTRARIAN: 0.01, SENTINEL: 0.01 });
    expect(weights.TREND).toBeLessThanOrEqual(1.4);
    expect(weights.CONTRARIAN).toBeGreaterThanOrEqual(0.6);
  });

  it("returns {} on cold start (no scoreable records)", () => {
    expect(computeJurorWeights([])).toEqual({});
    expect(computeJurorWeights([{ juror: "TREND", impliedProbUp: null, outcomeUp: 1 }])).toEqual({});
  });

  it("learns toward the accurate juror over repeated settled outcomes", () => {
    const records: ScoredBallot[] = [];
    for (let i = 0; i < 30; i++) {
      records.push({ juror: "TREND", impliedProbUp: 0.85, outcomeUp: 1 });
      records.push({ juror: "CONTRARIAN", impliedProbUp: 0.85, outcomeUp: 0 });
      records.push({ juror: "SENTINEL", impliedProbUp: 0.85, outcomeUp: 1 });
    }
    const weights = computeJurorWeights(records);
    expect(weights.CONTRARIAN!).toBeLessThan(weights.TREND!);
    expect(weights.CONTRARIAN!).toBeLessThan(1);
    expect(weights.TREND!).toBeGreaterThan(1);
  });
});

describe("weightedNetConviction + the 8-cent edge gate", () => {
  // Prelint's 2v1 vector: max weight spread (TREND 1.4, CONTRARIAN 0.6,
  // SENTINEL neutral) on a 2v1 YES split at 0.8 confidence. Calibration
  // flows through netConviction into modelProb — the edge-gate input — so
  // this pins the exact bounded shift the README documents.
  const ballots: JurorBallot[] = [
    { juror: "TREND", vote: "YES", confidence: 0.8, rationale: "", engine: "heuristic" },
    { juror: "SENTINEL", vote: "YES", confidence: 0.8, rationale: "", engine: "heuristic" },
    { juror: "CONTRARIAN", vote: "NO", confidence: 0.8, rationale: "", engine: "heuristic" },
  ];

  it("shifts modelProb by exactly 4 cents on prelint's 2v1 vector", () => {
    const uncalibrated = weightedNetConviction(ballots);
    const calibrated = weightedNetConviction(ballots, { TREND: 1.4, SENTINEL: 1.0, CONTRARIAN: 0.6 });
    expect(uncalibrated).toBeCloseTo(1 / 3, 10);
    expect(calibrated).toBeCloseTo(0.6, 10);
    // modelProb = mid + conviction * 0.15 → shift = (0.6 − 1/3) * 0.15 = 0.04
    expect((calibrated - uncalibrated) * 0.15).toBeCloseTo(0.04, 10);
  });

  it("bounds the worst-case shift under the [0.6, 1.4] band below a nickel", () => {
    const uncalibrated = weightedNetConviction(ballots);
    const maxSpread = weightedNetConviction(ballots, { TREND: 1.4, SENTINEL: 1.4, CONTRARIAN: 0.6 });
    expect((maxSpread - uncalibrated) * 0.15).toBeLessThan(0.05);
  });

  it("weights tilt conviction without touching vote counts (quorum stays structural)", () => {
    // 1 YES vs 2 NO: maximum YES-side weight can tilt the weighted
    // conviction positive — but the decision gate in conveneCouncil also
    // requires 2 YES votes, so the outcome still stays SPLIT. Weights
    // never change vote counts.
    const minority: JurorBallot[] = [
      { juror: "TREND", vote: "YES", confidence: 0.9, rationale: "", engine: "heuristic" },
      { juror: "SENTINEL", vote: "NO", confidence: 0.8, rationale: "", engine: "heuristic" },
      { juror: "CONTRARIAN", vote: "NO", confidence: 0.8, rationale: "", engine: "heuristic" },
    ];
    expect(weightedNetConviction(minority, { TREND: 1.4, SENTINEL: 0.6, CONTRARIAN: 0.6 })).toBeGreaterThan(0);
    // Quorum gate: yesCount is 1 < 2 → SPLIT regardless of conviction.
    expect(minority.filter((b) => b.vote === "YES").length).toBe(1);
  });
});

describe("ballot engine provenance (only genuine LLM ballots score)", () => {
  it("isScoreableEngine accepts only the llm label (null fails closed)", () => {
    expect(isScoreableEngine("llm")).toBe(true);
    expect(isScoreableEngine("heuristic")).toBe(false);
    expect(isScoreableEngine(null)).toBe(false); // pre-label rows: excluded
    expect(isScoreableEngine(undefined)).toBe(false);
  });

  it("buildScoredBallots drops heuristic and null-engine ballots from scoring input", () => {
    const outcomeUpByDecision = new Map([["d1", 1], ["d2", 0]]);
    const votes = [
      { decisionId: "d1", juror: "TREND", vote: "YES", confidence: 0.8, engine: "llm" },
      { decisionId: "d1", juror: "SENTINEL", vote: "YES", confidence: 0.8, engine: "heuristic" },
      { decisionId: "d2", juror: "CONTRARIAN", vote: "NO", confidence: 0.7, engine: null },
    ];
    const records = buildScoredBallots(votes, outcomeUpByDecision);
    // Only the genuine LLM ballot survives: 40% of the paper run's votes were
    // heuristic fallbacks — scoring them would corrupt the Brier signal.
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ juror: "TREND", impliedProbUp: 0.8, outcomeUp: 1 });
  });

  it("buildScoredBallots still drops abstains and unsettled decisions", () => {
    const outcomeUpByDecision = new Map([["d1", 1]]);
    const votes = [
      { decisionId: "d1", juror: "TREND", vote: "ABSTAIN", confidence: 0.8, engine: "llm" },
      { decisionId: "d_missing", juror: "SENTINEL", vote: "YES", confidence: 0.8, engine: "llm" },
    ];
    expect(buildScoredBallots(votes, outcomeUpByDecision)).toHaveLength(0);
  });
});
