"use client";

import { useEffect } from "react";

// Registers the minimal service worker at public/sw.js — see that file's
// header comment for why it exists (Chrome/Edge installability) and why it
// deliberately does no caching. Renders nothing; this is a side-effect-only
// component mounted once from the root layout.
export default function RegisterServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Best-effort: if registration fails, the app just won't be
        // installable as a standalone app — nothing else depends on it.
      });
    }
  }, []);

  return null;
}
