import { NextRequest, NextResponse } from "next/server";
import type { ApiError } from "@/types/ecolens";

export const dynamic = "force-dynamic";

const GRID_SIZE = 5; // 5x5 = 25 sample points per request

export interface WindGridPoint {
  lat: number;
  lng: number;
  wind_speed_mph: number | null;
  wind_direction_deg: number | null;
}

export interface WindGridResponse {
  points: WindGridPoint[];
}

/**
 * /api/wind-grid?south=...&west=...&north=...&east=...
 *
 * Samples a 5x5 grid of points across the given bounding box and fetches
 * current wind speed/direction for all of them from Open-Meteo in a single
 * request — the forecast API accepts comma-separated lat/lng lists (up to
 * 1000 locations) and returns one result per location.
 * ✅ Completely free, no API key required.
 */
export async function GET(req: NextRequest) {
  const south = parseFloat(req.nextUrl.searchParams.get("south") ?? "");
  const west = parseFloat(req.nextUrl.searchParams.get("west") ?? "");
  const north = parseFloat(req.nextUrl.searchParams.get("north") ?? "");
  const east = parseFloat(req.nextUrl.searchParams.get("east") ?? "");

  if ([south, west, north, east].some((n) => Number.isNaN(n))) {
    return NextResponse.json<ApiError>(
      { error: "Missing or invalid south/west/north/east bbox params." },
      { status: 400 }
    );
  }

  const lats: number[] = [];
  const lngs: number[] = [];
  for (let i = 0; i < GRID_SIZE; i++) {
    const lat = south + ((north - south) * (i + 0.5)) / GRID_SIZE;
    for (let j = 0; j < GRID_SIZE; j++) {
      const lng = west + ((east - west) * (j + 0.5)) / GRID_SIZE;
      lats.push(Math.round(lat * 10000) / 10000);
      lngs.push(Math.round(lng * 10000) / 10000);
    }
  }

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lats.join(",")}&longitude=${lngs.join(",")}` +
    `&current=wind_speed_10m,wind_direction_10m` +
    `&wind_speed_unit=mph`;

  const res = await fetch(url, { next: { revalidate: 600 } }); // wind shifts slowly enough for a 10-min cache

  if (!res.ok) {
    return NextResponse.json<ApiError>({ error: `Open-Meteo HTTP ${res.status}` }, { status: 502 });
  }

  const json = await res.json();
  // Open-Meteo returns a single object for one location, an array for many.
  const rows: Array<{ current?: { wind_speed_10m?: number; wind_direction_10m?: number } }> = Array.isArray(json)
    ? json
    : [json];

  const points: WindGridPoint[] = rows.map((r, idx) => ({
    lat: lats[idx],
    lng: lngs[idx],
    wind_speed_mph: r.current?.wind_speed_10m ?? null,
    wind_direction_deg: r.current?.wind_direction_10m ?? null,
  }));

  const response: WindGridResponse = { points };

  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1800" },
  });
}
