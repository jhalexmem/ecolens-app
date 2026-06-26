import type { MetadataRoute } from "next";

// Next.js auto-detects this file and serves it at /manifest.webmanifest,
// auto-linking it from <head> — no manual <link rel="manifest"> needed.
// This is what lets Chrome/Edge offer a real "Install EcoLens" prompt and
// what Android uses for the home-screen icon/name/splash colors. iOS Safari
// ignores this in favor of the apple-* meta tags Next also auto-injects from
// metadata.appleWebApp in layout.tsx, plus src/app/apple-icon.png.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "EcoLens — MEMSouth Environmental Monitor",
    short_name: "EcoLens",
    description:
      "Real-time air quality, pollutants, and weather for any US zip code.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f4f0",
    theme_color: "#639922",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
