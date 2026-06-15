/**
 * fetch-and-cache.ts
 *
 * Orchestrates the full data pipeline for a given zip code:
 *
 *  1. Look up the location in Supabase (geocode via Nominatim if new)
 *  2. Check if a fresh reading exists (< CACHE_TTL_SECONDS old)
 *  3. If stale or missing: fetch Open-Meteo + AirNow in parallel
 *  4. Persist the new reading to Supabase
 *  5. Return the reading plus cache metadata
 *
 * This is the single entry point called by both API routes.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { geocodeZip } from "@/lib/geocode";
import { fetchOpenMeteo } from "@/lib/openmeteo";
import { fetchAirNow } from "@/lib/airnow";
import type { AirQualityReading } from "@/types/ecolens";

/** Return cached data if it's younger than this */
const CACHE_TTL_SECONDS = 15 * 60; // 15 minutes

export interface FetchResult {
  data: AirQualityReading;
  cached: boolean;
  cache_age_seconds: number;
}

export async function getReadingForZip(zip: string): Promise<FetchResult> {
  // ── 1. Resolve location ──────────────────────────────────────────────────
  let { data: location, error: locErr } = await supabaseAdmin
    .from("locations")
    .select("*")
    .eq("zip_code", zip)
    .maybeSingle();

  if (locErr) throw new Error(`Supabase location lookup failed: ${locErr.message}`);

  if (!location) {
    // First time we've seen this zip — geocode it
    const geo = await geocodeZip(zip);
    if (!geo) throw new Error(`Could not geocode zip code: ${zip}`);

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from("locations")
      .insert({
        zip_code: zip,
        city: geo.city,
        state: geo.state,
        lat: geo.lat,
        lng: geo.lng,
      })
      .select()
      .single();

    if (insertErr) throw new Error(`Could not insert location: ${insertErr.message}`);
    location = inserted;
  }

  // ── 2. Check cache ───────────────────────────────────────────────────────
  const cutoff = new Date(Date.now() - CACHE_TTL_SECONDS * 1000).toISOString();

  const { data: cached, error: cacheErr } = await supabaseAdmin
    .from("readings")
    .select("*")
    .eq("location_id", location.id)
    .gte("fetched_at", cutoff)
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cacheErr) throw new Error(`Supabase cache check failed: ${cacheErr.message}`);

  if (cached) {
    const ageMs = Date.now() - new Date(cached.fetched_at).getTime();
    return {
      data: rowToReading(cached, location),
      cached: true,
      cache_age_seconds: Math.round(ageMs / 1000),
    };
  }

  // ── 3. Fetch fresh data ──────────────────────────────────────────────────
  const [openmeteo, airnow] = await Promise.allSettled([
    fetchOpenMeteo(location.lat, location.lng),
    fetchAirNow(zip),
  ]);

  const om = openmeteo.status === "fulfilled" ? openmeteo.value : null;
  const an = airnow.status === "fulfilled" ? airnow.value : null;

  if (!om && !an) {
    throw new Error("All upstream data sources failed — try again shortly");
  }

  // ── 4. Persist to Supabase ───────────────────────────────────────────────
  const row = {
    location_id: location.id,
    fetched_at: new Date().toISOString(),
    // AQI — prefer AirNow (authoritative) over Open-Meteo estimate
    aqi: an?.aqi ?? null,
    aqi_category: an?.aqi_category ?? null,
    dominant_pollutant: an?.dominant_pollutant ?? null,
    // Pollutants from Open-Meteo
    pm25: om?.pm25 ?? null,
    pm10: om?.pm10 ?? null,
    o3_ppb: om?.o3_ppb ?? null,
    no2_ppb: om?.no2_ppb ?? null,
    co_ppm: om?.co_ppm ?? null,
    so2_ppb: om?.so2_ppb ?? null,
    co2_ppm: om?.co2_ppm ?? null,
    // Weather from Open-Meteo
    temperature_f: om?.temperature_f ?? null,
    feels_like_f: om?.feels_like_f ?? null,
    humidity_pct: om?.humidity_pct ?? null,
    pressure_inhg: om?.pressure_inhg ?? null,
    wind_speed_mph: om?.wind_speed_mph ?? null,
    wind_gust_mph: om?.wind_gust_mph ?? null,
    wind_direction_deg: om?.wind_direction_deg ?? null,
    visibility_mi: om?.visibility_mi ?? null,
    uv_index: om?.uv_index ?? null,
    cloud_cover_pct: om?.cloud_cover_pct ?? null,
    source_airnow: !!an,
    source_openmeteo: !!om,
  };

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("readings")
    .insert(row)
    .select()
    .single();

  if (insertErr) {
    console.error("[fetch-and-cache] Insert failed:", insertErr);
    // Non-fatal: return the data even if we couldn't cache it
  }

  const reading = inserted ?? row;

  return {
    data: rowToReading(reading, location),
    cached: false,
    cache_age_seconds: 0,
  };
}

// ── Helper ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToReading(row: any, location: any): AirQualityReading {
  return {
    location: {
      zip_code: location.zip_code,
      city: location.city,
      state: location.state,
      lat: location.lat,
      lng: location.lng,
    },
    fetched_at: row.fetched_at,
    aqi: row.aqi,
    aqi_category: row.aqi_category,
    dominant_pollutant: row.dominant_pollutant,
    pm25: row.pm25,
    pm10: row.pm10,
    o3_ppb: row.o3_ppb,
    no2_ppb: row.no2_ppb,
    co_ppm: row.co_ppm,
    so2_ppb: row.so2_ppb,
    co2_ppm: row.co2_ppm,
    temperature_f: row.temperature_f,
    feels_like_f: row.feels_like_f,
    humidity_pct: row.humidity_pct,
    pressure_inhg: row.pressure_inhg,
    wind_speed_mph: row.wind_speed_mph,
    wind_gust_mph: row.wind_gust_mph,
    wind_direction_deg: row.wind_direction_deg,
    visibility_mi: row.visibility_mi,
    uv_index: row.uv_index,
    cloud_cover_pct: row.cloud_cover_pct,
    source_airnow: row.source_airnow ?? false,
    source_openmeteo: row.source_openmeteo ?? false,
  };
}
