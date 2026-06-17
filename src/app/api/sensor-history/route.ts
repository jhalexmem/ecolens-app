import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import type { ApiError, HistoryResponse } from "@/types/ecolens";

export const dynamic = "force-dynamic";
const MAX_HOURS = 168;

/**
 * /api/sensor-history?sensor_index=...&hours=24
 *
 * Same shape/contract as /api/history, but for a single portable PurpleAir
 * sensor instead of an AirNow zip-code station. Reuses the HistoryResponse
 * envelope — `zip_code` holds the sensor_index for this route, since the
 * trend chart only reads `res.data` and the field is otherwise unused here.
 */
export async function GET(req: NextRequest) {
  const sensorIndex = req.nextUrl.searchParams.get("sensor_index")?.trim();
  const hoursParam = req.nextUrl.searchParams.get("hours") ?? "24";
  const hours = Math.min(parseInt(hoursParam, 10) || 24, MAX_HOURS);

  if (!sensorIndex) {
    return NextResponse.json<ApiError>({ error: "Missing sensor_index." }, { status: 400 });
  }

  const { data: sensor, error: sensorErr } = await supabaseAdmin
    .from("purpleair_sensors")
    .select("id")
    .eq("sensor_index", sensorIndex)
    .maybeSingle();

  if (sensorErr) {
    return NextResponse.json<ApiError>(
      { error: `Database error: ${sensorErr.message}` },
      { status: 500 }
    );
  }

  if (!sensor) {
    return NextResponse.json<ApiError>({ error: `Unknown sensor ${sensorIndex}.` }, { status: 404 });
  }

  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from("purpleair_readings")
    .select("fetched_at, aqi, pm25")
    .eq("sensor_id", sensor.id)
    .gte("fetched_at", cutoff)
    .order("fetched_at", { ascending: true });

  if (error) {
    return NextResponse.json<ApiError>({ error: `Database error: ${error.message}` }, { status: 500 });
  }

  const response: HistoryResponse = {
    zip_code: sensorIndex, // reused field — holds sensor_index for sensor-sourced history
    hours,
    data: (rows ?? []).map((r) => ({
      fetched_at: r.fetched_at,
      aqi: r.aqi,
      pm25: r.pm25,
      o3_ppb: null,
    })),
  };

  return NextResponse.json(response, {
    status: 200,
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
  });
}
