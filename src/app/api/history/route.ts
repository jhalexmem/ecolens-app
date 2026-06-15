/**
 * GET /api/history?zip=38116&hours=24
 *
 * Returns historical readings for the AQI trend chart.
 * Pulls directly from Supabase — no upstream fetch needed.
 *
 * Response shape: HistoryResponse (see src/types/ecolens.ts)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import type { ApiError, HistoryResponse } from "@/types/ecolens";

export const dynamic = "force-dynamic";

const ZIP_RE = /^\d{5}$/;
const MAX_HOURS = 168; // 7 days

export async function GET(req: NextRequest) {
  const zip = req.nextUrl.searchParams.get("zip")?.trim();
  const hoursParam = req.nextUrl.searchParams.get("hours") ?? "24";
  const hours = Math.min(parseInt(hoursParam, 10) || 24, MAX_HOURS);

  if (!zip || !ZIP_RE.test(zip)) {
    return NextResponse.json<ApiError>(
      { error: "Missing or invalid zip code." },
      { status: 400 }
    );
  }

  // Look up the location ID
  const { data: location } = await supabaseAdmin
    .from("locations")
    .select("id")
    .eq("zip_code", zip)
    .maybeSingle();

  if (!location) {
    return NextResponse.json<ApiError>(
      { error: `No data for zip ${zip}. Try /api/readings?zip=${zip} first.` },
      { status: 404 }
    );
  }

  const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from("readings")
    .select("fetched_at, aqi, pm25, o3_ppb")
    .eq("location_id", location.id)
    .gte("fetched_at", cutoff)
    .order("fetched_at", { ascending: true });

  if (error) {
    return NextResponse.json<ApiError>(
      { error: `Database error: ${error.message}` },
      { status: 500 }
    );
  }

  const response: HistoryResponse = {
    zip_code: zip,
    hours,
    data: (rows ?? []).map((r) => ({
      fetched_at: r.fetched_at,
      aqi: r.aqi,
      pm25: r.pm25,
      o3_ppb: r.o3_ppb,
    })),
  };

  return NextResponse.json(response, {
    status: 200,
    headers: {
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
