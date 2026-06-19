import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Tennessee's own GIS service (TNMap, run by the state's Office for
// Information Resources), not the Census Bureau's TIGERweb. TIGERweb's
// congressional-district layer only refreshes on Census's own cycle and is
// still serving the pre-redistricting map as of this writing — stale for
// Tennessee specifically, since the legislature passed a brand-new
// congressional map in a special session signed into law May 7, 2026 (a
// response to the Supreme Court's Louisiana v. Callais ruling), cracking
// Shelby County/Memphis across three different districts. TNMap's own
// layer was republished May 27, 2026 with the new boundaries — confirmed
// by querying district 9's extent, which now stretches from Memphis
// (-90.1°) to within ~30 miles of Nashville (-86.2°), matching reporting on
// the new map's shape. That map remains the legally operative one as of
// this writing: a TRO was denied and one suit was dismissed, and a federal
// three-judge panel has not yet ruled on the still-pending injunction
// request in Sherman v. Hargett.
const TN_CONGRESSIONAL_URL =
  "https://tnmap.tn.gov/arcgis/rest/services/ADMINISTRATIVE_BOUNDARIES/LEGISLATIVE_DISTRICTS/MapServer/2/query";

/**
 * /api/boundaries/congressional
 *
 * No query params — always returns all 9 Tennessee U.S. House districts.
 */
export async function GET() {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "DISTRICT,NAME",
    outSR: "4326",
    f: "geojson",
  });

  try {
    const res = await fetch(`${TN_CONGRESSIONAL_URL}?${params.toString()}`, {
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
