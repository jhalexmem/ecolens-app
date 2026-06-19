import { NextRequest, NextResponse } from "next/server";
import type { ApiError } from "@/types/ecolens";
import { queryTigerwebGeoJSON } from "@/lib/tigerweb";

export const dynamic = "force-dynamic";

// Layer 2 = "2020 Census ZIP Code Tabulation Areas" (ZCTAs) on TIGERweb's
// Current MapServer — the standard polygon proxy for ZIP codes, since USPS
// ZIP codes aren't true geographic areas. Bbox-scoped; ZCTAs don't nest
// cleanly inside states (some straddle state lines) so there's no `where`
// filter here, same as the county layer.
const ZIP_LAYER = 2;
// ZCTAs are far more numerous and more detailed than counties, so this cap
// is tighter — beyond it, skip the fetch rather than ship a huge payload.
const MAX_SPAN_DEG = 3;

/**
 * /api/boundaries/zip?south=...&west=...&north=...&east=...
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
      ZIP_LAYER,
      { south, west, north, east },
      { outFields: "GEOID,ZCTA5,NAME,BASENAME" }
    );
    return NextResponse.json(geojson, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
