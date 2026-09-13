import { NextRequest, NextResponse } from "next/server";
import { engine } from "@/lib/desk/engine";
import { webhookSecretIsValid } from "@/lib/security";

export const dynamic = "force-dynamic";

function signatureIsValid(signature: string | null) {
  return webhookSecretIsValid(signature, process.env.UIPATH_WEBHOOK_SECRET);
}

export async function POST(req: NextRequest) {
  try {
    const signature = req.headers.get("x-uipath-signature") || req.headers.get("x-webhook-signature");
    if (!signatureIsValid(signature)) {
      return NextResponse.json({ ok: false, detail: "Invalid UiPath signature" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      asset?: string;
      cadenceSec?: number;
      mode?: "LIVE" | "PAPER";
      forceCycle?: boolean;
      source?: string;
      summary?: string;
    };

    const asset = ["BTC", "ETH"].includes((body.asset ?? "").toUpperCase()) ? body.asset!.toUpperCase() : "BTC";
    const cadenceSec = [60, 300, 3600].includes(Number(body.cadenceSec)) ? Number(body.cadenceSec) : 300;
    const mode = body.mode === "LIVE" || body.mode === "PAPER" ? body.mode : undefined;

    if (engine.status !== "RUNNING") {
      const started = await engine.start(asset, cadenceSec, mode);
      if (!started.ok) {
        return NextResponse.json({ ok: false, detail: started.detail }, { status: 409 });
      }
    }

    if (body.forceCycle !== false) {
      engine.forceCycle();
    }

    return NextResponse.json({
      ok: true,
      detail: body.summary || "UiPath handoff accepted — desk session running",
      source: body.source || "uipath",
      snapshot: engine.snapshot(),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, detail: (e as Error).message }, { status: 500 });
  }
}
