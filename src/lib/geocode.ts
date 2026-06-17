/**
 * geocode.ts
 *
 * Converts a US zip code (or city name) into lat/lng + display name.
 * Uses Nominatim (OpenStreetMap) — completely free, no API key.
 *
 * Rate limit: max 1 request/second. Our Supabase cache means we only
 * hit Nominatim when we see a brand-new zip code, so this is fine.
 */

import type { GeoLocation } from "@/types/ecolens";

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  address: {
    postcode?: string;
    city?: string;
    town?: string;
    village?: string;
    county?: string;
    state?: string;
    country_code?: string;
  };
}

export async function geocodeZip(zip: string): Promise<GeoLocation | null> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("postalcode", zip);
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");

  const res = await fetch(url.toString(), {
    headers: {
      // Nominatim requires a descriptive User-Agent
      "User-Agent": "EcoLens-MEMSouth/1.0 (jhalexmem@gmail.com)",
    },
    next: { revalidate: 86400 }, // cache geocode result for 24h in Next.js
  });

  if (!res.ok) return null;

  const results: NominatimResult[] = await res.json();
  if (!results.length) return null;

  const r = results[0];
  const addr = r.address;
  const city =
    addr.city ?? addr.town ?? addr.village ?? addr.county ?? null;

  return {
    zip_code: zip,
    city,
    state: addr.state ?? null,
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  };
}

/** Compass bearing from degrees (0-359) */
export function bearingLabel(deg: number): string {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ─── Reverse geocoding (lat/lng → street address) ─────────────────────────
//
// Used for the "what's the physical address of this sensor/station" popups.
// No DB table needed: addresses essentially never change for a given
// coordinate, so we lean on Next.js's fetch Data Cache (`next.revalidate`)
// instead — durable on Vercel, no migration required. This also keeps us
// comfortably within Nominatim's usage policy, since each unique sensor
// location only actually hits Nominatim once every ~30 days.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatReverseAddress(json: any): string | null {
  const a = json?.address;
  if (!a) return typeof json?.display_name === "string" ? json.display_name : null;

  const streetLine = [a.house_number, a.road ?? a.pedestrian ?? a.footway]
    .filter(Boolean)
    .join(" ");
  const city = a.city ?? a.town ?? a.village ?? a.suburb ?? a.county ?? null;
  const parts = [streetLine, city, a.state, a.postcode].filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : (json?.display_name ?? null);
}

/**
 * Returns a best-effort street address for the given coordinates, or null
 * if Nominatim has no result or the request fails. Never throws.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "EcoLens-MEMSouth/1.0 (jhalexmem@gmail.com)",
      },
      next: { revalidate: 60 * 60 * 24 * 30 }, // 30 days — addresses don't move
    });

    if (!res.ok) return null;
    const json = await res.json();
    return formatReverseAddress(json);
  } catch {
    return null;
  }
}
