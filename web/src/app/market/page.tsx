import type { Metadata } from "next";
import Link from "next/link";
import { Code } from "@/components/Code";
import { ArrowRight } from "@/components/Icons";
import { Offline, PageHead } from "@/components/PageHead";
import { Reveal } from "@/components/Reveal";
import { getBounties, getMarket, getSite } from "@/lib/engine";
import { int, pct, utc } from "@/lib/format";
import { usageShown } from "@/lib/usage";

export const metadata: Metadata = { title: "Marketplace", description: "Sell your data to AI agents through Specula. Buyers pay your wallet directly, per call. Ranked by what agents actually pay for." };

export default async function Market() {
  const [m, b, site] = await Promise.all([getMarket(), getBounties(), getSite()]);
  const usage = usageShown(site?.stats);
  const busy = !!m && (m.count > 0 || m.privateFeeds > 0 || (b?.count ?? 0) > 0);
  return (
    <>
      <PageHead crumb="Marketplace" title="Sell data to agents">
        List an endpoint, set a price per call, and agents can buy it like any other feed. The buyer pays your wallet directly. Specula never holds your money.
      </PageHead>
      <section className="section">
        <div className="frame stack" style={{ gap: 72 }}>
          {!m ? <Offline what="the marketplace" /> : (
            <>
              {busy && (
              <dl className="kv four">
                <div><dt>Feeds listed</dt><dd>{int(m.count)}</dd></div>
                <div><dt>Sellers</dt><dd>{int(m.sellers)}</dd></div>
                <div><dt>Private feeds</dt><dd>{int(m.privateFeeds)}</dd></div>
                <div><dt>Open bounties</dt><dd>{int(b?.open ?? 0)}</dd></div>
              </dl>
              )}
              {!busy && (
                <>
              <div className="grid2" style={{ alignItems: "center" }}>
                <Reveal className="stack" style={{ gap: 18 }}>
                  <h2 className="h2" style={{ fontSize: "clamp(26px, 4vw, 38px)" }}>List a feed in one call</h2>
                  <p className="body">Your endpoint is any public https address that returns JSON. Specula fetches it when an agent asks, wraps the reply in the common signed format, and the agent pays your wallet for that call.</p>
                  <ul className="stack" style={{ gap: 10 }}>
                    {[["Paid directly", "Each call is a transfer from the buyer to your wallet. No balance to withdraw."], ["No charge on failure", "If your endpoint fails, the buyer is not charged and your uptime shows it."], ["Private if you want", "Add a list of wallets and the feed exists only for them."], ["Honest signature", "The engine signs what your endpoint returned and when. It does not vouch that it is true."]].map(([t, d]) => (
                      <li key={t}><b style={{ fontWeight: 600 }}>{t}.</b> <span className="muted">{d}</span></li>
                    ))}
                  </ul>
                  <Link href="/docs#market" className="arrow">Read the seller docs <ArrowRight /></Link>
                </Reveal>
                <Reveal delay={1}>
                  <Code>{`await specula.listFeed({
  slug: "weather",
  title: "City weather now",
  summary: "Temperature and wind for a city, from a station network.",
  price: "0.25",                         // USDG per call, paid to your wallet
  url: "https://api.example.com/weather",
  params: [{ name: "city", required: true }],
  // allow: ["0xabc..."],                // private: only these wallets
});

// an agent then buys it like any feed
await specula.get("market.weather", { city: "Oslo" });`}</Code>
                </Reveal>
              </div>
                </>
              )}
              <div className="stack" style={{ gap: 20 }}>
                <div className="group-title"><h2 className="h2" style={{ fontSize: "clamp(26px, 4vw, 38px)" }}>Ranked by what agents pay for</h2><span className="label">last 30 days</span></div>
                {m.feeds.length ? (
                  <div className="feed-list">
                    {m.feeds.map((f) => (
                      <Link key={f.id} href={`/feeds/${f.id}`} className="feed">
                        <span className="fid">#{f.rank} · {f.id}</span>
                        <span className="ft" style={{ paddingRight: 96 }}>{f.title}</span>
                        <span className="fp num">{f.price}<small>USDG</small></span>
                        <span className="fs">{f.summary}</span>
                        <span className="fm">
                          {usage && <span className="chip on">{f.paid30d} USDG paid</span>}
                          {usage && <span className="chip">{f.buyers30d} {f.buyers30d === 1 ? "buyer" : "buyers"}</span>}
                          {f.uptime24h !== null && <span className="chip">uptime {pct(f.uptime24h, 0)}</span>}
                          <span className="chip">by {f.seller}</span>
                        </span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="empty"><b>No seller has listed a feed yet</b>The first listing appears here the moment it is made. The steps are below.</div>
                )}
              </div>

              {busy && (
                <>
              <div className="grid2" style={{ alignItems: "center" }}>
                <Reveal className="stack" style={{ gap: 18 }}>
                  <h2 className="h2" style={{ fontSize: "clamp(26px, 4vw, 38px)" }}>List a feed in one call</h2>
                  <p className="body">Your endpoint is any public https address that returns JSON. Specula fetches it when an agent asks, wraps the reply in the common signed format, and the agent pays your wallet for that call.</p>
                  <ul className="stack" style={{ gap: 10 }}>
                    {[["Paid directly", "Each call is a transfer from the buyer to your wallet. No balance to withdraw."], ["No charge on failure", "If your endpoint fails, the buyer is not charged and your uptime shows it."], ["Private if you want", "Add a list of wallets and the feed exists only for them."], ["Honest signature", "The engine signs what your endpoint returned and when. It does not vouch that it is true."]].map(([t, d]) => (
                      <li key={t}><b style={{ fontWeight: 600 }}>{t}.</b> <span className="muted">{d}</span></li>
                    ))}
                  </ul>
                  <Link href="/docs#market" className="arrow">Read the seller docs <ArrowRight /></Link>
                </Reveal>
                <Reveal delay={1}>
                  <Code>{`await specula.listFeed({
  slug: "weather",
  title: "City weather now",
  summary: "Temperature and wind for a city, from a station network.",
  price: "0.25",                         // USDG per call, paid to your wallet
  url: "https://api.example.com/weather",
  params: [{ name: "city", required: true }],
  // allow: ["0xabc..."],                // private: only these wallets
});

// an agent then buys it like any feed
await specula.get("market.weather", { city: "Oslo" });`}</Code>
                </Reveal>
              </div>
                </>
              )}
              <div className="stack" style={{ gap: 20 }}>
                <div className="group-title"><h2 className="h2" style={{ fontSize: "clamp(26px, 4vw, 38px)" }}>Bounties: data that does not exist yet</h2>{b && b.open > 0 && <span className="label">{b.openAmount} USDG open</span>}</div>
                <p className="body">Ask for a feed and put a reward on it. The reward is locked in an escrow contract that only you can release, to the seller who delivers, or take back after the deadline.</p>
                {b && b.bounties.length ? (
                  <div className="cards">
                    {b.bounties.map((x) => (
                      <div key={x.id} className="card lift">
                        <span className="row" style={{ justifyContent: "space-between" }}>
                          <span className={`chip ${x.status === "funded" ? "solid" : "on"}`}>{x.status}</span>
                          <span className="num" style={{ fontWeight: 500 }}>{x.amount} USDG</span>
                        </span>
                        <h3 className="h3">{x.title}</h3>
                        <p className="small">{x.detail}</p>
                        <span className="small">Until {utc(x.deadline)} · {x.offers.length} {x.offers.length === 1 ? "offer" : "offers"}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="empty"><b>No bounties posted yet</b>A bounty is shown as funded only when the escrow contract holds its reward.</div>
                )}
                <p className="small">{b?.escrow ? `Escrow contract: ${b.escrow}.` : "The escrow contract is written and tested, and is not deployed yet. Until it is, a posted bounty is a pledge and is labelled as one."}</p>
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}
