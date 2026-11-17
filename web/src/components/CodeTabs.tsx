"use client";
import { useState } from "react";
import { paint } from "./Code";
import { Check, Copy } from "./Icons";

export function CodeTabs({ tabs }: { tabs: { label: string; code: string }[] }) {
  const [i, setI] = useState(0);
  const [copied, setCopied] = useState(false);
  const cur = tabs[i];
  return (
    <div className="codebox">
      <div className="tabs" role="tablist">
        {tabs.map((t, k) => (
          <button key={t.label} role="tab" aria-selected={k === i} onClick={() => setI(k)}>
            {t.label}
          </button>
        ))}
        <button
          style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center" }}
          onClick={() => {
            void navigator.clipboard?.writeText(cur.code.trim()).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
          aria-label="Copy the code"
        >
          <span style={{ width: 14, height: 14, display: "inline-block" }}>{copied ? <Check /> : <Copy />}</span>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code" style={{ minHeight: 320 }} dangerouslySetInnerHTML={{ __html: paint(cur.code.trim()) }} />
    </div>
  );
}
