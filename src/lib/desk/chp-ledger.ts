// Trade decision ledger — append-only JSONL of CHP trade decision records.
//
// Ported from the erp-control-plane DecisionLedger shape: every record seals
// its decision body into a CHP payload envelope AND carries its own SHA-256
// body digest. The CHP envelope validator is STRUCTURE-ONLY — it never proves
// the body survived the trip — so reads re-validate the envelope structure
// AND the body digest, exposing `envelope_valid` and `integrity_valid`.

import { createHash } from "crypto";
import { mkdir, appendFile, readFile } from "fs/promises";
import { dirname } from "path";
import { validatePayloadEnvelope, type SessionLockState, type ChpVerdict, type R0Results, type ParityEvidence, type ThirdPartyValidation } from "./chp";

export type ChpTradeRecord = {
  decision_id: string;
  payload_id: string;
  created_at: string;
  session_id: string | null;
  cycle: number | null;
  asset: string;
  domain: string;
  mode: "LIVE" | "PAPER";
  session_status: SessionLockState;
  r0_verdict: ChpVerdict;
  r0_results: R0Results;
  foundation_verdict: ChpVerdict;
  foundation_score: number;
  parity: ParityEvidence | null;
  profile_b: { state: string; reason: string; content_hash: string } | null;
  lock_validation: ThirdPartyValidation | null;
  confirmed_by: string | null;
  execution: {
    side: string;
    notional: number;
    price: number | null;
    size: number | null;
    filled: boolean;
    txHash: string | null;
    detail: string | null;
  } | null;
  body: string; // canonical JSON of the sealed decision content
  body_sha256: string;
  envelope: string; // rendered CHP payload envelope (structure-only check)
};

export type CheckedChpRecord = ChpTradeRecord & {
  envelope_valid: boolean;
  integrity_valid: boolean;
};

/** Re-validate a record on read: envelope structure + body digest. */
export function checkRecord(entry: ChpTradeRecord): CheckedChpRecord {
  const digest = createHash("sha256").update(entry.body ?? "", "utf8").digest("hex");
  return {
    ...entry,
    envelope_valid: validatePayloadEnvelope(entry.envelope ?? ""),
    integrity_valid: digest === entry.body_sha256,
  };
}

export class ChpTradeLedger {
  constructor(private readonly path: string) {}

  /** Append one sealed record; creates the ledger and its parents on first write. */
  async append(entry: ChpTradeRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(entry) + "\n", "utf8");
  }

  /** All records, oldest-first. Malformed lines surface as a rejected read — never silently skipped. */
  async readAll(): Promise<ChpTradeRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const records: ChpTradeRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line) as ChpTradeRecord);
    }
    return records;
  }

  /** Newest-first records with envelope + body integrity re-validated on read. */
  async list(limit = 100): Promise<CheckedChpRecord[]> {
    const all = await this.readAll();
    return all.slice(-limit).map(checkRecord).reverse();
  }

  async get(decisionId: string): Promise<CheckedChpRecord | null> {
    const all = await this.readAll();
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (all[i].decision_id === decisionId) return checkRecord(all[i]);
    }
    return null;
  }

  /** Capital committed today (UTC) across integrity-valid approved records — feeds the Profile B daily cap. */
  async committedToday(now = new Date()): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    const all = await this.readAll();
    return all.reduce((sum, entry) => {
      const checked = checkRecord(entry);
      if (!checked.integrity_valid) return sum; // tampered records commit nothing
      if (!checked.created_at.startsWith(day)) return sum;
      if (checked.profile_b?.state !== "LOCKED") return sum;
      return sum + (checked.execution?.notional ?? 0);
    }, 0);
  }
}
