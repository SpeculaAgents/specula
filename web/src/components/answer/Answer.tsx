"use client";
// An answer, drawn for a person. Every feed's data is laid out as a panel in the site's own style: the feeds with a
// shape of their own get their own layout, everything else goes through one generic layout that turns scalars into
// a grid of labelled values and lists of rows into tables. The untouched JSON stays one click away, for developers.
import type { ReactNode } from "react";
import "@/app/desk.css";
import "./answer.css";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------- small pieces ----------

const isObj = (v: unknown): v is J => typeof v === "object" && v !== null && !Array.isArray(v);
const HEX = /^0x[0-9a-fA-F]{16,}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const cut = (s: string, head = 6, tail = 4) => (s.length > head + tail + 2 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const pct = (bps: number, digits = 2) => `${(bps / 100).toFixed(digits)}%`;
/** A decimal string or number, with thousands separators and no more digits than it needs. */
function num(v: string | number, max = 6): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  // a very small price is written out in full, to four significant digits: 0.00000003438, never 3.4e-8
  if (n !== 0 && Math.abs(n) < 0.000001) return n.toFixed(Math.min(20, Math.ceil(-Math.log10(Math.abs(n))) + 3)).replace(/0+$/, "");
  return n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? Math.min(max, 4) : max });
}
const usd = (v: string | number) => (Number(v) !== 0 && Math.abs(Number(v)) < 0.01 ? `$${num(Number(Number(v).toPrecision(3)), 12)}` : `$${Number(v).toLocaleString("en-US", { maximumFractionDigits: Number(v) >= 100 ? 0 : 2 })}`);

const Hex = ({ v }: { v: string }) => <span className="av-hex" title={v}>{cut(v, v.length > 50 ? 10 : 6, v.length > 50 ? 8 : 4)}</span>;
/** A filled tag says yes or marks what matters; an outlined one says no. Never a colour. */
const Tag = ({ children, tone }: { children: ReactNode; tone?: "acc" | "up" | "dn" }) => <span className={`tm-tag${tone === "dn" ? " off" : tone ? " fill" : ""}`}>{children}</span>;
const Dim = ({ children }: { children: ReactNode }) => <span className="tm-dim">{children}</span>;

interface Col<R> {
  h: string;
  right?: boolean;
  /** This column may wrap onto more lines, so the table fits its panel. */
  wrap?: boolean;
  cell: (row: R, i: number) => ReactNode;
}
function Table<R>({ cols, rows, limit = 60 }: { cols: Col<R>[]; rows: R[]; limit?: number }) {
  const shown = rows.slice(0, limit);
  return (
    <div className="av-tw">
      <table className="av-t">
        <thead>
          <tr>{cols.map((c) => <th key={c.h} className={c.right ? "r" : undefined}>{c.h}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i}>{cols.map((c) => <td key={c.h} className={c.right ? "r" : c.wrap ? "w" : undefined}>{c.cell(row, i)}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && <p className="av-more">{rows.length - shown.length} more rows are in the raw answer.</p>}
    </div>
  );
}
const KV = ({ items }: { items: [string, ReactNode][] }) => (
  <dl className="av-kv">
    {items.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => (
      <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
    ))}
  </dl>
);
const Sec = ({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) => (
  <section className="av-sec">
    <header><h4>{title}</h4>{meta ? <span>{meta}</span> : null}</header>
    {children}
  </section>
);
const Note = ({ children }: { children: ReactNode }) => (children ? <p className="av-note">{children}</p> : null);
const Big = ({ value, unit, label }: { value: ReactNode; unit?: ReactNode; label?: ReactNode }) => (
  <div className="av-big">
    <b>{value}{unit ? <small>{unit}</small> : null}</b>
    {label ? <span>{label}</span> : null}
  </div>
);

// ---------- the generic layout ----------

const WORDS: Record<string, string> = { usd: "USD", eth: "ETH", id: "ID", cik: "CIK", url: "link", tx: "transaction", bps: "", hhi: "HHI", eps: "EPS", ms: "ms", sec: "seconds" };
/** "shareOfSupplyBps" becomes "Share of supply". */
function label(key: string): string {
  const words = key.replace(/_/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ").map((w) => WORDS[w.toLowerCase()] ?? w.toLowerCase()).filter(Boolean);
  const s = words.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** One value, shown the way its key and its shape suggest. */
function Value({ k, v }: { k: string; v: unknown }): ReactNode {
  if (v === null || v === undefined || v === "") return <Dim>none</Dim>;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") {
    if (/Bps$/.test(k)) return pct(v);
    if (/(At|Time)Sec$|^collectedAt$|^timestamp$/.test(k) && v > 1_000_000_000) return when(new Date(v * 1000).toISOString());
    return /block|round|cik|hour$/i.test(k) ? String(v) : num(v);
  }
  if (typeof v === "string") {
    if (HEX.test(v)) return <Hex v={v} />;
    if (ISO.test(v)) return when(v);
    if (/^https?:\/\//.test(v)) return <a className="av-link" href={v} target="_blank" rel="noreferrer">open</a>;
    if (/^-?\d+(\.\d+)?$/.test(v) && !/^(roundId|raw|accession|cik|id|digest)$/i.test(k)) return /Usd$/.test(k) ? usd(v) : num(v, 8);
    return v.length > 220 ? `${v.slice(0, 220)}…` : v;
  }
  if (Array.isArray(v)) return v.length ? v.slice(0, 8).map((x, i) => <span key={i} className="av-chip">{isObj(x) ? Object.values(x).filter((y) => typeof y !== "object").slice(0, 2).join(" ") : String(x)}</span>) : <Dim>none</Dim>;
  if (isObj(v)) {
    const flat = Object.entries(v).filter(([, x]) => typeof x !== "object" || x === null).slice(0, 4);
    return flat.length ? flat.map(([kk, x]) => <span key={kk} className="av-pair"><i>{label(kk)}</i> <Value k={kk} v={x} /></span>) : <Dim>{Object.keys(v).length} fields</Dim>;
  }
  return String(v);
}
/** A list of rows as a table: one column per scalar field, widest fields last. */
function RowsTable({ rows }: { rows: J[] }) {
  const keys: string[] = [];
  for (const r of rows.slice(0, 20)) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const simple = keys.filter((k) => rows.some((r) => r[k] !== null && typeof r[k] !== "object"));
  const nested = keys.filter((k) => !simple.includes(k));
  // What a row is about comes first, then when, then how much; whatever is left follows in the engine's order.
  const first = ["rank", "symbol", "ticker", "name", "title", "owner", "role", "wallet", "holder", "trader", "side", "kind", "form", "rule", "subject", "date", "period", "at", "time", "launchedAt", "filedAt", "price", "value", "valueUsd", "amount", "shares", "balance", "shareBps", "marketCapUsd", "phase"];
  const order = (k: string) => (first.indexOf(k) < 0 ? first.length : first.indexOf(k));
  const cols = [...[...simple].sort((a, b) => order(a) - order(b)), ...nested].slice(0, 8);
  return <Table rows={rows} cols={cols.map((k) => ({ h: label(k), right: rows.every((r) => typeof r[k] === "number" || (typeof r[k] === "string" && /^-?\d+(\.\d+)?$/.test(r[k]))), cell: (r: J) => <Value k={k} v={r[k]} /> }))} />;
}
function Generic({ data, depth = 0 }: { data: unknown; depth?: number }): ReactNode {
  if (Array.isArray(data)) return data.length && data.every(isObj) ? <RowsTable rows={data as J[]} /> : <KV items={[["Values", <Value key="v" k="" v={data} />]]} />;
  if (!isObj(data)) return <KV items={[["Value", <Value key="v" k="" v={data} />]]} />;
  const entries = Object.entries(data);
  const scalars = entries.filter(([, v]) => v === null || typeof v !== "object" || (Array.isArray(v) && v.every((x) => typeof x !== "object")));
  const tables = entries.filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every(isObj));
  const groups = entries.filter(([, v]) => isObj(v));
  const text = scalars.filter(([k, v]) => typeof v === "string" && v.length > 90 && !HEX.test(v) && /method|limits|note|about|summary|answer|text|why/i.test(k));
  return (
    <>
      {scalars.length > text.length && <KV items={scalars.filter((s) => !text.includes(s)).map(([k, v]) => [label(k), <Value key={k} k={k} v={v} />])} />}
      {groups.map(([k, v]) => {
        // A map of like things (series by name, tokens by address) reads best as a table with the name in front.
        const inner = Object.entries(v as J);
        const alike = inner.length >= 2 && inner.every(([, x]) => isObj(x));
        return (
          <Sec key={k} title={label(k)} meta={alike ? `${inner.length} rows` : undefined}>
            {alike ? <RowsTable rows={inner.map(([name, x]) => ({ name: label(name), ...(x as J) }))} /> : depth < 2 ? <Generic data={v} depth={depth + 1} /> : <KV items={inner.map(([kk, x]) => [label(kk), <Value key={kk} k={kk} v={x} />])} />}
          </Sec>
        );
      })}
      {tables.map(([k, v]) => (
        <Sec key={k} title={label(k)} meta={`${(v as J[]).length} rows`}>
          <RowsTable rows={v as J[]} />
        </Sec>
      ))}
      {text.map(([k, v]) => <Note key={k}><b>{label(k)}.</b> {String(v)}</Note>)}
    </>
  );
}

// ---------- feeds with a layout of their own ----------

function Agreement({ a }: { a: J }) {
  const dropped = (a.dropped ?? []) as J[];
  return (
    <div className={`av-agree${a.checked ? " ok" : ""}`}>
      <Tag tone={a.checked ? "up" : "acc"}>{a.checked ? "checked" : "not checked"}</Tag>
      <span><b>{a.agreed}</b> of <b>{a.sources}</b> {a.sources === 1 ? "source" : "sources"} agreed{a.agreedSources?.length ? <Dim> ({a.agreedSources.join(", ")})</Dim> : null}</span>
      <span>spread <b>{a.spreadBps === null || a.spreadBps === undefined ? "none to measure" : pct(a.spreadBps)}</b></span>
      <span>tolerance <b>{pct(a.toleranceBps, 0)}</b></span>
      <span>dropped <b>{dropped.length ? dropped.map((d) => `${d.source} (${d.reason})`).join(", ") : "none"}</b></span>
      {a.unreachable?.length ? <span>unreachable <b>{a.unreachable.join(", ")}</b></span> : null}
    </div>
  );
}

function Price({ d }: { d: J }) {
  return (
    <>
      <div className="av-top">
        <Big value={num(d.price, d.quote === "USD" ? 4 : 8)} unit={d.quote} label={<>{d.symbol} <Dim>{d.name}</Dim></>} />
        <KV items={[["Updated", when(d.updatedAt)], ["Age", `${num(d.ageSeconds)} s`], ["Session", d.session], ["State", d.resting ? "resting, past its heartbeat" : "live"], ["Round", <Dim key="r">{cut(String(d.roundId), 8, 6)}</Dim>], ["Feed contract", <Hex key="f" v={d.feed} />]]} />
      </div>
      {isObj(d.agreement) && <Agreement a={d.agreement} />}
    </>
  );
}

function Prices({ d }: { d: J }) {
  const a = d.agreement as J | undefined;
  return (
    <>
      {a && (
        <div className={`av-agree${a.withheld?.length ? "" : " ok"}`}>
          <Tag tone={a.withheld?.length ? "acc" : "up"}>{a.withheld?.length ? `${a.withheld.length} withheld` : "all given"}</Tag>
          <span><b>{a.checked}</b> checked against a second source</span>
          <span><b>{a.single}</b> with one source</span>
          <span>tolerance <b>{pct(a.toleranceBps, 0)}</b></span>
          <span>sources answering <b>{a.sourcesAnswered}</b> of <b>{a.sourcesKnown}</b></span>
          <span>dropped <b>{a.dropped?.length ? (a.dropped as J[]).map((x) => `${x.symbol}: ${x.source} (${x.reason})`).join(", ") : "none"}</b></span>
        </div>
      )}
      <Table
        rows={d.prices as J[]}
        limit={80}
        cols={[
          { h: "Symbol", cell: (p) => <b>{p.symbol}</b> },
          { h: "Kind", cell: (p) => <Dim>{p.kind}</Dim> },
          { h: "Price", right: true, cell: (p) => num(p.price, p.quote === "USD" ? 4 : 8) },
          { h: "In", cell: (p) => <Dim>{p.quote}</Dim> },
          { h: "Updated", cell: (p) => when(p.updatedAt) },
          { h: "State", cell: (p) => (p.resting ? <Dim>resting</Dim> : "live") },
          ...(a ? [{ h: "Agreed", right: true, cell: (p: J) => p.agreed } as Col<J>, { h: "Spread", right: true, cell: (p: J) => (p.spreadBps === null ? <Dim>one source</Dim> : pct(p.spreadBps)) } as Col<J>] : []),
        ]}
      />
      {a?.withheld?.length ? (
        <Sec title="Withheld" meta="no price given">
          <Table rows={a.withheld as J[]} cols={[{ h: "Symbol", cell: (w) => <b>{w.symbol}</b> }, { h: "Spread", right: true, cell: (w) => (w.spreadBps === null ? <Dim>none</Dim> : pct(w.spreadBps)) }, { h: "Why", cell: (w) => w.why }]} />
        </Sec>
      ) : null}
    </>
  );
}

function Twap({ d }: { d: J }) {
  const r = d.rule as J;
  const s = d.stats as J;
  const blocks = s.blocks + s.blocksTrimmed;
  const floors: [string, string, boolean][] = [
    ["Trades in the window", `${s.trades}, at least ${r.minTrades}`, s.trades >= r.minTrades],
    ["Blocks with trades, after trimming", `${s.blocks}, at least ${r.minBlocks}`, s.blocks >= r.minBlocks],
    ["Wallets trading", `${s.traders}, at least ${r.minTraders}`, s.traders >= r.minTraders],
    ["Traded in the window", s.volumeUsd === null ? "cannot be valued" : `${usd(s.volumeUsd)}, at least ${usd(r.minVolumeUsd)}`, s.volumeUsd !== null && Number(s.volumeUsd) >= r.minVolumeUsd],
    ["Age of the last trade", s.lastTradeAgeSec === null ? "no trade" : `${num(s.lastTradeAgeSec)} s, at most ${num(r.maxAgeSec)} s`, s.lastTradeAgeSec !== null && s.lastTradeAgeSec <= r.maxAgeSec],
    ["Blocks trimmed as outliers", `${s.blocksTrimmed} of ${blocks}, at most ${Math.round(r.maxTrimmedShare * 100)}%`, blocks === 0 || s.blocksTrimmed / blocks <= r.maxTrimmedShare],
  ];
  if (s.curveReserveUsd !== null) floors.push(["Held by the launch curve", `${usd(s.curveReserveUsd)}, at least ${usd(r.minCurveReserveUsd)}`, Number(s.curveReserveUsd) >= r.minCurveReserveUsd]);
  if (s.poolLiquidity !== null) floors.push(["Liquidity left in the pool", BigInt(s.poolLiquidity) > 0n ? "some remains" : "all removed", BigInt(s.poolLiquidity) > 0n]);
  return (
    <>
      <div className="av-top">
        {d.thin ? <Big value="Thin market" label="No price: too little trading or liquidity for one." /> : <Big value={num(d.price, 12)} unit={d.quoteAsset} label={<>{d.quoteAsset} for one whole {d.symbol ?? "token"}{d.priceUsd ? <Dim>, about {usd(d.priceUsd)}</Dim> : null}</>} />}
        <KV items={[["Token", <Hex key="t" v={d.token} />], ["Window", `${Math.round(d.window.seconds / 60)} minutes`], ["From", when(d.window.from)], ["To", when(d.window.to)], ["Venue", d.venue], ["Last trade counted", d.at ? when(d.at) : null]]} />
      </div>
      {d.thin && d.reasons?.length ? (
        <Sec title="Why there is no price">
          <ul className="av-list">{(d.reasons as string[]).map((x) => <li key={x}>{x}</li>)}</ul>
        </Sec>
      ) : null}
      <Sec title="Floors" meta={d.thin ? "one or more not met" : "all met"}>
        <Table rows={floors} cols={[{ h: "Check", cell: (f) => f[0] }, { h: "Reading", cell: (f) => f[1] }, { h: "Result", right: true, cell: (f) => <Tag tone={f[2] ? "up" : "dn"}>{f[2] ? "met" : "not met"}</Tag> }]} />
      </Sec>
      <Sec title="Evidence">
        <KV items={[["First block", d.evidence.firstBlock], ["Last block", d.evidence.lastBlock], ["First transaction", d.evidence.firstTx ? <Hex key="a" v={d.evidence.firstTx} /> : null], ["Last transaction", d.evidence.lastTx ? <Hex key="b" v={d.evidence.lastTx} /> : null]]} />
        {d.evidence.trimmed?.length ? <Table rows={d.evidence.trimmed as J[]} cols={[{ h: "Trimmed block", cell: (t) => t.block }, { h: "Its price", right: true, cell: (t) => num(t.price, 12) }, { h: "From the median", right: true, cell: (t) => pct(t.offBps, 0) }]} /> : null}
      </Sec>
    </>
  );
}

function Snipers({ d }: { d: J }) {
  const since = (s: J) => {
    const x = s.since as J;
    const parts: string[] = [];
    if (x.sells) parts.push(`sold ${num(x.tokensSold, 0)} in ${x.sells} ${x.sells === 1 ? "sell" : "sells"} for ${num(x.received, 5)} ETH`);
    else parts.push("no sell seen");
    if (x.stillHolds !== null) parts.push(Number(x.stillHolds) > 0 ? `holds ${num(x.stillHolds, 0)}` : "holds none");
    return parts.join(", ");
  };
  return (
    <>
      <div className="av-top">
        <Big value={d.wallets} label={<>{d.wallets === 1 ? "wallet" : "wallets"} bought {d.symbol} in the launch block or the {d.window.blocks} after it</>} />
        <KV items={[["Share of supply taken", pct(d.shareOfSupplyBps)], ["Spent", `${num(d.spent, 5)} ETH`], ["Launch block", d.launch.block], ["Launched", when(d.launch.at)], ["Deployer", <Hex key="d" v={d.launch.deployer} />], ["Token", <Hex key="t" v={d.token} />]]} />
      </div>
      {d.snipers.length ? (
        <Table
          rows={d.snipers as J[]}
          cols={[
            { h: "Wallet", cell: (s) => <><Hex v={s.wallet} /> {s.isDeployer ? <Tag tone="acc">deployer</Tag> : null}</> },
            { h: "Entry", cell: (s) => <>{s.firstBuy.blocksAfterLaunch === 0 ? "launch block" : `+${s.firstBuy.blocksAfterLaunch} ${s.firstBuy.blocksAfterLaunch === 1 ? "block" : "blocks"}`}<Dim>, {s.firstBuy.secondsAfterLaunch} s</Dim></> },
            { h: "Buys", right: true, cell: (s) => s.buys },
            { h: "Supply", right: true, cell: (s) => pct(s.shareOfSupplyBps) },
            { h: "Spent", right: true, cell: (s) => <>{num(s.spent, 4)} ETH{s.spentUsd ? <Dim> {usd(s.spentUsd)}</Dim> : null}</> },
            { h: "Since", wrap: true, cell: (s) => since(s) },
            { h: "First buy", cell: (s) => <Hex v={s.firstBuy.tx} /> },
          ]}
        />
      ) : (
        <Note>No wallet bought in that window.</Note>
      )}
      <Note>{d.method}</Note>
    </>
  );
}

const ENDED: Record<string, "up" | "dn" | "acc" | undefined> = { trading: "up", "liquidity removed": "dn", quiet: undefined, "no trades seen": undefined };
function Deployer({ d }: { d: J }) {
  const s = d.summary as J;
  return (
    <>
      <div className="av-top">
        <Big value={d.tokensLaunched} label={<>{d.tokensLaunched === 1 ? "token" : "tokens"} launched by <Hex v={d.deployer} /></>} />
        <KV items={[["Trading", s.trading], ["Gone quiet", s.quiet], ["Liquidity removed", s.liquidityRemoved], ["No trades seen", s.noTradesSeen], ["Graduated to a pool", s.graduated], ["Listed here", d.listed]]} />
      </div>
      {d.tokens.length ? (
        <ol className="av-cards">
          {(d.tokens as J[]).map((t) => (
            <li key={t.token}>
              <header>
                <b>{t.symbol}</b> <Dim>{t.name}</Dim>
                <Tag tone={ENDED[t.ended]}>{t.ended}</Tag>
              </header>
              <p>{(t.whatHappened as string[]).map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join("; ")}.</p>
              <KV
                items={[
                  ["Launched", t.launchedAt ? when(t.launchedAt) : <Dim key="l">before the indexed window</Dim>],
                  ["Trades", num(t.trades)],
                  ["Wallets", num(t.traders)],
                  ["Last trade", t.lastTradeAt ? when(t.lastTradeAt) : null],
                  ["Deployer bought", t.deployerTrades.buys ? `${t.deployerTrades.buys} times, ${num(t.deployerTrades.spent, 5)} ETH` : "never"],
                  ["Deployer sold", t.deployerTrades.sells ? `${t.deployerTrades.sells} times, ${num(t.deployerTrades.received, 5)} ETH` : "never"],
                  ["First sell", t.deployerTrades.firstSell ? <Hex key="s" v={t.deployerTrades.firstSell.tx} /> : null],
                  ["Last liquidity removal", t.liquidity?.lastRemoval ? <Hex key="r" v={t.liquidity.lastRemoval.tx} /> : null],
                  ["Token", <Hex key="t" v={t.token} />],
                ]}
              />
            </li>
          ))}
        </ol>
      ) : (
        <Note>This wallet has launched no token the index knows of.</Note>
      )}
      <Note>{d.method}</Note>
    </>
  );
}

function Clusters({ d }: { d: J }) {
  return (
    <>
      <div className="av-top">
        <Big value={d.clusters} label={<>{d.clusters === 1 ? "cluster" : "clusters"} among the wallets of {d.symbol ?? "this token"}</>} />
        <KV items={[["Wallets in clusters", d.walletsInClusters], ["Token transfers read", num(d.coverage.transfers)], ["Holder balances", d.coverage.holders ? "known" : "not read yet"], ["Token", <Hex key="t" v={d.token} />]]} />
      </div>
      {(d.list as J[]).length ? (
        <ol className="av-cards">
          {(d.list as J[]).map((c, i) => (
            <li key={i}>
              <header>
                <b>Cluster {i + 1}</b> <Dim>{c.wallets} wallets{c.shareBps !== null ? `, holding ${pct(c.shareBps)} of supply` : ""}</Dim>
                {(c.linkedBy as string[]).map((k) => <Tag key={k} tone="acc">{k}</Tag>)}
              </header>
              <div className="av-two">
                <Table rows={c.members as J[]} limit={12} cols={[{ h: "Wallet", cell: (m) => <><Hex v={m.wallet} /> {m.isDeployer ? <Tag tone="acc">deployer</Tag> : null}</> }, { h: "Holds", right: true, cell: (m) => (m.balance === null ? <Dim>not read</Dim> : num(m.balance, 0)) }, { h: "Share", right: true, cell: (m) => (m.shareBps === null ? <Dim>not read</Dim> : pct(m.shareBps)) }]} />
                <Table rows={c.evidence as J[]} limit={8} cols={[{ h: "Evidence", cell: (e) => <>{e.kind}: <Hex v={e.between[0]} /> and <Hex v={e.between[1]} /><br /><Dim>{String(e.detail).replace(/0x[0-9a-fA-F]{40}/g, (m) => cut(m)).replace(/(\d+\.\d{4})\d+/g, "$1")}</Dim></> }, { h: "Block", right: true, cell: (e) => e.block }, { h: "Transaction", cell: (e) => (e.tx ? <Hex v={e.tx} /> : <Dim>none</Dim>) }]} />
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <Note>No two wallets of this token are linked by the evidence the index holds.</Note>
      )}
      <Note>{d.method}</Note>
      <Note>{d.limits}</Note>
    </>
  );
}

function SmartMoney({ d }: { d: J }) {
  return (
    <>
      {d.wallets.length ? (
        <Table
          rows={d.wallets as J[]}
          cols={[
            { h: "#", right: true, cell: (_w, i) => i + 1 },
            { h: "Wallet", cell: (w) => <Hex v={w.wallet} /> },
            { h: "Early buys", right: true, cell: (w) => w.earlyEntries },
            { h: "Then rose", right: true, cell: (w) => <b>{w.rose}</b> },
            { h: "Share that rose", right: true, cell: (w) => pct(w.roseShareBps, 0) },
            { h: "Graduated", right: true, cell: (w) => w.graduated },
            { h: "Spent on entries", right: true, cell: (w) => `${num(w.spentOnEntries, 4)} ETH` },
            {
              h: "Evidence",
              cell: (w) => (
                <span className="av-ev">
                  {(w.evidence as J[]).slice(0, 3).map((e) => (
                    <span key={e.token} title={`entry ${e.entry.tx}, block ${e.entry.block}; later price at block ${e.later.block}`}>
                      <b>{e.symbol}</b> {e.entry.secondsAfterLaunch} s in, now <i className={e.rose ? "av-strong" : "tm-dim"}>{num(e.later.timesEntry, 2)}x</i>
                    </span>
                  ))}
                </span>
              ),
            },
          ]}
        />
      ) : (
        <Note>No wallet in the indexed window meets the bar yet.</Note>
      )}
      <Note>{d.method}</Note>
      <Note>{d.limits}</Note>
    </>
  );
}

const OWN: Record<string, (p: { d: J }) => ReactNode> = { "chain.price": Price, "chain.prices": Prices, "chain.twap": Twap, "chain.snipers": Snipers, "chain.deployer": Deployer, "chain.clusters": Clusters, "chain.smartmoney": SmartMoney };

/** True when the data has the fields a feed's own layout reads. A feed that changes shape falls back to the generic layout. */
function fits(feed: string, d: unknown): d is J {
  if (!isObj(d)) return false;
  const need: Record<string, string[]> = { "chain.price": ["price", "symbol", "updatedAt"], "chain.prices": ["prices"], "chain.twap": ["rule", "stats", "window", "evidence"], "chain.snipers": ["snipers", "launch", "window"], "chain.deployer": ["tokens", "summary"], "chain.clusters": ["list", "coverage"], "chain.smartmoney": ["wallets", "method"] };
  return (need[feed] ?? []).every((k) => k in d);
}

/**
 * `body` is whatever came back: a feed's answer (with `feed`, `data`, `source`, `proof`), any other reply of the
 * engine, or an error. `feed` and `data` may be given directly when only the data is at hand.
 */
export function Answer({ body, feed, data, title }: { body?: unknown; feed?: string | null; data?: unknown; title?: ReactNode }) {
  const b = isObj(body) ? body : null;
  const id = feed ?? (b && typeof b.feed === "string" ? b.feed : null);
  const d = data !== undefined ? data : b && "data" in b && "feed" in b ? b.data : body;
  const failed = b && typeof b.error === "string" && !("data" in b);
  const Own = id && OWN[id] && fits(id, d) ? OWN[id] : null;
  const raw = body !== undefined ? body : data;
  return (
    <div className="av">
      <header className="av-h">
        <h3>{title ?? (failed ? "No answer" : id ?? "Reply")}</h3>
        {b && typeof b.source === "string" ? <span>source <b>{b.source}</b></span> : null}
        {b && typeof b.collectedAtIso === "string" ? <span>collected <b>{when(b.collectedAtIso)}</b></span> : null}
        {b && isObj(b.proof) && typeof b.proof.engine === "string" ? <span>signed by <b title={b.proof.engine}>{cut(b.proof.engine)}</b></span> : null}
      </header>
      <div className="av-b">
        {failed ? (
          <div className="av-err">
            <Tag tone="dn">{String(b!.error).replace(/_/g, " ")}</Tag>
            <p>{typeof b!.message === "string" ? b!.message : "The engine did not answer this request."}</p>
            {isObj(b!.agreement) ? <Agreement a={b!.agreement} /> : null}
          </div>
        ) : Own ? (
          <Own d={d as J} />
        ) : (
          <Generic data={d} />
        )}
      </div>
      <details className="av-raw">
        <summary>Raw</summary>
        <pre tabIndex={0}>{JSON.stringify(raw, null, 2)}</pre>
      </details>
    </div>
  );
}
