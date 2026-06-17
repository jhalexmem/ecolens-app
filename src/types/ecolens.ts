// ─── Core domain types ────────────────────────────────────────────────────────

export interface GeoLocation {
  zip_code: string;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
}

export interface AirQualityReading {
  // identity
  location: GeoLocation;
  fetched_at: string; // ISO-8601

  // AQI
  aqi: number | null;
  aqi_category: AqiCategory | null;
  dominant_pollutant: string | null;

  // Particulates
  pm25: number | null;  // µg/m³
  pm10: number | null;  // µg/m³

  // Gases
  o3_ppb: number | null;
  no2_ppb: number | null;
  co_ppm: number | null;
  so2_ppb: number | null;
  co2_ppm: number | null;

  // Weather
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

  // Meta
  source_airnow: boolean;
  source_openmeteo: boolean;
}

export type AqiCategory =
  | "Good"
  | "Moderate"
  | "Unhealthy for Sensitive Groups"
  | "Unhealthy"
  | "Very Unhealthy"
  | "Hazardous";

export interface HistoryPoint {
  fetched_at: string;
  aqi: number | null;
  pm25: number | null;
  o3_ppb: number | null;
}

// ─── API response envelopes ───────────────────────────────────────────────────

export interface ReadingsResponse {
  data: AirQualityReading;
  cached: boolean;       // true if returned from Supabase cache
  cache_age_seconds: number;
}

export interface HistoryResponse {
  zip_code: string;
  hours: number;
  data: HistoryPoint[];
}

export interface ApiError {
  error: string;
  code?: string;
}

// ─── Portable sensors (PurpleAir, etc.) ───────────────────────────────────────

export interface SensorReading {
  sensor_index: string;
  label: string | null;
  lat: number | null;
  lng: number | null;
  pm25: number | null;
  pm10: number | null;
  aqi: number | null;
  aqi_category: AqiCategory | null;
  temperature_f: number | null;
  humidity_pct: number | null;
  fetched_at: string; // ISO-8601
}

export interface SensorsResponse {
  data: SensorReading[];
  cached: boolean;
  cache_age_seconds: number;
}
