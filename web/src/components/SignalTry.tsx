"use client";
import { useState } from "react";

const IDEAS = ["tell me when NVDA falls 3% in an hour", "a buy over $10k on the DEX", "Tesla files an 8-K", "when bitcoin goes above $70,000", "an insider sells AAPL"];

/** Type a sentence, see the rule it becomes. Uses the same parser an agent's saved rules go through. */
export function SignalTry() {
  const [text, setText] = useState(IDEAS[0]);
  const [res, setRes] = useState<{ understood: boolean; reads: string | null; rule: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  async function parse(t = text) {
    setBusy(true);
    try {
      const r = await fetch("/api/v1/signals/parse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) });
      setRes(r.ok ? await r.json() : { understood: false, reads: null, rule: null });
    } catch {
      setRes({ understood: false, reads: null, rule: null });
    }
    setBusy(false);
  }
  return (
    <div className="panel">
      <div className="panel-bar">Say it in plain words</div>
      <form className="cmd" style={{ borderTop: 0 }} onSubmit={(e) => (e.preventDefault(), void parse())}>
        <span>&gt;</span>
        <input value={text} onChange={(e) => setText(e.target.value)} aria-label="A signal in plain words" spellCheck={false} />
        <button className="btn sm" disabled={busy}>Read it</button>
      </form>
      <div className="row" style={{ gap: 6, padding: 12, borderTop: "1px solid var(--line)" }}>
        {IDEAS.map((i) => <button key={i} className="chip wrap" onClick={() => (setText(i), void parse(i))}>{i}</button>)}
      </div>
      {res && (
        <div style={{ borderTop: "1px solid var(--line)" }}>
          <div className="runner-meta" style={{ borderTop: 0 }}>
            <span>{res.understood ? <>understood as <b>{res.reads}</b></> : <b>Not understood. Try naming a symbol, a size or an event.</b>}</span>
          </div>
          {res.understood && <pre className="out">{JSON.stringify(res.rule, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}
