import { NextResponse } from "next/server";
import { queryTigerwebGeoJSON } from "@/lib/tigerweb";

export const dynamic = "force-dynamic";

// Layer 54 = "119th Congressional Districts" on TIGERweb's Current
// MapServer. Scoped to Tennessee only (STATE FIPS '47') per the request —
// a fixed set of 9 districts, so this is fetched once when the overlay is
// toggled on rather than refetched on pan/zoom like the county/zip layers.
const CONGRESSIONAL_LAYER = 54;
const TENNESSEE_FIPS = "47";
// A loose whole-state envelope — the real filter is the `where` clause
// below; the geometry intersects check is just a formality TIGERweb wants.
const TN_BBOX = { south: 34.0, west: -90.4, north: 36.7, east: -81.6 };

/**
 * /api/boundaries/congressional
 *
 * No query params — always returns all 9 Tennessee U.S. House districts.
 */
export async function GET() {
  try {
    const geojson = await queryTigerwebGeoJSON(CONGRESSIONAL_LAYER, TN_BBOX, {
      where: `STATE='${TENNESSEE_FIPS}'`,
      outFields: "GEOID,NAME,BASENAME,CD119,STATE",
    });
    return NextResponse.json(geojson, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
