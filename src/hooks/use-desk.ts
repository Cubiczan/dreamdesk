"use client";

// useDesk — live wire between the browser and the DeskEngine.
//
// Pulls one full snapshot from /api/desk/status, then keeps it fresh through
// the /api/desk/stream SSE channel. Exposes the desk actions (start, stop,
// force cycle, faucet) as plain async callbacks.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "@/lib/desk/engine";

export type DeskSnapshot = Snapshot & {
  canGoLive: boolean;
  resolvedMode: string;
  exchangeError: string | null;
};

const EMPTY: DeskSnapshot = {
  status: "IDLE",
  mode: "PAPER",
  modeReason: "",
  asset: "BTC",
  cadenceSec: 300,
  cycle: 0,
  phase: "idle",
  sessionId: null,
  wallet: null,
  collateral: null,
  equity: 1000,
  startingEquity: 1000,
  realizedPnl: 0,
  price: null,
  prices: [],
  agents: {
    MOMENTUM: { agent: "MOMENTUM", direction: "FLAT", strength: 0, confidence: 0, detail: "No reading yet.", data: {} },
    VOLATILITY: { agent: "VOLATILITY", direction: "FLAT", strength: 0, confidence: 0, detail: "No reading yet.", data: {} },
    SENTIMENT: { agent: "SENTIMENT", direction: "FLAT", strength: 0, confidence: 0, detail: "No reading yet.", data: {} },
  },
  decision: null,
  openTrades: [],
  chp: { lockState: "EXPLORING", confirmedBy: null, requireHumanLock: true },
  settledTrades: [],
  stats: { trades: 0, wins: 0, losses: 0, winRate: 0, cycles: 0, convenings: 0 },
  auditTail: [],
  auditCount: 0,
  chainOk: true,
  oracleHealthy: true,
  lastError: null,
  at: new Date(0).toISOString(),
  canGoLive: false,
  resolvedMode: "PAPER",
  exchangeError: null,
};

export function useDesk() {
  const [snap, setSnap] = useState<DeskSnapshot>(EMPTY);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/desk/status", { cache: "no-store" });
      if (res.ok && aliveRef.current) setSnap(await res.json());
    } catch {
      /* transient — SSE will catch us up */
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    refresh();

    const es = new EventSource("/api/desk/stream");
    esRef.current = es;
    es.onopen = () => aliveRef.current && setConnected(true);
    es.onmessage = (ev) => {
      try {
        const next = JSON.parse(ev.data) as DeskSnapshot;
        if (aliveRef.current && next && typeof next === "object" && "status" in next) setSnap(next);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.onerror = () => aliveRef.current && setConnected(false);

    return () => {
      aliveRef.current = false;
      es.close();
    };
  }, [refresh]);

  const act = useCallback(
    async (kind: "start" | "stop" | "cycle" | "faucet", body?: Record<string, unknown>) => {
      setBusy(kind);
      try {
        const res = await fetch(`/api/desk/${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
        const json = await res.json().catch(() => ({}));
        await refresh();
        return { ok: res.ok, ...(json as Record<string, unknown>) };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : "network error" };
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return { snap, connected, busy, act, refresh };
}
