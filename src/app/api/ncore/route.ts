/**
 * GET /api/ncore
 *
 * Live criteria-pollutant + weather snapshot for the Shelby Farms Park
 * NCore/PAMS site — a fixed location, independent of whatever zip code the
 * user has searched. See lib/ncore.ts for sourcing details and the
 * "nearest AirNow station" honesty caveat. For archival speciated PAMS
 * data (VOCs, carbonyls, NOy), see /api/pams instead.
 *
 * fetchNcoreReading() never throws, so this route always returns 200 with
 * a reading — the map marker can be placed even if both upstream APIs
 * (AirNow, Open-Meteo) are temporarily unreachable; only the data fields
 * will be null in that case.
 */

import { NextResponse } from "next/server";
import { fetchNcoreReading } from "@/lib/ncore";
import type { ApiError, ReadingsResponse } from "@/types/ecolens";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await fetchNcoreReading();

    const response: ReadingsResponse = {
      data,
      cached: false,
      cache_age_seconds: 0,
    };

    return NextResponse.json(response, {
      status: 200,
      headers: {
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[/api/ncore] ${message}`);
    return NextResponse.json<ApiError>({ error: message }, { status: 502 });
  }
}
