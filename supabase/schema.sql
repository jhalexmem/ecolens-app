-- ============================================================
-- EcoLens · Supabase Schema
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------
-- locations
-- Cached geocoded results so we don't re-geocode the same zip
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  zip_code    text UNIQUE NOT NULL,
  city        text,
  state       text,
  lat         numeric(9, 6) NOT NULL,
  lng         numeric(9, 6) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------
-- readings
-- One row per fetch event per location.
-- The API caches here and returns stale data if < 15 min old.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS readings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id          uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  fetched_at           timestamptz NOT NULL DEFAULT now(),

  -- ── AQI (from EPA AirNow) ──────────────────────────────
  aqi                  integer,
  aqi_category         text,          -- Good / Moderate / Unhealthy for Sensitive Groups / etc.
  dominant_pollutant   text,          -- PM2.5 / O3 / NO2 / etc.

  -- ── Particulates (µg/m³) ───────────────────────────────
  pm25                 numeric(6, 2), -- Fine particles
  pm10                 numeric(6, 2), -- Coarse particles

  -- ── Gases ──────────────────────────────────────────────
  o3_ppb               numeric(6, 2), -- Ozone (ppb)
  no2_ppb              numeric(6, 2), -- Nitrogen dioxide (ppb)
  co_ppm               numeric(6, 3), -- Carbon monoxide (ppm)
  so2_ppb              numeric(6, 2), -- Sulfur dioxide (ppb)
  co2_ppm              numeric(7, 1), -- Carbon dioxide (ppm) — from Open-Meteo

  -- ── Weather ────────────────────────────────────────────
  temperature_f        numeric(5, 1),
  feels_like_f         numeric(5, 1),
  humidity_pct         integer,
  pressure_inhg        numeric(5, 2),
  wind_speed_mph       numeric(5, 1),
  wind_gust_mph        numeric(5, 1),
  wind_direction_deg   integer,       -- 0-359
  visibility_mi        numeric(5, 2),
  uv_index             integer,
  cloud_cover_pct      integer,

  -- ── Source bookkeeping ─────────────────────────────────
  source_airnow        boolean DEFAULT false,
  source_openmeteo     boolean DEFAULT false
);

-- Fast lookup: latest reading for a given location
CREATE INDEX IF NOT EXISTS idx_readings_location_time
  ON readings (location_id, fetched_at DESC);

-- ----------------------------------------------------------
-- Row-level security: public read, no public write
-- (the API routes run with the service-role key server-side)
-- ----------------------------------------------------------
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE readings  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public can read locations"
  ON locations FOR SELECT USING (true);

CREATE POLICY "public can read readings"
  ON readings FOR SELECT USING (true);

-- Service role bypasses RLS automatically, so no insert policy needed.

-- ----------------------------------------------------------
-- Convenience view: latest reading per location
-- ----------------------------------------------------------
CREATE OR REPLACE VIEW latest_readings AS
SELECT DISTINCT ON (r.location_id)
  r.*,
  l.zip_code,
  l.city,
  l.state,
  l.lat,
  l.lng
FROM readings r
JOIN locations l ON l.id = r.location_id
ORDER BY r.location_id, r.fetched_at DESC;

-- ============================================================
-- Portable sensors (PurpleAir, etc.)
-- ============================================================

-- ----------------------------------------------------------
-- purpleair_sensors
-- Registry of sensors we track. One row per physical device.
-- Sensors are mobile, so we do NOT store a fixed lat/lng here —
-- each reading carries its own location.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS purpleair_sensors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_index   text UNIQUE NOT NULL,  -- PurpleAir's numeric sensor index, as text
  label          text,                  -- friendly name, e.g. "Backpack Unit 1"
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------
-- purpleair_readings
-- One row per fetch event per sensor.
-- ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS purpleair_readings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id           uuid NOT NULL REFERENCES purpleair_sensors(id) ON DELETE CASCADE,
  fetched_at          timestamptz NOT NULL DEFAULT now(),

  -- ── Current position (sensors are portable) ────────────
  lat                 numeric(9, 6),
  lng                 numeric(9, 6),

  -- ── Particulates (µg/m³) ────────────────────────────────
  pm1_0               numeric(6, 2),
  pm25                numeric(6, 2),
  pm10                numeric(6, 2),

  -- ── Derived AQI (EPA breakpoints from PM2.5) ────────────
  aqi                 integer,
  aqi_category        text,

  -- ── Onboard weather (if the sensor model has these) ────
  temperature_f       numeric(5, 1),
  humidity_pct        integer,
  pressure_inhg       numeric(5, 2),

  -- ── PurpleAir bookkeeping ───────────────────────────────
  confidence          integer,        -- 0-100 channel confidence score
  last_seen           timestamptz     -- PurpleAir's own "last data" timestamp
);

CREATE INDEX IF NOT EXISTS idx_purpleair_readings_sensor_time
  ON purpleair_readings (sensor_id, fetched_at DESC);

ALTER TABLE purpleair_sensors  ENABLE ROW LEVEL SECURITY;
ALTER TABLE purpleair_readings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public can read purpleair_sensors"
  ON purpleair_sensors FOR SELECT USING (true);

CREATE POLICY "public can read purpleair_readings"
  ON purpleair_readings FOR SELECT USING (true);

-- Convenience view: latest reading per sensor
CREATE OR REPLACE VIEW latest_purpleair_readings AS
SELECT DISTINCT ON (r.sensor_id)
  r.*,
  s.sensor_index,
  s.label
FROM purpleair_readings r
JOIN purpleair_sensors s ON s.id = r.sensor_id
ORDER BY r.sensor_id, r.fetched_at DESC;
