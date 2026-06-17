/**
 * purpleair.ts
 *
 * Fetches live readings for one or more portable PurpleAir sensors.
 * ✅ Requires a free API key — sign up at https://develop.purpleair.com/
 *    (Google account login), then "+" on the Keys page to create a
 *    read-only key.
 *
 * Docs: https://api.purpleair.com/
 *
 * PurpleAir's /v1/sensors endpoint returns a columnar shape:
 *   { fields: ["sensor_index", "name", ...], data: [[20, "Oakdale", ...], ...] }
 * We zip fields+data back into named objects below.
 */

export interface PurpleAirReading {
  sensor_index: string;
  name: string | null;
  lat: number | null;
  lng: number | null;
  pm1_0: number | null;
  pm25: number | null;
  pm10: number | null;
  aqi: number | null;
  aqi_category: string | null;
  temperature_f: number | null;
  humidity_pct: number | null;
  pressure_inhg: number | null;
  confidence: number | null;
  last_seen: string | null; // ISO-8601
}

const FIELDS = [
  "sensor_index",
  "name",
  "latitude",
  "longitude",
  "pm1.0_atm",
  "pm2.5_atm",
  "pm10.0_atm",
  "humidity",
  "temperature",
  "pressure",
  "confidence",
  "last_seen",
].join(",");

/**
 * EPA breakpoint table for PM2.5 → AQI (24-hr NowCast simplification —
 * good enough for a "right now" portable-sensor reading).
 * [pm25_low, pm25_high, aqi_low, aqi_high]
 */
const PM25_BREAKPOINTS: [number, number, number, number][] = [
  [0.0, 12.0, 0, 50],
  [12.1, 35.4, 51, 100],
  [35.5, 55.4, 101, 150],
  [55.5, 150.4, 151, 200],
  [150.5, 250.4, 201, 300],
  [250.5, 350.4, 301, 400],
  [350.5, 500.4, 401, 500],
];

export function pm25ToAqi(pm25: number | null): number | null {
  if (pm25 == null || Number.isNaN(pm25)) return null;
  const c = Math.max(0, pm25);

  for (const [cLow, cHigh, iLow, iHigh] of PM25_BREAKPOINTS) {
    if (c >= cLow && c <= cHigh) {
      return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (c - cLow) + iLow);
    }
  }
  return 500; // above scale — cap at Hazardous
}

export function aqiToCategory(aqi: number | null): string | null {
  if (aqi == null) return null;
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

/**
 * Fetch the latest reading for each sensor index given.
 * Returns an array in no particular order; sensors PurpleAir can't find
 * (bad index, offline, revoked) are simply omitted, not errored.
 */
export async function fetchPurpleAirSensors(
  sensorIndices: string[]
): Promise<PurpleAirReading[]> {
  if (sensorIndices.length === 0) return [];

  const apiKey = process.env.PURPLEAIR_API_KEY;
  if (!apiKey) {
    console.warn("[purpleair] PURPLEAIR_API_KEY not set — skipping fetch");
    return [];
  }

  const url =
    `https://api.purpleair.com/v1/sensors` +
    `?fields=${FIELDS}` +
    `&show_only=${sensorIndices.join(",")}`;

  const res = await fetch(url, {
    headers: { "X-API-Key": apiKey },
    next: { revalidate: 120 }, // PurpleAir sensors report every ~2 min
  });

  if (!res.ok) {
    console.error(`[purpleair] HTTP ${res.status}`);
    return [];
  }

  const json = await res.json();
  const fields: string[] = json.fields ?? [];
  const rows: unknown[][] = json.data ?? [];

  const idx = (name: string) => fields.indexOf(name);
  const iSensorIndex = idx("sensor_index");
  const iName = idx("name");
  const iLat = idx("latitude");
  const iLng = idx("longitude");
  const iPm1 = idx("pm1.0_atm");
  const iPm25 = idx("pm2.5_atm");
  const iPm10 = idx("pm10.0_atm");
  const iHumidity = idx("humidity");
  const iTemp = idx("temperature");
  const iPressure = idx("pressure");
  const iConfidence = idx("confidence");
  const iLastSeen = idx("last_seen");

  // millibars/hPa → inHg (same conversion used for Open-Meteo)
  const hpaToInhg = (hpa: number | null) =>
    hpa != null ? Math.round(hpa * 0.02953 * 100) / 100 : null;

  return rows.map((row) => {
    const pm25 = (row[iPm25] as number) ?? null;
    const aqi = pm25ToAqi(pm25);

    return {
      sensor_index: String(row[iSensorIndex]),
      name: (row[iName] as string) ?? null,
      lat: (row[iLat] as number) ?? null,
      lng: (row[iLng] as number) ?? null,
      pm1_0: (row[iPm1] as number) ?? null,
      pm25,
      pm10: (row[iPm10] as number) ?? null,
      aqi,
      aqi_category: aqiToCategory(aqi),
      // PurpleAir reports temperature in °F by default
      temperature_f: (row[iTemp] as number) ?? null,
      humidity_pct: (row[iHumidity] as number) ?? null,
      pressure_inhg: hpaToInhg((row[iPressure] as number) ?? null),
      confidence: (row[iConfidence] as number) ?? null,
      last_seen:
        row[iLastSeen] != null
          ? new Date((row[iLastSeen] as number) * 1000).toISOString()
          : null,
    };
  });
}
