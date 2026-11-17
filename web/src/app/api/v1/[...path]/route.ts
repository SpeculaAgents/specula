import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
const ENGINE = (process.env.SPECULA_ENGINE_URL ?? "http://127.0.0.1:4100").replace(/\/$/, "");

/** What the public site may reach on the engine. Anything else, the metrics among it, is not forwarded. */
const ALLOW = /^(site|catalog(\/[a-z0-9.]+)?|feeds\/[a-z0-9.]+|status|requests|quote\/[a-z0-9.]+|events|signals(\/(parse|mine|rule_[A-Za-z0-9_-]+))?|quality|roots|proof\/0x[0-9a-fA-F]{64}|indexes|oracle\/[a-z]+:[A-Za-z0-9.]+|account|budget|receipts(\/rcpt_[A-Za-z0-9_-]+)?|credits\/topup|token|briefing|market(\/(mine|feeds(\/[a-z0-9]+)?))?|bounties(\/bnty_[A-Za-z0-9_-]+(\/offers)?)?|archive|lab(\/paper(\/paper_[A-Za-z0-9_-]+)?)?|teams(\/(mine|team_[A-Za-z0-9_-]+\/(members(\/0x[0-9a-fA-F]{40})?|budget)))?|demand)$/;

/** Until launch (SPECULA_OPEN=off) only the site itself reads the engine; agents and scripts get a clear answer. */
const OPEN = process.env.SPECULA_OPEN !== "off";
const ALWAYS = /^(site|catalog(\/[a-z0-9.]+)?|status|token)$/;

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const joined = path.join("/");
  if (!ALLOW.test(joined)) return Response.json({ error: "not_found", message: "No such route." }, { status: 404 });
  if (!OPEN && !ALWAYS.test(joined) && req.headers.get("sec-fetch-site") !== "same-origin")
    return Response.json({ error: "not_open", message: "Specula opens to agents with the $SPECULA launch. Follow @SpeculaAgents." }, { status: 503 });
  const headers = new Headers();
  for (const h of ["authorization", "x-payment", "content-type", "x-specula-client"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  // The engine meters by caller: pass the visitor's address on, as the host's proxy reported it. The host's proxy
  // appends the address it saw, so it is the last entry; the ones before it are whatever the visitor sent.
  const ip = req.headers.get("x-forwarded-for")?.split(",").map((x) => x.trim()).filter(Boolean).pop() ?? req.headers.get("x-real-ip") ?? "";
  if (ip) headers.set("x-forwarded-for", ip);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  try {
    const res = await fetch(`${ENGINE}/v1/${joined}${req.nextUrl.search}`, { method: req.method, headers, body, cache: "no-store", signal: joined === "events" ? req.signal : AbortSignal.timeout(30_000) });
    const out = new Headers({ "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" });
    for (const h of ["x-payment-response", "retry-after"]) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    if (joined === "events") out.set("x-accel-buffering", "no");
    return new Response(res.body, { status: res.status, headers: out });
  } catch {
    return Response.json({ error: "engine_unreachable", message: "The data engine did not answer. Try again in a moment." }, { status: 502 });
  }
}

export { forward as GET, forward as POST, forward as DELETE };
