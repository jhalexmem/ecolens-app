"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type {
  ReadingsResponse,
  HistoryResponse,
  AirQualityReading,
  SensorReading,
  SensorsResponse,
  SourceSelection,
} from "@/types/ecolens";
import SensorMap, { type StationPoint } from "@/components/SensorMap";

// ─── AQI helpers ─────────────────────────────────────────────────────────────

function aqiColor(aqi: number | null): string {
  if (aqi == null) return "var(--gray-text)";
  if (aqi <= 50)  return "var(--green)";
  if (aqi <= 100) return "var(--amber)";
  if (aqi <= 150) return "var(--orange)";
  if (aqi <= 200) return "var(--red)";
  if (aqi <= 300) return "var(--purple)";
  return "var(--maroon)";
}

function aqiBg(aqi: number | null): string {
  if (aqi == null) return "#f5f4f0";
  if (aqi <= 50)  return "var(--green-bg)";
  if (aqi <= 100) return "var(--amber-bg)";
  if (aqi <= 150) return "var(--orange-bg)";
  return "var(--red-bg)";
}

function aqiLabel(aqi: number | null): string {
  if (aqi == null) return "No data";
  if (aqi <= 50)  return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive Groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

function aqiAdvice(aqi: number | null): string {
  if (aqi == null) return "";
  if (aqi <= 50)  return "Air quality is satisfactory. Outdoor activities are fine.";
  if (aqi <= 100) return "Unusually sensitive people should consider limiting prolonged outdoor exertion.";
  if (aqi <= 150) return "Sensitive groups (children, elderly, those with heart/lung conditions) should reduce prolonged outdoor exertion.";
  if (aqi <= 200) return "Everyone should reduce prolonged outdoor exertion. Sensitive groups should avoid it.";
  if (aqi <= 300) return "Everyone should avoid prolonged outdoor exertion. Sensitive groups should stay indoors.";
  return "Hazardous: Everyone should avoid all outdoor activity.";
}

function bearingLabel(deg: number | null): string {
  if (deg == null) return "—";
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

function fmt(v: number | null, digits = 1): string {
  return v != null ? v.toFixed(digits) : "—";
}

function fmtInt(v: number | null): string {
  return v != null ? Math.round(v).toString() : "—";
}

// ─── Selected reading (station or sensor → one common display shape) ─────────

/**
 * Whichever source is selected on the map (the AirNow station, by default,
 * or any PurpleAir sensor) gets normalized into this shape so every dashboard
 * card can read from one place instead of branching on source type. Fields a
 * source doesn't report (e.g. PurpleAir has no wind/gases/visibility) are
 * `null` — existing components already render `null` as "—".
 */
interface SelectedReading {
  locationLabel: string;
  zipLabel: string | null;
  sourceLabel: string;
  fetched_at: string;
  cached: boolean;
  cache_age_seconds: number;
  aqi: number | null;
  aqi_category: string | null;
  dominant_pollutant: string | null;
  pm25: number | null;
  pm10: number | null;
  o3_ppb: number | null;
  no2_ppb: number | null;
  co_ppm: number | null;
  so2_ppb: number | null;
  co2_ppm: number | null;
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
}

function stationToSelectedReading(
  d: AirQualityReading,
  cached: boolean,
  cacheAge: number
): SelectedReading {
  return {
    locationLabel: `${d.location.city ?? d.location.zip_code}${d.location.state ? `, ${d.location.state}` : ""}`,
    zipLabel: d.location.zip_code,
    sourceLabel: [d.source_airnow && "EPA AirNow", d.source_openmeteo && "Open-Meteo"]
      .filter(Boolean)
      .join(" · "),
    fetched_at: d.fetched_at,
    cached,
    cache_age_seconds: cacheAge,
    aqi: d.aqi,
    aqi_category: d.aqi_category,
    dominant_pollutant: d.dominant_pollutant,
    pm25: d.pm25,
    pm10: d.pm10,
    o3_ppb: d.o3_ppb,
    no2_ppb: d.no2_ppb,
    co_ppm: d.co_ppm,
    so2_ppb: d.so2_ppb,
    co2_ppm: d.co2_ppm,
    temperature_f: d.temperature_f,
    feels_like_f: d.feels_like_f,
    humidity_pct: d.humidity_pct,
    pressure_inhg: d.pressure_inhg,
    wind_speed_mph: d.wind_speed_mph,
    wind_gust_mph: d.wind_gust_mph,
    wind_direction_deg: d.wind_direction_deg,
    visibility_mi: d.visibility_mi,
    uv_index: d.uv_index,
    cloud_cover_pct: d.cloud_cover_pct,
  };
}

function sensorToSelectedReading(
  s: SensorReading,
  cached: boolean,
  cacheAge: number
): SelectedReading {
  return {
    locationLabel: s.label ?? `Sensor ${s.sensor_index}`,
    zipLabel: null,
    sourceLabel: "PurpleAir",
    fetched_at: s.fetched_at,
    cached,
    cache_age_seconds: cacheAge,
    aqi: s.aqi,
    aqi_category: s.aqi_category,
    dominant_pollutant: s.pm25 != null ? "PM2.5" : null,
    pm25: s.pm25,
    pm10: s.pm10,
    o3_ppb: null,
    no2_ppb: null,
    co_ppm: null,
    so2_ppb: null,
    co2_ppm: null,
    temperature_f: s.temperature_f,
    feels_like_f: null,
    humidity_pct: s.humidity_pct,
    pressure_inhg: s.pressure_inhg,
    wind_speed_mph: null,
    wind_gust_mph: null,
    wind_direction_deg: null,
    visibility_mi: null,
    uv_index: null,
    cloud_cover_pct: null,
  };
}

// What feeds the trend chart — either the AirNow zip-code station or a
// specific PurpleAir sensor's own history.
type TrendSource = { kind: "station"; zip: string } | { kind: "sensor"; sensorIndex: string };

// ─── Gauge arc ───────────────────────────────────────────────────────────────

function AqiGauge({ aqi }: { aqi: number | null }) {
  const MAX_AQI = 300;
  const pct = aqi != null ? Math.min(aqi / MAX_AQI, 1) : 0;
  // Arc goes from 200° to 340° (140° sweep) → dasharray 251 for r=80 arc
  const arcLen = 251;
  const filled = pct * arcLen;
  const color = aqiColor(aqi);

  return (
    <svg width="200" height="120" viewBox="0 0 200 120" aria-label={`AQI gauge: ${aqi ?? "no data"}`}>
      {/* Track */}
      <path
        d="M20,104 A80,80 0 0,1 180,104"
        fill="none"
        stroke="var(--border)"
        strokeWidth="13"
        strokeLinecap="round"
      />
      {/* Filled arc */}
      <path
        d="M20,104 A80,80 0 0,1 180,104"
        fill="none"
        stroke={color}
        strokeWidth="13"
        strokeLinecap="round"
        strokeDasharray={arcLen}
        strokeDashoffset={arcLen - filled}
        style={{ transition: "stroke-dashoffset 0.6s ease, stroke 0.4s ease" }}
      />
      {/* AQI number */}
      <text
        x="100" y="98"
        textAnchor="middle"
        fontSize="38"
        fontWeight="500"
        fill={color}
        style={{ transition: "fill 0.4s ease" }}
      >
        {aqi ?? "—"}
      </text>
      {/* Scale labels */}
      <text x="20"  y="118" textAnchor="middle" fontSize="10" fill="var(--gray-text)">0</text>
      <text x="180" y="118" textAnchor="middle" fontSize="10" fill="var(--gray-text)">300</text>
    </svg>
  );
}

// ─── Wind compass ─────────────────────────────────────────────────────────────

function WindCompass({ deg }: { deg: number | null }) {
  return (
    <svg width="110" height="110" viewBox="0 0 110 110" aria-label={`Wind direction: ${deg ?? "unknown"} degrees`}>
      <circle cx="55" cy="55" r="48" fill="none" stroke="var(--border)" strokeWidth="1" />
      {["N","E","S","W"].map((d, i) => {
        const angle = i * 90 - 90;
        const rad = (angle * Math.PI) / 180;
        const x = 55 + 38 * Math.cos(rad);
        const y = 55 + 38 * Math.sin(rad) + 4;
        return <text key={d} x={x} y={y} textAnchor="middle" fontSize="11" fill="var(--text-muted)">{d}</text>;
      })}
      {/* Arrow rotated to wind direction */}
      <g transform={`rotate(${deg ?? 0} 55 55)`}>
        <polygon points="55,15 51,38 55,32 59,38" fill="var(--teal)" />
        <line x1="55" y1="38" x2="55" y2="92" stroke="var(--border)" strokeWidth="1.5" />
      </g>
      <circle cx="55" cy="55" r="4" fill="var(--teal)" />
      <text x="55" y="76" textAnchor="middle" fontSize="10" fill="var(--gray-text)">
        {deg != null ? `${bearingLabel(deg)} ${deg}°` : "—"}
      </text>
    </svg>
  );
}

// ─── Pollutant bar ────────────────────────────────────────────────────────────

function PollutantRow({
  name, value, unit, max, color,
}: {
  name: string; value: number | null; unit: string; max: number; color: string;
}) {
  const pct = value != null ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "6px 0", borderBottom: "0.5px solid var(--border)" }}>
      <span style={{ fontSize: 13, fontWeight: 500, minWidth: 52, color: "var(--text)" }}>{name}</span>
      <div style={{ flex: 1, height: 6, background: "var(--border)", borderRadius: 3, margin: "0 10px", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 0.5s ease" }} />
      </div>
      <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 80, textAlign: "right" }}>
        {value != null ? `${fmt(value)} ${unit}` : "—"}
      </span>
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({ icon, label, value, sub }: { icon: string; label: string; value: string; sub?: string }) {
  return (
    <div style={{
      background: "var(--page-bg)", borderRadius: "var(--radius-md)",
      padding: "10px 12px", display: "flex", flexDirection: "column", gap: 2,
    }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{icon} {label}</div>
      <div style={{ fontSize: 20, fontWeight: 500, color: "var(--text)" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{sub}</div>}
    </div>
  );
}

// ─── Trend chart ─────────────────────────────────────────────────────────────

function TrendChart({ source }: { source: TrendSource }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<unknown>(null);
  const [points, setPoints] = useState<{ label: string; aqi: number | null }[]>([]);

  useEffect(() => {
    const url =
      source.kind === "station"
        ? `/api/history?zip=${source.zip}&hours=24`
        : `/api/sensor-history?sensor_index=${source.sensorIndex}&hours=24`;

    fetch(url)
      .then((r) => r.json())
      .then((res: HistoryResponse) => {
        const data = res.data.map((p) => ({
          label: new Date(p.fetched_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          aqi: p.aqi,
        }));
        setPoints(data);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.kind, source.kind === "station" ? source.zip : source.sensorIndex]);

  useEffect(() => {
    if (!points.length || !canvasRef.current) return;

    import("chart.js/auto").then(({ default: Chart }) => {
      // Destroy previous instance
      if (chartRef.current) (chartRef.current as { destroy(): void }).destroy();

      const pointColors = points.map((p) => {
        if (!p.aqi) return "#888780";
        if (p.aqi <= 50)  return "#639922";
        if (p.aqi <= 100) return "#EF9F27";
        if (p.aqi <= 150) return "#D85A30";
        return "#E24B4A";
      });

      chartRef.current = new Chart(canvasRef.current!, {
        type: "line",
        data: {
          labels: points.map((p) => p.label),
          datasets: [{
            label: "AQI",
            data: points.map((p) => p.aqi),
            borderColor: "#1D9E75",
            borderWidth: 2,
            pointBackgroundColor: pointColors,
            pointRadius: 4,
            fill: true,
            backgroundColor: "rgba(29,158,117,0.07)",
            tension: 0.4,
            spanGaps: true,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const v = ctx.raw as number;
                  return `AQI ${v} — ${aqiLabel(v)}`;
                },
              },
            },
          },
          scales: {
            y: {
              min: 0,
              suggestedMax: 160,
              ticks: { color: "#888780", font: { size: 11 } },
              grid: { color: "rgba(136,135,128,0.12)" },
            },
            x: {
              ticks: {
                color: "#888780",
                font: { size: 10 },
                maxRotation: 0,
                autoSkip: true,
                maxTicksLimit: 8,
              },
              grid: { display: false },
            },
          },
        },
      });
    });

    return () => {
      if (chartRef.current) (chartRef.current as { destroy(): void }).destroy();
    };
  }, [points]);

  if (!points.length) {
    return (
      <div style={{ height: 180, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
        History builds up as you use EcoLens — check back after a few refreshes.
      </div>
    );
  }

  return (
    <div style={{ position: "relative", height: 180 }}>
      <canvas ref={canvasRef} role="img" aria-label="24-hour AQI trend chart" />
    </div>
  );
}

// ─── Source comparison chip ──────────────────────────────────────────────

function SourceChip({
  label, aqi, sub, selected, onClick,
}: {
  label: string; aqi: number | null; sub?: string; selected?: boolean; onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        background: selected ? "var(--card-bg)" : "var(--page-bg)",
        border: selected ? "1.5px solid var(--teal)" : "1.5px solid transparent",
        borderRadius: "var(--radius-md)",
        padding: "6px 12px", fontSize: 12,
        font: "inherit",
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <span style={{
        width: 10, height: 10, borderRadius: "50%",
        background: aqiColor(aqi), display: "inline-block", flexShrink: 0,
      }} />
      <span style={{ fontWeight: 500, color: "var(--text)" }}>{label}</span>
      <span style={{ color: "var(--text-muted)" }}>
        {aqi ?? "—"}{sub ? ` · ${sub}` : ""}
      </span>
    </button>
  );
}

// ─── Unified sensor map + comparison card ──────────────────────────────────

function AllSensorsCard({
  reading,
  sensors,
  loaded,
  sensorsCached,
  sensorsCacheAge,
  selected,
  onSelect,
}: {
  reading: AirQualityReading;
  sensors: SensorReading[];
  loaded: boolean;
  sensorsCached: boolean;
  sensorsCacheAge: number;
  selected: SourceSelection;
  onSelect: (sel: SourceSelection) => void;
}) {
  // The official EPA AirNow reading, reshaped into a map point. Memoized so
  // SensorMap's effect doesn't redraw the whole map on every parent re-render.
  const station: StationPoint = useMemo(() => ({
    zip_code: reading.location.zip_code,
    city: reading.location.city,
    state: reading.location.state,
    lat: reading.location.lat,
    lng: reading.location.lng,
    aqi: reading.aqi,
    aqi_category: reading.aqi_category,
    pm25: reading.pm25,
    fetched_at: reading.fetched_at,
  }), [reading]);

  return (
    <div style={{
      background: "var(--card-bg)", border: "0.5px solid var(--border)",
      borderRadius: "var(--radius-lg)", padding: "1rem 1.25rem",
      marginBottom: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Live sensor map {`(EPA AirNow${sensors.length > 0 ? ` + ${sensors.length} PurpleAir` : ""})`}
          {" · click a marker or chip to view its data below"}
        </div>
        {loaded && sensors.length > 0 && (
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {sensorsCached ? `Cached · ${Math.round(sensorsCacheAge / 60)} min ago` : "Live"}
          </div>
        )}
      </div>

      <SensorMap sensors={sensors} station={station} selected={selected} onSelect={onSelect} />

      {sensors.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          <SourceChip
            label="EPA AirNow"
            aqi={reading.aqi}
            sub={reading.location.zip_code}
            selected={selected.kind === "station"}
            onClick={() => onSelect({ kind: "station" })}
          />
          {sensors.map((s) => (
            <SourceChip
              key={s.sensor_index}
              label={s.label ?? `Sensor ${s.sensor_index}`}
              aqi={s.aqi}
              selected={selected.kind === "sensor" && selected.sensor_index === s.sensor_index}
              onClick={() => onSelect({ kind: "sensor", sensor_index: s.sensor_index })}
            />
          ))}
        </div>
      ) : (
        loaded && (
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8 }}>
            No portable sensors configured yet. Once PurpleAir sensor indices are
            set, they&apos;ll appear on the map and here for comparison against
            the official AirNow reading.
          </div>
        )
      )}
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

const DEFAULT_ZIP = "38116"; // South Memphis

export default function Home() {
  const [zip, setZip]     = useState("");
  const [input, setInput] = useState("");
  const [data, setData]   = useState<AirQualityReading | null>(null);
  const [cached, setCached] = useState(false);
  const [cacheAge, setCacheAge] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Portable PurpleAir sensor fleet — lifted up from AllSensorsCard so the
  // whole dashboard (not just the map) can react to whichever one is selected.
  const [sensors, setSensors] = useState<SensorReading[]>([]);
  const [sensorsLoaded, setSensorsLoaded] = useState(false);
  const [sensorsCached, setSensorsCached] = useState(false);
  const [sensorsCacheAge, setSensorsCacheAge] = useState(0);

  // Which source's data drives the dashboard cards — the AirNow station by
  // default, or whichever map marker / chip the user last clicked.
  const [selected, setSelected] = useState<SourceSelection>({ kind: "station" });

  const fetchData = useCallback(async (z: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/readings?zip=${z}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Request failed");
      const r = json as ReadingsResponse;
      setData(r.data);
      setCached(r.cached);
      setCacheAge(r.cache_age_seconds);
      setZip(z);
      setSelected({ kind: "station" }); // a new search always resets the view to the station
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSensors = useCallback(async () => {
    try {
      const res = await fetch("/api/sensors");
      const json = (await res.json()) as SensorsResponse;
      if (res.ok) {
        setSensors(json.data ?? []);
        setSensorsCached(json.cached);
        setSensorsCacheAge(json.cache_age_seconds);
      }
    } catch {
      // Non-fatal — sensor fleet is a supplementary view
    } finally {
      setSensorsLoaded(true);
    }
  }, []);

  // Load default zip on mount
  useEffect(() => {
    setInput(DEFAULT_ZIP);
    fetchData(DEFAULT_ZIP);
  }, [fetchData]);

  // Load the sensor fleet on mount, then refresh roughly as often as the
  // server-side cache TTL (5 min).
  useEffect(() => {
    loadSensors();
    const id = setInterval(loadSensors, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadSensors]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const z = input.trim().replace(/\D/g, "").slice(0, 5);
    if (z.length === 5) fetchData(z);
  }

  const d = data;

  // Normalize whichever source is selected into one common display shape.
  // Falls back to the station reading if a previously-selected sensor drops
  // out of the live fleet (e.g. it went offline).
  const selectedReading = useMemo<SelectedReading | null>(() => {
    if (!d) return null;
    if (selected.kind === "sensor") {
      const s = sensors.find((x) => x.sensor_index === selected.sensor_index);
      if (s) return sensorToSelectedReading(s, sensorsCached, sensorsCacheAge);
    }
    return stationToSelectedReading(d, cached, cacheAge);
  }, [d, cached, cacheAge, selected, sensors, sensorsCached, sensorsCacheAge]);

  const trendSource = useMemo<TrendSource>(() => {
    if (selected.kind === "sensor" && sensors.some((s) => s.sensor_index === selected.sensor_index)) {
      return { kind: "sensor", sensorIndex: selected.sensor_index };
    }
    return { kind: "station", zip };
  }, [selected, sensors, zip]);

  const aqi = selectedReading?.aqi ?? null;

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "1.5rem 1rem 3rem" }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 9, background: "var(--teal)",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
          }}>🌿</div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 500 }}>EcoLens</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>MEMSouth Environmental Monitor</div>
          </div>
        </div>

        {/* Search */}
        <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value.replace(/\D/g, "").slice(0, 5))}
            placeholder="Enter zip code"
            maxLength={5}
            inputMode="numeric"
            style={{
              padding: "8px 12px",
              border: "0.5px solid var(--border)",
              borderRadius: "var(--radius-md)",
              background: "var(--card-bg)",
              color: "var(--text)",
              width: 140,
              fontSize: 14,
            }}
          />
          <button
            type="submit"
            disabled={loading || input.replace(/\D/g, "").length !== 5}
            style={{
              padding: "8px 16px",
              background: "var(--teal)",
              color: "#fff",
              border: "none",
              borderRadius: "var(--radius-md)",
              fontSize: 14,
              fontWeight: 500,
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Loading…" : "Search"}
          </button>
        </form>
      </header>

      {/* ── Error ──────────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          background: "var(--red-bg)", border: "0.5px solid var(--red)",
          borderRadius: "var(--radius-md)", padding: "12px 16px",
          color: "var(--red)", marginBottom: "1rem", fontSize: 14,
        }}>
          {error}
        </div>
      )}

      {/* ── Loading skeleton ───────────────────────────────────────────── */}
      {loading && !d && (
        <div style={{ textAlign: "center", padding: "4rem 0", color: "var(--text-muted)" }}>
          Fetching environmental data…
        </div>
      )}

      {/* ── Dashboard ──────────────────────────────────────────────────── */}
      {d && selectedReading && (
        <>
          {/* ── Live sensor map (AirNow + PurpleAir) ────────────────────── */}
          <AllSensorsCard
            reading={d}
            sensors={sensors}
            loaded={sensorsLoaded}
            sensorsCached={sensorsCached}
            sensorsCacheAge={sensorsCacheAge}
            selected={selected}
            onSelect={setSelected}
          />

          {/* Location + last updated bar */}
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            flexWrap: "wrap", gap: 8, marginBottom: "1rem",
            padding: "8px 14px",
            background: "var(--card-bg)",
            border: "0.5px solid var(--border)",
            borderRadius: "var(--radius-md)",
            fontSize: 13,
          }}>
            <span style={{ fontWeight: 500 }}>
              📍 {selectedReading.locationLabel}
              {selectedReading.zipLabel && (
                <>
                  {" "}
                  <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                    ({selectedReading.zipLabel})
                  </span>
                </>
              )}
            </span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {selectedReading.cached
                ? `Cached · ${Math.round(selectedReading.cache_age_seconds / 60)} min ago`
                : `Live · ${new Date(selectedReading.fetched_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
              {" · "}
              {selectedReading.sourceLabel}
            </span>
          </div>

          {/* ── Row 1: AQI + Pollutants ─────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)", gap: 12, marginBottom: 12 }}>

            {/* AQI card */}
            <div style={{
              background: "var(--card-bg)", border: "0.5px solid var(--border)",
              borderRadius: "var(--radius-lg)", padding: "1rem 1.25rem",
              display: "flex", flexDirection: "column", alignItems: "center",
            }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", alignSelf: "flex-start", marginBottom: 4 }}>
                Air Quality Index
              </div>
              <AqiGauge aqi={aqi} />
              <div style={{
                marginTop: 8, padding: "5px 14px",
                background: aqiBg(aqi), borderRadius: "var(--radius-md)",
                fontSize: 12, fontWeight: 500, color: aqiColor(aqi),
                textAlign: "center",
              }}>
                {aqiLabel(aqi)}
              </div>
              {selectedReading.dominant_pollutant && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
                  Dominant: {selectedReading.dominant_pollutant}
                </div>
              )}
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8, textAlign: "center", lineHeight: 1.4 }}>
                {aqiAdvice(aqi)}
              </div>
            </div>

            {/* Pollutants card */}
            <div style={{
              background: "var(--card-bg)", border: "0.5px solid var(--border)",
              borderRadius: "var(--radius-lg)", padding: "1rem 1.25rem",
            }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Pollutant breakdown</div>
              <PollutantRow name="PM2.5" value={selectedReading.pm25}   unit="µg/m³" max={75}   color="var(--amber)" />
              <PollutantRow name="PM10"  value={selectedReading.pm10}   unit="µg/m³" max={150}  color="var(--green)" />
              <PollutantRow name="O₃"    value={selectedReading.o3_ppb} unit="ppb"   max={120}  color="var(--amber)" />
              <PollutantRow name="NO₂"   value={selectedReading.no2_ppb} unit="ppb"  max={100}  color="var(--green)" />
              <PollutantRow name="CO"    value={selectedReading.co_ppm} unit="ppm"   max={9}    color="var(--green)" />
              <PollutantRow name="SO₂"   value={selectedReading.so2_ppb} unit="ppb"  max={75}   color="var(--green)" />
              {selectedReading.co2_ppm != null && (
                <PollutantRow name="CO₂" value={selectedReading.co2_ppm} unit="ppm" max={600} color="var(--orange)" />
              )}
            </div>
          </div>

          {/* ── Row 2: Wind · Atmosphere · Visibility ───────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 12 }}>

            {/* Wind */}
            <div style={{
              background: "var(--card-bg)", border: "0.5px solid var(--border)",
              borderRadius: "var(--radius-lg)", padding: "1rem 1.25rem",
            }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Wind</div>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <WindCompass deg={selectedReading.wind_direction_deg} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                <StatCard icon="💨" label="Speed"     value={`${fmt(selectedReading.wind_speed_mph)} mph`} />
                <StatCard icon="💨" label="Gust"      value={`${fmt(selectedReading.wind_gust_mph)} mph`} />
                <StatCard icon="🧭" label="Direction" value={`${fmtInt(selectedReading.wind_direction_deg)}°`} />
                <StatCard icon="🧭" label="Bearing"   value={bearingLabel(selectedReading.wind_direction_deg)} />
              </div>
            </div>

            {/* Atmosphere */}
            <div style={{
              background: "var(--card-bg)", border: "0.5px solid var(--border)",
              borderRadius: "var(--radius-lg)", padding: "1rem 1.25rem",
            }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Atmosphere</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <StatCard
                  icon="🌡️" label="Temperature"
                  value={`${fmt(selectedReading.temperature_f, 0)}°F`}
                  sub={selectedReading.feels_like_f != null ? `Feels like ${fmt(selectedReading.feels_like_f, 0)}°F` : undefined}
                />
                <StatCard icon="💧" label="Humidity"    value={`${fmtInt(selectedReading.humidity_pct)}%`} />
                <StatCard icon="🔵" label="Pressure"    value={`${fmt(selectedReading.pressure_inhg)} inHg`} />
              </div>
            </div>

            {/* Visibility & UV */}
            <div style={{
              background: "var(--card-bg)", border: "0.5px solid var(--border)",
              borderRadius: "var(--radius-lg)", padding: "1rem 1.25rem",
            }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Visibility & sky</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <StatCard icon="👁️" label="Visibility"   value={`${fmt(selectedReading.visibility_mi)} mi`} />
                <StatCard
                  icon="☀️" label="UV Index"
                  value={fmtInt(selectedReading.uv_index)}
                  sub={
                    selectedReading.uv_index == null ? undefined :
                    selectedReading.uv_index <= 2 ? "Low" :
                    selectedReading.uv_index <= 5 ? "Moderate" :
                    selectedReading.uv_index <= 7 ? "High" :
                    selectedReading.uv_index <= 10 ? "Very High" : "Extreme"
                  }
                />
                <StatCard icon="☁️" label="Cloud cover" value={`${fmtInt(selectedReading.cloud_cover_pct)}%`} />
              </div>
            </div>
          </div>

          {/* ── Row 3: Trend chart ───────────────────────────────────── */}
          <div style={{
            background: "var(--card-bg)", border: "0.5px solid var(--border)",
            borderRadius: "var(--radius-lg)", padding: "1rem 1.25rem",
            marginBottom: 12,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>24-hour AQI trend</div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {[
                  { color: "#639922", label: "Good" },
                  { color: "#EF9F27", label: "Moderate" },
                  { color: "#D85A30", label: "Sensitive" },
                  { color: "#E24B4A", label: "Unhealthy" },
                ].map(({ color, label }) => (
                  <span key={label} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-muted)" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: "inline-block" }} />
                    {label}
                  </span>
                ))}
              </div>
            </div>
            <TrendChart key={selected.kind === "station" ? `station-${zip}` : `sensor-${selected.sensor_index}`} source={trendSource} />
          </div>

          {/* ── Footer ──────────────────────────────────────────────── */}
          <div style={{
            fontSize: 11, color: "var(--text-muted)",
            display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8,
          }}>
            <span>
              {selected.kind === "station"
                ? "Data: EPA AirNow · Open-Meteo (CC BY 4.0) · Nominatim/OSM (ODbL)"
                : "Data: PurpleAir portable sensor"}
            </span>
            <button
              onClick={() => (selected.kind === "station" ? fetchData(zip) : loadSensors())}
              disabled={loading}
              style={{
                fontSize: 11, padding: "3px 10px",
                border: "0.5px solid var(--border)",
                borderRadius: "var(--radius-md)",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              ↻ Refresh
            </button>
          </div>
        </>
      )}
    </main>
  );
}
