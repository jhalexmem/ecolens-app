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
