import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/feeds", "/terminal", "/signals", "/ask", "/docs", "/status", "/indexes", "/verify", "/roadmap", "/changelog", "/token", "/own-risk"].map((p) => ({ url: `${SITE.url}${p}`, changeFrequency: "daily" as const }));
}
