import { NextResponse, type NextRequest } from "next/server";

const ENGINE = (process.env.SPECULA_ENGINE_URL ?? "http://127.0.0.1:4100").replace(/\/$/, "");

/**
 * A feed page that does not exist must answer 404. Pages stream behind the loading state, which fixes the status at
 * 200 before the page can say "not found", so the check happens here, before the page starts. When the engine cannot
 * be reached the request goes through and the page shows its own offline state.
 */
export async function proxy(req: NextRequest) {
  const id = decodeURIComponent(req.nextUrl.pathname.slice("/feeds/".length));
  const missing = () => NextResponse.rewrite(new URL("/404", req.url));
  if (!/^[a-z]+\.[a-z]+$/.test(id)) return missing();
  try {
    const res = await fetch(`${ENGINE}/v1/catalog/${id}`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (res.status === 404) return missing();
  } catch {
    /* the engine is down: let the page say so */
  }
  return NextResponse.next();
}

export const config = { matcher: "/feeds/:id" };
