import type { Metadata } from "next";
import { getSite } from "@/lib/engine";
import { ago, price } from "@/lib/format";

export const metadata: Metadata = { title: "Price widget", robots: { index: false } };

/** A small card other sites can put in an iframe: one live on-chain price, straight from the engine. */
export default async function Embed({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const p = (await getSite())?.prices?.points.find((x) => x.symbol === symbol.toUpperCase());
  return (
    <div className="embed">
      <style>{`.top,.foot{display:none!important}.page{padding-top:0;min-height:0}body{background:transparent}.embed{padding:8px}`}</style>
      <a className="card lift" href={`https://speculaagents.fun/feeds/chain.price`} target="_blank" rel="noreferrer" style={{ maxWidth: 320, gap: 4 }}>
        <span className="row" style={{ justifyContent: "space-between" }}><span className="label"><span className="beacon" style={{ marginRight: 8 }} />{symbol.toUpperCase()}</span><span className="label">Specula</span></span>
        <span className="num" style={{ fontSize: 34, fontWeight: 500, letterSpacing: "-0.05em" }}>{p ? price(p.price, p.quote) : "n/a"}</span>
        <span className="small">{p ? (p.resting ? "market resting, last session's reading" : `on-chain reading, ${ago(p.updatedAtSec)}`) : "no on-chain price feed for this symbol"}</span>
      </a>
    </div>
  );
}
