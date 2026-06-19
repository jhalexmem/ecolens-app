/**
 * airnow.ts
 *
 * Fetches official US AQI from the EPA AirNow API.
 * ✅ Free — register at https://docs.airnowapi.org/ (instant, no approval)
 *
 * Returns the AQI value, category, and dominant pollutant for either a zip
 * code (fetchAirNow) or a lat/lon pair (fetchAirNowByLatLon — used for the
 * fixed Shelby Farms NCore/PAMS reference site). AirNow data is the
 * authoritative source for US AQI — use it over Open-Meteo's us_aqi
 * estimate where available.
 */

export interface AirNowObservation {
  aqi: number;
  aqi_category: string;
  dominant_pollutant: string;
}

interface AirNowRawEntry {
  AQI: number;
  Category: { Name: string };
  ParameterName: string;
}

// AirNow returns one entry per pollutant; we want the highest AQI — that's
// the dominant pollutant driving the overall reading.
function pickWorst(entries: AirNowRawEntry[]): AirNowObservation | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const worst = entries.reduce((a, b) => (b.AQI > a.AQI ? b : a));
  return {
    aqi: worst.AQI,
    aqi_category: worst.Category.Name,
    dominant_pollutant: worst.ParameterName,
  };
}

export async function fetchAirNow(
  zip: string
): Promise<AirNowObservation | null> {
  const apiKey = process.env.AIRNOW_API_KEY;
  if (!apiKey) {
    console.warn("[airnow] AIRNOW_API_KEY not set — skipping AirNow fetch");
    return null;
  }

  const url =
    `https://www.airnowapi.org/aq/observation/zipCode/current/` +
    `?format=application/json` +
    `&zipCode=${zip}` +
    `&distance=25` +
    `&API_KEY=${apiKey}`;

  const res = await fetch(url, {
    next: { revalidate: 900 }, // 15 min cache in Next.js
  });

  if (!res.ok) {
    console.error(`[airnow] HTTP ${res.status} for zip ${zip}`);
    return null;
  }

  const entries: AirNowRawEntry[] = await res.json();
  return pickWorst(entries);
}

/**
 * Same as fetchAirNow, but by coordinates instead of zip code — used for
 * fixed reference sites (e.g. Shelby Farms Park) rather than a
 * user-searched zip. Returns the nearest AirNow-reporting station within
 * 25 miles; not guaranteed to be an exact match to a specific monitor ID,
 * so callers should label results accordingly.
 */
export async function fetchAirNowByLatLon(
  lat: number,
  lng: number
): Promise<AirNowObservation | null> {
  const apiKey = process.env.AIRNOW_API_KEY;
  if (!apiKey) {
    console.warn("[airnow] AIRNOW_API_KEY not set — skipping AirNow fetch");
    return null;
  }

  const url =
    `https://www.airnowapi.org/aq/observation/latLong/current/` +
    `?format=application/json` +
    `&latitude=${lat}` +
    `&longitude=${lng}` +
    `&distance=25` +
    `&API_KEY=${apiKey}`;

  const res = await fetch(url, {
    next: { revalidate: 900 }, // 15 min cache in Next.js
  });

  if (!res.ok) {
    console.error(`[airnow] HTTP ${res.status} for ${lat},${lng}`);
    return null;
  }

  const entries: AirNowRawEntry[] = await res.json();
  return pickWorst(entries);
}
