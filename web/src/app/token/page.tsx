import type { Metadata } from "next";
import Link from "next/link";
import { PageHead } from "@/components/PageHead";
import { getToken } from "@/lib/engine";
import { short, tiny, utc } from "@/lib/format";

export const metadata: Metadata = { title: "Token", description: "The Specula token and every burn of it." };

export default async function Token() {
  const t = await getToken();
  const live = !!t?.live;
  return (
    <>
      <PageHead crumb="Token" title="The Specula token">
        {live ? "Every burn of the token, read from the chain, newest first." : "The token is not live yet. When it is, every burn of it will be listed on this page with its transaction."}
      </PageHead>
      <section className="section">
        <div className="frame stack" style={{ gap: 32 }}>
          {live && (
            <dl className="kv">
              <div><dt>Burned so far</dt><dd>{tiny(t!.totalBurned ?? "0")}</dd></div>
              <div><dt>Burns</dt><dd>{t!.burns.length}</dd></div>
            </dl>
          )}
          {live && t!.burns.length > 0 ? (
            <div className="table-wrap">
              <table className="t fit">
                <thead><tr><th>When</th><th className="num">Burned</th><th>Transaction</th></tr></thead>
                <tbody>
                  {t!.burns.map((b) => (
                    <tr key={b.tx}><td className="id">{utc(b.time)}</td><td className="num">{tiny(b.amount)}</td><td className="id">{short(b.tx, 10, 8)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty"><b>No burns to show</b>{live ? "The first burn will appear here as soon as it is on chain." : "This list stays empty until the token exists."}</div>
          )}
          <p className="small" style={{ maxWidth: "70ch" }}>
            A token can lose all of its value. Nothing on this site is advice or a promise. Read <Link className="link" href="/own-risk">Own risk</Link> before you do anything with it.
          </p>
        </div>
      </section>
    </>
  );
}
