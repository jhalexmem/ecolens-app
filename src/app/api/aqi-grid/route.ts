import { NextRequest, NextResponse } from "next/server";
import type { ApiError } from "@/types/ecolens";

export const dynamic = "force-dynamic";

const GRID_SIZE = 5; // 5x5 = 25 sample points per request

export interface AqiGridPoint {
  lat: number;
  lng: number;
  aqi: number | null;
}

export interface AqiGridResponse {
  points: AqiGridPoint[];
}

/**
 * /api/aqi-grid?south=...&west=...&north=...&east=...
 *
 * Samples a 5x5 grid of points across the given bounding box and fetches the
 * current consolidated U.S. AQI for all of them from Open-Meteo's Air
 * Quality API in a single batched request — same multi-location idiom as
 * /api/wind-grid, just hitting the air-quality-api host and the `us_aqi`
 * current-conditions variable instead of wind.
 *
 * This exists because the map's AQI heatmap, when fed only from whatever
 * on-screen markers happen to be loaded (the searched AirNow station, the
 * single NCore/PAMS reference site, and any located PurpleAir sensors), often
 * has too few independent values to show real spatial variation — in many
 * searches the NCore reading is itself sourced from "AirNow's nearest
 * reporting site," so it can be numerically identical to the station
 * reading. A real spatial AQI grid (modeled from CAMS atmospheric-composition
 * data) gives the heatmap actual texture to render.
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
    `https://air-quality-api.open-meteo.com/v1/air-quality` +
    `?latitude=${lats.join(",")}&longitude=${lngs.join(",")}` +
    `&current=us_aqi`;

  const res = await fetch(url, { next: { revalidate: 600 } }); // AQI shifts slowly enough for a 10-min cache

  if (!res.ok) {
    return NextResponse.json<ApiError>({ error: `Open-Meteo HTTP ${res.status}` }, { status: 502 });
  }

  const json = await res.json();
  // Open-Meteo returns a single object for one location, an array for many.
  const rows: Array<{ current?: { us_aqi?: number } }> = Array.isArray(json) ? json : [json];

  const points: AqiGridPoint[] = rows.map((r, idx) => ({
    lat: lats[idx],
    lng: lngs[idx],
    aqi: r.current?.us_aqi ?? null,
  }));

  const response: AqiGridResponse = { points };

  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "public, s-maxage=600, stale-while-revalidate=1800" },
  });
}
