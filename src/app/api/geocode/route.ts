import { NextRequest, NextResponse } from "next/server";
import { reverseGeocode } from "@/lib/geocode";
import type { ApiError, GeocodeResponse } from "@/types/ecolens";

export const dynamic = "force-dynamic";

/**
 * /api/geocode?lat=...&lng=...
 *
 * Reverse-geocodes a coordinate into a street address for display in map
 * popups and chip tooltips. See src/lib/geocode.ts for caching strategy.
 */
export async function GET(req: NextRequest) {
  const lat = parseFloat(req.nextUrl.searchParams.get("lat") ?? "");
  const lng = parseFloat(req.nextUrl.searchParams.get("lng") ?? "");

  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return NextResponse.json<ApiError>({ error: "Missing or invalid lat/lng." }, { status: 400 });
  }

  const address = await reverseGeocode(lat, lng);

  const response: GeocodeResponse = { address };

  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=2592000" },
  });
}
