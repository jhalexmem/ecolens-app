import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Same TNMap service (TN's own GIS service, run by the state's Office for
// Information Resources) as /api/boundaries/congressional — see that
// route's comment for why TN's own service is used instead of Census
// TIGERweb. Layer 1 on this MapServer is "House Districts": Tennessee's 99
// State House of Representatives districts.
const TN_HOUSE_URL =
  "https://tnmap.tn.gov/arcgis/rest/services/ADMINISTRATIVE_BOUNDARIES/LEGISLATIVE_DISTRICTS/MapServer/1/query";

/**
 * /api/boundaries/tn-house
 *
 * No query params — always returns all 99 TN House districts.
 */
export async function GET() {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "DISTRICT,NAME",
    outSR: "4326",
    f: "geojson",
  });

  try {
    const res = await fetch(`${TN_HOUSE_URL}?${params.toString()}`, {
      // New maps are rare; a day's cache is plenty and keeps this cheap.
      next: { revalidate: 86400 },
    });
    if (!res.ok) {
      return NextResponse.json({ error: `TNMap HTTP ${res.status}` }, { status: 502 });
    }
    const geojson = await res.json();
    return NextResponse.json(geojson, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
