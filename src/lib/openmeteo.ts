/**
 * openmeteo.ts
 *
 * Fetches weather + air quality from Open-Meteo.
 * ✅ Completely free — no API key required.
 * Docs: https://open-meteo.com/en/docs/air-quality-api
 *
 * Returns partial AirQualityReading (everything except AQI, which comes
 * from EPA AirNow).
 */

type OpenMeteoPartial = {
  temperature_f: number | null;
  feels_like_f: number | null;
  humidity_pct: number | null;
  pressure_inhg: number | null;
  wind_speed_mph: number | null;
  wind_gust_mph: number | null;
  wind_direction_deg: number | null;
  visibility_mi: number | null;
  uv_index: number | null;
  cloud_cover_pct: number | null;
  pm25: number | null;
  pm10: number | null;
  o3_ppb: number | null;
  no2_ppb: number | null;
  co_ppm: number | null;
  so2_ppb: number | null;
  co2_ppm: number | null;
};

export async function fetchOpenMeteo(
  lat: number,
  lng: number
): Promise<OpenMeteoPartial | null> {
  // Fetch weather and air quality in parallel — two separate Open-Meteo endpoints
  const [weatherRes, aqRes] = await Promise.all([
    fetch(
      `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${lat}&longitude=${lng}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m` +
        `,surface_pressure,wind_speed_10m,wind_gusts_10m,wind_direction_10m` +
        `,visibility,uv_index,cloud_cover` +
        `&temperature_unit=fahrenheit` +
        `&wind_speed_unit=mph` +
        `&precipitation_unit=inch` +
        `&timezone=auto`,
      { next: { revalidate: 600 } } // Next.js: cache 10 min
    ),
    fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality` +
        `?latitude=${lat}&longitude=${lng}` +
        `&current=pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide` +
        `,ozone,european_aqi,us_aqi` +
        `&domains=cams_global`,
      { next: { revalidate: 600 } }
    ),
  ]);

  if (!weatherRes.ok || !aqRes.ok) return null;

  const weather = await weatherRes.json();
  const aq = await aqRes.json();

  const w = weather.current ?? {};
  const a = aq.current ?? {};

  // hPa → inHg
  const hpaToInhg = (hpa: number | null) =>
    hpa != null ? Math.round((hpa * 0.02953) * 100) / 100 : null;

  // metres → miles
  const mToMi = (m: number | null) =>
    m != null ? Math.round((m / 1609.34) * 10) / 10 : null;

  // µg/m³ CO → ppm  (MW_CO = 28 g/mol; 1 µg/m³ ≈ 0.000873 ppm at 25°C)
  const coToPpm = (ugm3: number | null) =>
    ugm3 != null ? Math.round(ugm3 * 0.000873 * 1000) / 1000 : null;

  // µg/m³ O₃ → ppb  (MW_O3 = 48; 1 µg/m³ ≈ 0.509 ppb at 25°C)
  const o3ToPpb = (ugm3: number | null) =>
    ugm3 != null ? Math.round(ugm3 * 0.509 * 10) / 10 : null;

  // µg/m³ NO₂ → ppb  (MW_NO2 = 46; 1 µg/m³ ≈ 0.531 ppb)
  const no2ToPpb = (ugm3: number | null) =>
    ugm3 != null ? Math.round(ugm3 * 0.531 * 10) / 10 : null;

  // µg/m³ SO₂ → ppb  (MW_SO2 = 64; 1 µg/m³ ≈ 0.382 ppb)
  const so2ToPpb = (ugm3: number | null) =>
    ugm3 != null ? Math.round(ugm3 * 0.382 * 10) / 10 : null;

  return {
    temperature_f: w.temperature_2m ?? null,
    feels_like_f: w.apparent_temperature ?? null,
    humidity_pct: w.relative_humidity_2m ?? null,
    pressure_inhg: hpaToInhg(w.surface_pressure ?? null),
    wind_speed_mph: w.wind_speed_10m ?? null,
    wind_gust_mph: w.wind_gusts_10m ?? null,
    wind_direction_deg: w.wind_direction_10m ?? null,
    visibility_mi: mToMi(w.visibility ?? null),
    uv_index: w.uv_index != null ? Math.round(w.uv_index) : null,
    cloud_cover_pct: w.cloud_cover ?? null,
    pm25: a.pm2_5 ?? null,
    pm10: a.pm10 ?? null,
    o3_ppb: o3ToPpb(a.ozone ?? null),
    no2_ppb: no2ToPpb(a.nitrogen_dioxide ?? null),
    co_ppm: coToPpm(a.carbon_monoxide ?? null),
    so2_ppb: so2ToPpb(a.sulphur_dioxide ?? null),
    // Open-Meteo does not provide CO₂ — will remain null unless another
    // source (e.g. NOAA global background) is added later
    co2_ppm: null,
  };
}
