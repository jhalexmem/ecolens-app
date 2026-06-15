/**
 * GET /api/readings?zip=38116
 *
 * Returns the latest environmental reading for a US zip code.
 * Checks Supabase cache first; fetches fresh data if > 15 min old.
 *
 * Response shape: ReadingsResponse (see src/types/ecolens.ts)
 */

import { NextRequest, NextResponse } from "next/server";
import { getReadingForZip } from "@/lib/fetch-and-cache";
import type { ApiError } from "@/types/ecolens";

// Tell Next.js this route is dynamic (can't be statically rendered)
export const dynamic = "force-dynamic";

const ZIP_RE = /^\d{5}$/;

export async function GET(req: NextRequest) {
  const zip = req.nextUrl.searchParams.get("zip")?.trim();

  if (!zip || !ZIP_RE.test(zip)) {
    return NextResponse.json<ApiError>(
      { error: "Missing or invalid zip code. Provide a 5-digit US zip." },
      { status: 400 }
    );
  }

  try {
    const result = await getReadingForZip(zip);

    return NextResponse.json(result, {
      status: 200,
      headers: {
        // Cache at the CDN edge for 5 minutes; stale-while-revalidate for 10 more
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[/api/readings] ${message}`);

    // 404 for unresolvable zip, 502 for upstream failures
    const status = message.includes("geocode") ? 404 : 502;
    return NextResponse.json<ApiError>({ error: message }, { status });
  }
}
