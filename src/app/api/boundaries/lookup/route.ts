import { NextRequest, NextResponse } from "next/server";
import type { ApiError } from "@/types/ecolens";
import { queryTigerwebPointAttributes } from "@/lib/tigerweb";

export const dynamic = "force-dynamic";

// Same layer IDs as /api/boundaries/zip and /api/boundaries/county.
const ZIP_LAYER = 2;
const COUNTY_LAYER = 82;

// Same TNMap MapServer as /api/boundaries/congressional, /tn-house, and
// /tn-senate — see congressional/route.ts's comment for why TN's own
// service is used here instead of Census TIGERweb for these 3 layers.
// Layer IDs match those routes: 2 = Congressional, 1 = TN House, 0 = TN
// Senate.
const TN_CONGRESSIONAL_URL =
  "https://tnmap.tn.gov/arcgis/rest/services/ADMINISTRATIVE_BOUNDARIES/LEGISLATIVE_DISTRICTS/MapServer/2/query";
const TN_HOUSE_URL =
  "https://tnmap.tn.gov/arcgis/rest/services/ADMINISTRATIVE_BOUNDARIES/LEGISLATIVE_DISTRICTS/MapServer/1/query";
const TN_SENATE_URL =
  "https://tnmap.tn.gov/arcgis/rest/services/ADMINISTRATIVE_BOUNDARIES/LEGISLATIVE_DISTRICTS/MapServer/0/query";

export interface BoundaryLookupResponse {
  zip: string | null;
  county: string | null;
  district: string | null;
  repName: string | null;
  tnHouseDistrict: string | null;
  tnHouseRepName: string | null;
  tnSenateDistrict: string | null;
  tnSenateRepName: string | null;
}

// Point-in-polygon lookup against any of the 3 TNMap legislative-district
// layers above — same query shape for all three (identical field schema:
// DISTRICT + NAME), just a different layer URL.
async function queryTnLegislativeDistrict(
  url: string,
  lat: number,
  lng: number
): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "DISTRICT,NAME",
    returnGeometry: "false",
    resultRecordCount: "1",
    f: "json",
  });
  const res = await fetch(`${url}?${params.toString()}`, {
    next: { revalidate: 86400 },
  });
  if (!res.ok) {
    throw new Error(`TNMap HTTP ${res.status}`);
  }
  const data = await res.json();
  return data?.features?.[0]?.attributes ?? null;
}

/**
 * /api/boundaries/lookup?lat=...&lng=...
 *
 * Point-in-polygon lookup backing the floating ZIP/county/district
 * indicator on the map — the same five boundary sources as the toggleable
 * line overlays (/api/boundaries/zip, /county, /congressional, /tn-house,
 * /tn-senate), just queried by a single point instead of a bbox, with
 * returnGeometry off so each response is just a few attribute fields.
 *
 * The five queries are independent and run in parallel; if one source is
 * down or the point falls outside its coverage (e.g. a Mississippi/Arkansas
 * point has no TN district of any kind), that field comes back null rather
 * than failing the whole request.
 */
export async function GET(req: NextRequest) {
  const lat = parseFloat(req.nextUrl.searchParams.get("lat") ?? "");
  const lng = parseFloat(req.nextUrl.searchParams.get("lng") ?? "");

  if ([lat, lng].some((n) => Number.isNaN(n))) {
    return NextResponse.json<ApiError>(
      { error: "Missing or invalid lat/lng params." },
      { status: 400 }
    );
  }

  const [zipResult, countyResult, districtResult, tnHouseResult, tnSenateResult] =
    await Promise.allSettled([
      queryTigerwebPointAttributes(ZIP_LAYER, lat, lng, "ZCTA5,BASENAME"),
      queryTigerwebPointAttributes(COUNTY_LAYER, lat, lng, "BASENAME"),
      queryTnLegislativeDistrict(TN_CONGRESSIONAL_URL, lat, lng),
      queryTnLegislativeDistrict(TN_HOUSE_URL, lat, lng),
      queryTnLegislativeDistrict(TN_SENATE_URL, lat, lng),
    ]);

  const zipAttrs = zipResult.status === "fulfilled" ? zipResult.value : null;
  const countyAttrs = countyResult.status === "fulfilled" ? countyResult.value : null;
  const districtAttrs = districtResult.status === "fulfilled" ? districtResult.value : null;
  const tnHouseAttrs = tnHouseResult.status === "fulfilled" ? tnHouseResult.value : null;
  const tnSenateAttrs = tnSenateResult.status === "fulfilled" ? tnSenateResult.value : null;

  const response: BoundaryLookupResponse = {
    zip: (zipAttrs?.ZCTA5 as string | undefined) ?? (zipAttrs?.BASENAME as string | undefined) ?? null,
    county: (countyAttrs?.BASENAME as string | undefined) ?? null,
    district: (districtAttrs?.DISTRICT as string | undefined) ?? null,
    repName: (districtAttrs?.NAME as string | undefined) ?? null,
    tnHouseDistrict: (tnHouseAttrs?.DISTRICT as string | undefined) ?? null,
    tnHouseRepName: (tnHouseAttrs?.NAME as string | undefined) ?? null,
    tnSenateDistrict: (tnSenateAttrs?.DISTRICT as string | undefined) ?? null,
    tnSenateRepName: (tnSenateAttrs?.NAME as string | undefined) ?? null,
  };

  return NextResponse.json(response, {
    headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
  });
}
