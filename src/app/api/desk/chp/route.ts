// CHP surface — gate status, trade decision ledger, and the human-lock API.
//
// GET    → session lock state + the CHP trade decision records (newest first),
//          each with envelope_valid / integrity_valid re-validated on read.
// POST   → { action: "open_provisional" }  EXPLORING → PROVISIONAL_LOCK (explicit).
//          { action: "confirm", confirmed_by } PROVISIONAL_LOCK → LOCKED via
//          third-party validation; confirmed_by is required.

import { NextResponse } from "next/server";
import { engine } from "@/lib/desk/engine";
import { chpPolicy } from "@/lib/desk/chp";
import { ChpTradeLedger } from "@/lib/desk/chp-ledger";
import { chpLedgerPath } from "@/lib/desk/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const ledger = new ChpTradeLedger(chpLedgerPath());
  let decisions;
  try {
    decisions = await ledger.list(100);
  } catch (e) {
    decisions = { error: `ledger unreadable: ${(e as Error).message}` };
  }
  return NextResponse.json({
    ok: !("error" in decisions),
    lock: engine.chpStateView(),
    policy: chpPolicy(),
    ledger_path: chpLedgerPath(),
    decisions,
  });
}

export async function POST(request: Request) {
  let body: { action?: string; confirmed_by?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, detail: "Body must be JSON" }, { status: 400 });
  }

  if (body.action === "open_provisional") {
    const t = await engine.chpOpenProvisional();
    return NextResponse.json(
      { ok: t.ok, state: t.state, detail: t.ok ? "session opened PROVISIONAL_LOCK" : t.detail },
      { status: t.ok ? 200 : 409 },
    );
  }

  if (body.action === "confirm") {
    const t = await engine.chpConfirm(body.confirmed_by ?? "");
    return NextResponse.json(
      { ok: t.ok, state: t.state, validation: t.ok ? t.validation : null, detail: t.ok ? "session LOCKED" : t.detail },
      { status: t.ok ? 200 : 409 },
    );
  }

  return NextResponse.json(
    { ok: false, detail: "Unknown action — use open_provisional or confirm (with confirmed_by)" },
    { status: 400 },
  );
}
