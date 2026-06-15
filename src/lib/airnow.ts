/**
 * airnow.ts
 *
 * Fetches official US AQI from the EPA AirNow API.
 * ✅ Free — register at https://docs.airnowapi.org/ (instant, no approval)
 *
 * Returns the AQI value, category, and dominant pollutant for a zip code.
 * AirNow data is the authoritative source for US AQI — use it over
 * Open-Meteo's us_aqi estimate where available.
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

export async function fetchAirNow(
  zip: string
): Promise<AirNowObservation | null> {
  const apiKey = process.env.AIRNOW_API_KEY;
  if (!apiKey) {
    console.warn("[airnow] AIRNOW_API_KEY not set — skipping AirNow fetch");
    return null;
  }

  // AirNow returns one entry per pollutant; we want the highest AQI
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const url =
    `https://www.airnowapi.org/aq/observation/zipCode/current/` +
    `?format=application/json` +
    `&zipCode=${zip}` +
    `&distance=25` +
    `&API_KEY=${apiKey}`;

  const res = await fetch(url, {
    next: { revalidate: 900 }, // 15 min cache in Next.js
  });

  // Silence the `today` lint warning — used if we add date filtering later
  void today;

  if (!res.ok) {
    console.error(`[airnow] HTTP ${res.status} for zip ${zip}`);
    return null;
  }

  const entries: AirNowRawEntry[] = await res.json();
  if (!Array.isArray(entries) || entries.length === 0) return null;

  // Pick the entry with the highest AQI — that's the dominant pollutant
  const worst = entries.reduce((a, b) => (b.AQI > a.AQI ? b : a));

  return {
    aqi: worst.AQI,
    aqi_category: worst.Category.Name,
    dominant_pollutant: worst.ParameterName,
  };
}
