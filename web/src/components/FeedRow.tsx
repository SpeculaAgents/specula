import Link from "next/link";
import { pct, span } from "@/lib/format";
import type { FeedEntry } from "@/lib/types";

export function FeedRow({ f, grade }: { f: FeedEntry; grade?: string | null }) {
  return (
    <Link href={`/feeds/${f.id}`} className="feed">
      <span className="fid">{f.id}</span>
      <span className="ft" style={{ paddingRight: 96 }}>{f.title}</span>
      <span className="fp num">
        {f.price.live.amount}
        <small>USDG</small>
      </span>
      <span className="fs">{f.summary}</span>
      <span className="fm">
        <span className="chip">live for {span(f.liveForSeconds)}</span>
        <span className="chip">{f.sources.length} {f.sources.length === 1 ? "source" : "sources"}</span>
        {f.uptime24h !== null && <span className="chip on">uptime {pct(f.uptime24h, f.uptime24h === 1 ? 0 : 2)}</span>}
        {grade && <span className="chip on">quality {grade}</span>}
        {f.stream && <span className="chip">stream</span>}
      </span>
    </Link>
  );
}
