import { NextResponse } from "next/server";
import { fetchMataStopsGeoJSON } from "@/lib/gtfs";

export const dynamic = "force-dynamic";

/**
 * /api/transit/mata-stops
 *
 * No query params — always returns every official MATA bus stop system-wide,
 * sourced from the same GTFS feed as /api/transit/mata-routes (see
 * lib/gtfs.ts). Loaded alongside the route lines whenever the "MATA Bus
 * Routes" overlay is switched on.
 */
export async function GET() {
  try {
    const geojson = await fetchMataStopsGeoJSON();
    return NextResponse.json(geojson, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
