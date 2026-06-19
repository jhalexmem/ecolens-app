/**
 * GET /api/pams
 *
 * Historical/archival speciated-pollutant data (PAMS: VOCs, carbonyls, NOy,
 * etc.) for the Shelby Farms Park NCore/PAMS site, sourced from EPA's AQS
 * API. This is NOT live data — AQS lags real-time by 6+ months while data
 * is QA'd, so every pollutant carries the actual date of its most recent
 * validated reading. See lib/aqs.ts for the discovery logic and
 * lib/airnow.ts for the live AQI feed this complements.
 */

import { NextResponse } from "next/server";
import { fetchPamsSummaryRecent, SHELBY_FARMS_SITE } from "@/lib/aqs";
import type { ApiError, PamsResponse } from "@/types/ecolens";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pollutants = await fetchPamsSummaryRecent();

    if (pollutants === null) {
      return NextResponse.json<ApiError>(
        {
          error: "AQS API not configured. Set AQS_API_EMAIL and AQS_API_KEY.",
          code: "AQS_NOT_CONFIGURED",
        },
        { status: 503 }
      );
    }

    const response: PamsResponse = {
      site_name: "Shelby Farms Park (NCore / PAMS)",
      site: SHELBY_FARMS_SITE,
      pollutants,
    };

    return NextResponse.json(response, {
      status: 200,
      headers: {
        // This data changes at most quarterly — cache hard at the edge.
        "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[/api/pams] ${message}`);
    return NextResponse.json<ApiError>({ error: message }, { status: 502 });
  }
}
