/**
 * fetch-and-cache-sensors.ts
 *
 * Same read-through-cache pattern as fetch-and-cache.ts, but for the
 * portable PurpleAir sensor fleet instead of a single zip-code lookup.
 *
 * Sensor indices to track come from the PURPLEAIR_SENSOR_INDICES env var
 * (comma-separated), so adding/removing a sensor never requires a code change.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { fetchPurpleAirSensors } from "@/lib/purpleair";

const CACHE_TTL_SECONDS = 5 * 60; // 5 min — PurpleAir sensors report ~every 2 min

export interface SensorResult {
  sensor_index: string;
  label: string | null;
  lat: number | null;
  lng: number | null;
  pm25: number | null;
  pm10: number | null;
  aqi: number | null;
  aqi_category: string | null;
  temperature_f: number | null;
  humidity_pct: number | null;
  pressure_inhg: number | null;
  fetched_at: string;
}

export interface SensorsFetchResult {
  data: SensorResult[];
  cached: boolean;
  cache_age_seconds: number;
}

function configuredSensorIndices(): string[] {
  const raw = process.env.PURPLEAIR_SENSOR_INDICES ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToResult(row: any): SensorResult {
  return {
    sensor_index: row.sensor_index,
    label: row.label,
    lat: row.lat,
    lng: row.lng,
    pm25: row.pm25,
    pm10: row.pm10,
    aqi: row.aqi,
    aqi_category: row.aqi_category,
    temperature_f: row.temperature_f,
    humidity_pct: row.humidity_pct,
    pressure_inhg: row.pressure_inhg,
    fetched_at: row.fetched_at,
  };
}

export async function getPurpleAirSensorReadings(): Promise<SensorsFetchResult> {
  const indices = configuredSensorIndices();
  if (indices.length === 0) {
    // No sensors configured yet — not an error, just nothing to show.
    return { data: [], cached: false, cache_age_seconds: 0 };
  }

  // ── 1. Make sure every configured sensor is registered ───────────────────
  const { data: existingSensors, error: sensorErr } = await supabaseAdmin
    .from("purpleair_sensors")
    .select("*")
    .in("sensor_index", indices);

  if (sensorErr) throw new Error(`Supabase sensor lookup failed: ${sensorErr.message}`);

  const knownIndices = new Set((existingSensors ?? []).map((s) => s.sensor_index));
  const missing = indices.filter((i) => !knownIndices.has(i));

  let sensors = existingSensors ?? [];
  if (missing.length > 0) {
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from("purpleair_sensors")
      .upsert(
        missing.map((sensor_index) => ({ sensor_index })),
        { onConflict: "sensor_index" }
      )
      .select("*");

    if (insertErr) throw new Error(`Could not register sensor: ${insertErr.message}`);
    sensors = [...sensors, ...(inserted ?? [])];
  }

  const sensorByIndex = new Map(sensors.map((s) => [s.sensor_index, s]));

  // ── 2. Check cache freshness ──────────────────────────────────────────────
  const cutoffMs = Date.now() - CACHE_TTL_SECONDS * 1000;
  const sensorIds = sensors.map((s) => s.id);

  const { data: cachedRows, error: cacheErr } = await supabaseAdmin
    .from("latest_purpleair_readings")
    .select("*")
    .in("sensor_id", sensorIds);

  if (cacheErr) throw new Error(`Supabase cache check failed: ${cacheErr.message}`);

  const rows = cachedRows ?? [];
  const allFresh =
    rows.length === indices.length &&
    rows.every((r) => new Date(r.fetched_at).getTime() >= cutoffMs);

  if (allFresh) {
    const oldestMs = rows.reduce(
      (min, r) => Math.min(min, new Date(r.fetched_at).getTime()),
      Date.now()
    );
    return {
      data: rows.map(rowToResult),
      cached: true,
      cache_age_seconds: Math.round((Date.now() - oldestMs) / 1000),
    };
  }

  // ── 3. Fetch fresh from PurpleAir (one batched call for all sensors) ─────
  const fresh = await fetchPurpleAirSensors(indices);

  if (fresh.length === 0) {
    // Upstream unreachable/misconfigured — fall back to whatever we have cached
    return {
      data: rows.map(rowToResult),
      cached: true,
      cache_age_seconds: CACHE_TTL_SECONDS,
    };
  }

  // ── 4. Persist new readings ────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  const rowsToInsert = fresh
    .map((reading) => {
      const sensor = sensorByIndex.get(reading.sensor_index);
      if (!sensor) return null;
      return {
        sensor_id: sensor.id,
        fetched_at: nowIso,
        lat: reading.lat,
        lng: reading.lng,
        pm1_0: reading.pm1_0,
        pm25: reading.pm25,
        pm10: reading.pm10,
        aqi: reading.aqi,
        aqi_category: reading.aqi_category,
        temperature_f: reading.temperature_f,
        humidity_pct: reading.humidity_pct,
        pressure_inhg: reading.pressure_inhg,
        confidence: reading.confidence,
        last_seen: reading.last_seen,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rowsToInsert.length > 0) {
    const { error: insertErr } = await supabaseAdmin
      .from("purpleair_readings")
      .insert(rowsToInsert);
    if (insertErr) console.error("[purpleair] Insert failed:", insertErr);
  }

  // Backfill a friendly label from PurpleAir's "name" field, once.
  for (const reading of fresh) {
    const sensor = sensorByIndex.get(reading.sensor_index);
    if (sensor && !sensor.label && reading.name) {
      await supabaseAdmin
        .from("purpleair_sensors")
        .update({ label: reading.name })
        .eq("id", sensor.id);
    }
  }

  return {
    data: fresh.map((reading) => {
      const sensor = sensorByIndex.get(reading.sensor_index);
      return {
        sensor_index: reading.sensor_index,
        label: sensor?.label ?? reading.name ?? null,
        lat: reading.lat,
        lng: reading.lng,
        pm25: reading.pm25,
        pm10: reading.pm10,
        aqi: reading.aqi,
        aqi_category: reading.aqi_category,
        temperature_f: reading.temperature_f,
        humidity_pct: reading.humidity_pct,
        pressure_inhg: reading.pressure_inhg,
        fetched_at: nowIso,
      };
    }),
    cached: false,
    cache_age_seconds: 0,
  };
}
