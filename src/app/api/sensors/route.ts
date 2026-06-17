/**
 * GET /api/sensors
 *
 * Returns the latest reading for every configured portable PurpleAir
 * sensor (set via PURPLEAIR_SENSOR_INDICES). Checks Supabase cache first;
 * fetches fresh data if > 5 min old.
 *
 * Response shape: SensorsResponse (see src/types/ecolens.ts)
 */

import { NextResponse } from "next/server";
import { getPurpleAirSensorReadings } from "@/lib/fetch-and-cache-sensors";
import type { ApiError } from "@/types/ecolens";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await getPurpleAirSensorReadings();

    return NextResponse.json(result, {
      status: 200,
      headers: {
        "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[/api/sensors] ${message}`);
    return NextResponse.json<ApiError>({ error: message }, { status: 502 });
  }
}
