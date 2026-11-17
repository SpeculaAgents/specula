import type { NextConfig } from "next";
import path from "node:path";

const prod = process.env.NODE_ENV === "production";
// The browser only ever talks to this site: pages, /api (which forwards to the engine) and self-hosted fonts.
const csp = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join("; ");

const config: NextConfig = {
  distDir: process.env.SPECULA_DIST_DIR || ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: path.resolve(import.meta.dirname) },
  outputFileTracingRoot: path.resolve(import.meta.dirname),
  async headers() {
    const security = [
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      ...(prod ? [{ key: "Content-Security-Policy", value: csp }] : []),
    ];
    // Widgets under /embed are made to sit inside other sites; everything else refuses to be framed.
    const embed = security.filter((h) => h.key !== "X-Frame-Options").map((h) => (h.key === "Content-Security-Policy" ? { ...h, value: h.value.replace("frame-ancestors 'none'", "frame-ancestors *") } : h));
    return [
      { source: "/((?!embed/).*)", headers: security },
      { source: "/embed/:path*", headers: embed },
    ];
  },
};

export default config;
