"use client";
import { useState } from "react";
import { checkSignature } from "@/lib/verify";
import type { Param } from "@/lib/types";
import { Answer } from "./answer/Answer";
import { Play } from "./Icons";

interface Result {
  status: number;
  ms: number;
  body: unknown;
  signed: boolean | null;
}

/**
 * Runs a real request against the live engine from the page and shows exactly what came back. Used for the catalog's
 * "try it" and for every example in the docs. Requests go through the free allowance like anyone else's.
 */
export function Runner({ path, params = [], initial = {}, method = "GET", body, label = "Run" }: { path: string; params?: Param[]; initial?: Record<string, string>; method?: "GET" | "POST"; body?: string; label?: string }) {
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [text, setText] = useState(body ?? "");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const qs = new URLSearchParams(Object.entries(values).filter(([, v]) => v !== "")).toString();
  const url = params.length ? `${path}${qs ? `?${qs}` : ""}` : path;

  async function run() {
    setBusy(true);
    const t0 = performance.now();
    try {
      const r = await fetch(`/api${url}`, { method, cache: "no-store", headers: { "X-Specula-Client": "site", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }, body: method === "POST" ? text : undefined });
      const json = (await r.json().catch(() => ({ error: "bad_response" }))) as Record<string, unknown>;
      let signed: boolean | null = null;
      if (r.ok && json.proof) signed = await checkSignature(json as never).catch(() => false);
      setRes({ status: r.status, ms: Math.round(performance.now() - t0), body: json, signed });
    } catch {
      setRes({ status: 0, ms: Math.round(performance.now() - t0), body: { error: "network", message: "The request did not reach the site." }, signed: null });
    }
    setBusy(false);
  }
  const meta = (res?.body as { meta?: { paidBy: string; price: { amount: string }; cached: boolean; ageSeconds: number }; source?: string } | undefined) ?? undefined;
  return (
    <div className="runner">
      {params.length > 0 && (
        <div style={{ display: "grid", gap: 12, padding: 16, borderBottom: "1px solid var(--line)", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          {params.map((p) => (
            <label key={p.name} className="stack" style={{ gap: 4 }}>
              <span className="label">{p.name}{p.required ? " (required)" : ""}</span>
              {p.type === "enum" && p.values ? (
                <select className="field" value={values[p.name] ?? p.default ?? ""} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })}>
                  {!p.required && !p.default && <option value="">any</option>}
                  {p.values.map((v) => <option key={v}>{v}</option>)}
                </select>
              ) : (
                <input className="field" value={values[p.name] ?? ""} placeholder={p.default ?? p.type} onChange={(e) => setValues({ ...values, [p.name]: e.target.value })} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
              )}
            </label>
          ))}
        </div>
      )}
      {method === "POST" && body !== undefined && <textarea className="field" style={{ border: 0, borderBottom: "1px solid var(--line)", borderRadius: 0 }} rows={3} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label="Request body" />}
      <div className="runner-bar">
        <span className="chip solid">{method}</span>
        <code title={url}>{url}</code>
        <button className="btn sm" onClick={run} disabled={busy}>
          <Play /> {busy ? "Asking" : label}
        </button>
      </div>
      {res && (
        <>
          <div className="runner-ans"><Answer body={res.body} /></div>
          <div className="runner-meta">
            <span>status <b>{res.status || "none"}</b></span>
            <span>took <b>{res.ms} ms</b></span>
            {meta?.source && <span>source <b>{meta.source}</b></span>}
            {meta?.meta && <span>paid by <b>{meta.meta.paidBy === "free" ? "free allowance" : `${meta.meta.price.amount} USDG`}</b></span>}
            {meta?.meta && <span>age <b>{meta.meta.ageSeconds}s</b></span>}
            {res.signed !== null && <span>signature <b>{res.signed ? "valid, checked in your browser" : "did not match"}</b></span>}
          </div>
        </>
      )}
    </div>
  );
}
