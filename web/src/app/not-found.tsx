import Link from "next/link";
import { ArrowRight } from "@/components/Icons";

export default function NotFound() {
  return (
    <section className="pagehead" style={{ paddingBottom: 120 }}>
      <div className="frame stack" style={{ gap: 18, justifyItems: "start" }}>
        <span className="eyebrow">404, nothing at this address</span>
        <h1 className="h1">The tower sees no such page.</h1>
        <p className="lede">The address may be mistyped, or the page moved.</p>
        <div className="row">
          <Link className="btn" href="/">Back to the start <ArrowRight /></Link>
          <Link className="btn ghost" href="/feeds">The feed catalog</Link>
        </div>
      </div>
    </section>
  );
}
