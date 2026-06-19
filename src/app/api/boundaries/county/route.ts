import { NextRequest, NextResponse } from "next/server";
import type { ApiError } from "@/types/ecolens";
import { queryTigerwebGeoJSON } from "@/lib/tigerweb";

export const dynamic = "force-dynamic";

// Layer 82 = "Counties" on TIGERweb's Current MapServer. Bbox-scoped, not
// state-limited, so panning the Memphis metro view into Mississippi or
// Arkansas still shows their county lines too.
const COUNTY_LAYER = 82;
// Above this span a full county-layer fetch risks a multi-MB response
// (thousands of counties nationwide); skip rather than stall the map —
// the layer just shows nothing until the user zooms back in.
const MAX_SPAN_DEG = 8;

/**
 * /api/boundaries/county?south=...&west=...&north=...&east=...
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
  if (Math.max(north - south, east - west) > MAX_SPAN_DEG) {
    return NextResponse.json({ type: "FeatureCollection", features: [] });
  }

  try {
    const geojson = await queryTigerwebGeoJSON(
      COUNTY_LAYER,
      { south, west, north, east },
      { outFields: "GEOID,NAME,BASENAME,STATE,COUNTY" }
    );
    return NextResponse.json(geojson, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
