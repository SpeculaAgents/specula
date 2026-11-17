"use client";
import { useState, type ReactNode } from "react";

export interface Shown {
  id: string;
  label: string;
  title: string;
  path: string;
  amount: string;
  asset: string;
  lines: string[];
  source: string;
  collected: string;
  signer: string;
  /** True only when the server recovered the engine's address from this answer's signature. */
  checked: boolean;
}

/** Colours one line of the answer: the key, then a string or a number. */
function paint(line: string): ReactNode {
  const m = line.match(/^(\s*)("[^"]+")(: )(.*)$/);
  if (!m) return <span className="p">{line}</span>;
  const [, pad, key, sep, rest] = m;
  const value = rest.match(/^(".*"|-?[\d.]+|null|true|false)(,?)$/);
  return (
    <>
      {pad}
      <span className="k">{key}</span>
      <span className="p">{sep}</span>
      {value ? (
        <>
          <span className={value[1].startsWith('"') ? "s" : "n"}>{value[1]}</span>
          <span className="p">{value[2]}</span>
        </>
      ) : (
        <span className="p">{rest}</span>
      )}
    </>
  );
}

/**
 * The hero: one request for one answer, played on the wire. Every answer shown is a real one the engine signed,
 * and the tabs move on by themselves from a price to a filing to a statistic.
 */
export function Exchange({ answers }: { answers: Shown[] }) {
  const [i, setI] = useState(0);
  if (!answers.length)
    return (
      <div className="hm-x hm-x-empty">
        <div className="hm-x-body">
          <b>The engine is starting</b>
          <span>The first signed answer shows up here as soon as it is collected.</span>
        </div>
      </div>
    );
  const a = answers[i % answers.length];
  const get = `GET ${a.path}`;
  return (
    <div className="hm-x-wrap">
      <div className="hm-x">
        <div className="hm-x-bar" role="tablist" aria-label="Answers to play">
          {answers.map((x, k) => (
            <button key={x.id} role="tab" aria-selected={k === i} onClick={() => setI(k)}>
              {x.label}
              {k === i && answers.length > 1 && (
                <i key={i} onAnimationEnd={(e) => e.animationName === "hm-fill" && setI((v) => (v + 1) % answers.length)} />
              )}
            </button>
          ))}
          <span className="hm-x-id">{a.id}</span>
        </div>
        <div className="hm-x-body" key={a.id} role="tabpanel" aria-label={`${a.title}: the request and its signed answer`}>
          <div className="hm-w out">
            <b>&gt;</b>
            <span className="hm-type" style={{ ["--n" as string]: get.length, animationTimingFunction: `steps(${get.length})` }}>{get}</span>
          </div>
          <div className="hm-w w2">
            <b>&lt;</b>
            <span>402 Payment Required</span>
            <em>exact {a.amount} {a.asset}</em>
          </div>
          <div className="hm-w out w3">
            <b>&gt;</b>
            <span>X-PAYMENT</span>
            <em>signed transfer, {a.amount} {a.asset}</em>
          </div>
          <div className="hm-w w4">
            <b>&lt;</b>
            <span className="ok">200 OK</span>
          </div>
          <pre className="hm-json">
            {a.lines.map((l, k) => (
              <span key={k} className="ln" style={{ ["--i" as string]: k }}>
                {paint(l)}
              </span>
            ))}
          </pre>
        </div>
      </div>
      <dl className="hm-rc" key={`r${a.id}`}>
        <div className="hm-rc-h">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          <div>
            <b>{a.checked ? "Signature checked" : "Signed answer"}</b>
            <span className="num">Signed by {a.signer}</span>
          </div>
        </div>
        <div className="hm-rc-r"><dt>Feed</dt><dd>{a.title}</dd></div>
        <div className="hm-rc-r"><dt>Price</dt><dd className="num">{a.amount} {a.asset}</dd></div>
        <div className="hm-rc-r"><dt>Source</dt><dd className="num">{a.source}</dd></div>
        <div className="hm-rc-r"><dt>Collected</dt><dd className="num">{a.collected}</dd></div>
      </dl>
    </div>
  );
}
