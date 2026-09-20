// Row-4 calibration tests: per-juror Brier scoring and bounded softmax weights.
import { describe, expect, it } from "vitest";
import {
  brier,
  computeJurorWeights,
  impliedProbForUp,
  jurorMeanBrier,
  softmaxShares,
  weightsFromShares,
  type ScoredBallot,
} from "@/lib/desk/calibration";

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
