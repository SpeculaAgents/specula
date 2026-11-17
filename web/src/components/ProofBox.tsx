"use client";
import { useState } from "react";

/** Paste the digest of any answer and get its Merkle proof back from the engine. */
export function ProofBox({ sample }: { sample: string | null }) {
  const [d, setD] = useState(sample ?? "");
  const [out, setOut] = useState<string | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    const v = d.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) return setOut("A digest is 0x followed by 64 hex characters. It is in every answer, under proof.digest.");
    try {
      const r = await fetch(`/api/v1/proof/${v}`, { cache: "no-store" });
      setOut(JSON.stringify(await r.json(), null, 2));
    } catch {
      setOut("The request did not reach the site.");
    }
  }
  return (
    <div className="panel">
      <div className="panel-bar">Prove one answer</div>
      <form className="cmd" style={{ borderTop: 0 }} onSubmit={go}>
        <span>#</span>
        <input value={d} onChange={(e) => setD(e.target.value)} placeholder="0x... the digest of an answer" aria-label="Answer digest" spellCheck={false} />
        <button className="btn sm">Get proof</button>
      </form>
      {out && <pre className="out">{out}</pre>}
    </div>
  );
}
