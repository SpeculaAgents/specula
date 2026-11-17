import type { MetadataRoute } from "next";

/** Lets the site be added to a phone's home screen and open like an app, straight into the terminal. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Specula",
    short_name: "Specula",
    description: "The data terminal for AI agents.",
    start_url: "/terminal",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
      { src: "/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
