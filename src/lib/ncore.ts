/**
 * ncore.ts
 *
 * Live criteria-pollutant + weather snapshot for the Shelby Farms Park
 * NCore/PAMS site — a single fixed location, independent of whatever zip
 * code the user has searched. Sourced from EPA AirNow's lat/lon endpoint
 * (nearest reporting station within 25 miles) plus Open-Meteo — the same
 * two providers behind the zip-code station reading.
 *
 * NCore and PAMS are NOT two separate physical sensors — they're two
 * monitoring programs run out of the same shed at Shelby Farms Park (NCore
 * since 2009, PAMS added in summer 2021; confirmed via Shelby County
 * Health Department's Ambient Air Monitoring page). This module/marker
 * represents that one site. The live numbers here are criteria pollutants
 * (NCore's domain); PAMS's archival speciated VOC/carbonyl data comes from
 * EPA AQS instead (see lib/aqs.ts + /api/pams) once AQS_API_EMAIL /
 * AQS_API_KEY are configured.
 *
 * Coordinates are Shelby Farms Park's published general location
 * (35.1389, -89.8325). The monitor shed's exact lat/lon isn't
 * independently published at street-address precision in public sources
 * at time of writing — once the AQS key is confirmed, the official site
 * lat/lon can be pulled from AQS site metadata and swapped in here.
 *
 * This function never throws — even if both upstream APIs are
 * unreachable, it still returns a reading with the fixed coordinates and
 * null data fields, so the map marker can always be placed regardless of
 * API/connection status.
 */

import { fetchAirNowByLatLon } from "./airnow";
import { fetchOpenMeteo } from "./openmeteo";
import type { AirQualityReading, AqiCategory } from "@/types/ecolens";

export const NCORE_SITE = {
  name: "Shelby Farms Park",
  lat: 35.1389,
  lng: -89.8325,
};

export async function fetchNcoreReading(): Promise<AirQualityReading> {
  const [airnowRes, omRes] = await Promise.allSettled([
    fetchAirNowByLatLon(NCORE_SITE.lat, NCORE_SITE.lng),
    fetchOpenMeteo(NCORE_SITE.lat, NCORE_SITE.lng),
  ]);

  const an = airnowRes.status === "fulfilled" ? airnowRes.value : null;
  const om = omRes.status === "fulfilled" ? omRes.value : null;

  return {
    location: {
      zip_code: "",
      city: NCORE_SITE.name,
      state: "TN",
      lat: NCORE_SITE.lat,
      lng: NCORE_SITE.lng,
    },
    fetched_at: new Date().toISOString(),

    aqi: an?.aqi ?? null,
    aqi_category: (an?.aqi_category as AqiCategory | undefined) ?? null,
    dominant_pollutant: an?.dominant_pollutant ?? null,

    pm25: om?.pm25 ?? null,
    pm10: om?.pm10 ?? null,

    o3_ppb: om?.o3_ppb ?? null,
    no2_ppb: om?.no2_ppb ?? null,
    co_ppm: om?.co_ppm ?? null,
    so2_ppb: om?.so2_ppb ?? null,
    co2_ppm: om?.co2_ppm ?? null,

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
}
