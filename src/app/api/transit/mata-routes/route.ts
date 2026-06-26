import { NextResponse } from "next/server";
import { fetchMataRoutesGeoJSON } from "@/lib/gtfs";

export const dynamic = "force-dynamic";

/**
 * /api/transit/mata-routes
 *
 * No query params — always returns every MATA bus route system-wide
 * (Shelby County's transit service area). Built server-side from MATA's own
 * published GTFS static feed (see lib/gtfs.ts) rather than hand-plotted, so
 * the geometry traces real street-by-street routing.
 */
export async function GET() {
  try {
    const geojson = await fetchMataRoutesGeoJSON();
    return NextResponse.json(geojson, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
