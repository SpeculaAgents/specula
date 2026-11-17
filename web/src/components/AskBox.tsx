"use client";
import { Fragment, useState } from "react";
import { utc } from "@/lib/format";

interface Cite { id: string; text: string; feed: string; source: string; collectedAt: string; digest: string }
interface Ans { question: string; answered: boolean; answer: string; citations: Cite[]; looked: string[]; model: string }
const IDEAS = ["What is NVDA trading at and what did it file last?", "How is inflation and the 10 year yield?", "Did any insider sell TSLA lately?", "What launched on the chain just now?"];

/** A question, an answer, and the signed facts under every sentence. */
export function AskBox() {
  const [q, setQ] = useState(IDEAS[0]);
  const [a, setA] = useState<Ans | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function ask(text = q) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/feeds/answers.ask?${new URLSearchParams({ q: text })}`, { cache: "no-store", headers: { "X-Specula-Client": "site" } });
      const j = await r.json();
      if (r.ok) setA(j.data as Ans);
      else setErr(r.status === 402 ? "Today's free questions are used up. An agent would now pay for this one." : (j.message ?? "The engine could not answer."));
    } catch {
      setErr("The request did not reach the site.");
    }
    setBusy(false);
  }
  const parts = a ? a.answer.split(/(\[f\d+\])/g) : [];
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="panel">
        <div className="panel-bar">Ask in plain words</div>
        <form className="cmd" style={{ borderTop: 0 }} onSubmit={(e) => (e.preventDefault(), void ask())}>
          <span>?</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} aria-label="Your question" />
          <button className="btn sm" disabled={busy}>{busy ? "Reading" : "Ask"}</button>
        </form>
        <div className="row" style={{ gap: 6, padding: 12, borderTop: "1px solid var(--line)" }}>
          {IDEAS.map((i) => <button key={i} className="chip wrap" onClick={() => (setQ(i), void ask(i))}>{i}</button>)}
        </div>
      </div>
      {err && <div className="empty"><b>No answer</b>{err}</div>}
      {a && (
        <div className="stack" style={{ gap: 18 }}>
          <p className="answer">
            {parts.map((p, i) => (/^\[f\d+\]$/.test(p) ? <a key={i} className="cite" href={`#${p.slice(1, -1)}`}>{p.slice(2, -1)}</a> : <Fragment key={i}>{p}</Fragment>))}
          </p>
          {a.citations.length > 0 && (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>#</th><th>The fact</th><th>Feed</th><th>Source</th><th>Collected</th></tr></thead>
                <tbody>
                  {a.citations.map((c) => (
                    <tr key={c.id} id={c.id}>
                      <td className="id">{c.id.slice(1)}</td>
                      <td>{c.text}</td>
                      <td className="id"><a className="link" href={`/feeds/${c.feed}`}>{c.feed}</a></td>
                      <td className="id muted">{c.source}</td>
                      <td className="id muted">{utc(c.collectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small">Written by the {a.model === "standin" ? "built-in rule model" : "hosted model"} from {a.citations.length} signed {a.citations.length === 1 ? "fact" : "facts"}. Feeds read: {a.looked.join(", ") || "none"}.</p>
        </div>
      )}
    </div>
  );
}
