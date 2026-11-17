import type { Metadata, Viewport } from "next";
import { Suspense, type ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { NavFade } from "@/components/NavFade";
import { SITE } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: `${SITE.name}: ${SITE.tagline}`, template: `%s / ${SITE.name}` },
  description: SITE.description,
  openGraph: { title: `${SITE.name}: ${SITE.tagline}`, description: SITE.description, url: SITE.url, siteName: SITE.name, type: "website" },
  twitter: { card: "summary_large_image", site: "@SpeculaAgents", title: `${SITE.name}: ${SITE.tagline}`, description: SITE.description },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

const THEME = `(function(){var t=null;try{t=localStorage.getItem("specula-theme")}catch(e){}if(t!=="dark"){t="light"}document.documentElement.dataset.theme=t})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* The theme is set before the first paint: the visitor's saved choice, or else what their system prefers. */}
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
        <link rel="preload" href="/fonts/sans.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/mono.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
      </head>
      <body>
        <noscript>
          <style>{".reveal{opacity:1;transform:none;filter:none}.hm-w,.hm-json .ln,.hm-rc{opacity:1;animation:none}"}</style>
        </noscript>
        <Suspense fallback={null}><NavFade /></Suspense>
        <Header />
        <div className="page">
          <div className="rails" aria-hidden />
          <main>{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  );
}
