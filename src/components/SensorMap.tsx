"use client";

/**
 * SensorMap
 *
 * Renders an OpenStreetMap/Leaflet map with one colored marker per portable
 * PurpleAir sensor. Leaflet touches the DOM directly, so all of its work
 * happens inside useEffect (client-only) — never during SSR.
 */

import { useEffect, useRef, useState } from "react";
import "leaflet/dist/leaflet.css";
import type { SensorReading, SourceSelection } from "@/types/ecolens";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "Open in Google Maps" / "Get directions" links, shared by both marker popups. */
function mapLinksHtml(lat: number, lng: number): string {
  const q = `${lat},${lng}`;
  return (
    `<a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>` +
    ` &middot; ` +
    `<a href="https://www.google.com/maps/dir/?api=1&destination=${q}" target="_blank" rel="noopener noreferrer">Get directions</a>`
  );
}

type WindGridPoint = {
  lat: number;
  lng: number;
  wind_speed_mph: number;
  wind_direction_deg: number;
};

/** 8-point compass abbreviation for the direction wind is blowing FROM
 *  (meteorological convention) — used inside the per-station badge, the
 *  same idiom as the reference app's circular wind badge (e.g. "SE" over
 *  the speed number, no separate arrow glyph). */
function degToCompass(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

/**
 * Custom Leaflet layer: an animated field of drifting particles that trace
 * the local wind direction (a "streamline" effect) — no underlying color
 * wash, just the flecks themselves, per explicit follow-up feedback that
 * the opaque speed-tinted background should go away entirely. This is our
 * own original take on the "glowing flow lines" idiom used by several
 * mainstream weather/wind apps — built from scratch here (plain canvas +
 * inverse-distance-weighted interpolation over our own sampled grid data),
 * not copied pixel-for-pixel from any one app's exact palette, particle
 * density, or chrome.
 *
 * A single <canvas> lives in the overlay pane (particle trails, repainted
 * every animation frame), kept pinned to the viewport on every 'move' event
 * so it tracks the map without needing to be redrawn every pixel of a drag.
 *
 * getFleckColors() is read fresh every animation frame rather than baked in
 * once, so the particle color can react live to which base layer is active
 * (contrasting yellow over Satellite imagery, the default steel blue
 * elsewhere) without tearing down and recreating the layer.
 */
function createWindFlowLayer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  L: any,
  getPoints: () => WindGridPoint[],
  getFleckColors: () => { stroke: string; shadow: string }
) {
  const PARTICLE_COUNT = 420;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function windAt(pts: WindGridPoint[], lat: number, lng: number) {
    let sumW = 0;
    let sumU = 0;
    let sumV = 0;
    let sumSpeed = 0;
    for (const p of pts) {
      const dLat = lat - p.lat;
      const dLng = lng - p.lng;
      const distSq = dLat * dLat + dLng * dLng;
      const w = 1 / Math.max(distSq, 1e-7);
      // Meteorological convention: direction wind is coming FROM. Convert
      // to a "blowing toward" unit vector for advection.
      const toRad = (p.wind_direction_deg * Math.PI) / 180 + Math.PI;
      sumU += Math.sin(toRad) * w;
      sumV += -Math.cos(toRad) * w; // screen y grows downward
      sumW += w;
      sumSpeed += p.wind_speed_mph * w;
    }
    if (sumW === 0) return null;
    return { u: sumU / sumW, v: sumV / sumW, speed: sumSpeed / sumW };
  }

  const WindFlowLayer = L.Layer.extend({
    onAdd(map: L.Map) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._map = map as any;
      this._flowCanvas = L.DomUtil.create("canvas", "ecolens-wind-flow-canvas");
      this._flowCtx = this._flowCanvas.getContext("2d");

      map.getPanes().overlayPane.appendChild(this._flowCanvas);

      this._reset = this._reset.bind(this);
      this._animate = this._animate.bind(this);

      map.on("move", this._reset);
      map.on("resize", this._reset);

      this._reset();
      this._particles = [];
      const size = map.getSize();
      for (let i = 0; i < PARTICLE_COUNT; i++) this._particles.push(this._spawn(size));

      this._running = true;
      this._frame = requestAnimationFrame(this._animate);
    },
    onRemove(map: L.Map) {
      this._running = false;
      if (this._frame) cancelAnimationFrame(this._frame);
      map.off("move", this._reset);
      map.off("resize", this._reset);
      L.DomUtil.remove(this._flowCanvas);
    },
    _spawn(size: { x: number; y: number }) {
      return {
        x: Math.random() * size.x,
        y: Math.random() * size.y,
        age: Math.random() * 60,
        life: 50 + Math.random() * 50,
      };
    },
    _reset() {
      const topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._flowCanvas, topLeft);
      const size = this._map.getSize();
      if (this._flowCanvas.width !== size.x || this._flowCanvas.height !== size.y) {
        this._flowCanvas.width = size.x;
        this._flowCanvas.height = size.y;
      }
    },
    _animate() {
      if (!this._running) return;
      const ctx = this._flowCtx;
      const size = this._map.getSize();

      // Fade the previous frame's marks instead of clearing outright. The
      // reference app's flecks read as short, soft dashes rather than long
      // bright comet trails, so this fade is faster than a true streamline
      // viz would use — short-lived enough to keep dashes short, slow
      // enough that motion is still clearly perceptible.
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.09)";
      ctx.fillRect(0, 0, size.x, size.y);
      ctx.globalCompositeOperation = "source-over";

      const pts = getPoints();
      if (pts.length) {
        // Soft, blurred flecks rather than crisp lines — closer to the
        // reference app's texture than a sharp streamline. Color swaps to a
        // contrasting yellow over the Satellite basemap (steel blue reads
        // poorly against true-color imagery); see getFleckColors().
        const { stroke, shadow } = getFleckColors();
        ctx.shadowColor = shadow;
        ctx.shadowBlur = 2.5;
        for (const particle of this._particles) {
          const latlng = this._map.containerPointToLatLng([particle.x, particle.y]);
          const wind = windAt(pts, latlng.lat, latlng.lng);
          if (!wind) continue;
          const speedFactor = Math.min(wind.speed / 12, 2.2);
          const vx = wind.u * (0.5 + speedFactor);
          const vy = wind.v * (0.5 + speedFactor);
          const nx = particle.x + vx;
          const ny = particle.y + vy;

          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.moveTo(particle.x, particle.y);
          ctx.lineTo(nx, ny);
          ctx.stroke();

          particle.x = nx;
          particle.y = ny;
          particle.age++;

          if (particle.age > particle.life || particle.x < 0 || particle.x > size.x || particle.y < 0 || particle.y > size.y) {
            const fresh = this._spawn(size);
            particle.x = fresh.x;
            particle.y = fresh.y;
            particle.age = 0;
            particle.life = fresh.life;
          }
        }
        ctx.shadowBlur = 0;
      }

      this._frame = requestAnimationFrame(this._animate);
    },
  });

  return new WindFlowLayer();
}

/** Small attribution note (bottom-right), shown while the area wind overlay
 *  is active — cites the actual upstream provider (Open-Meteo) behind both
 *  wind overlays' data. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createWindSourceNote(L: any) {
  const WindSourceNote = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
      const div = L.DomUtil.create("div", "ecolens-wind-source");
      div.innerHTML =
        `Area wind data: <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a>`;
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  return new WindSourceNote();
}

type AqiGridPoint = { lat: number; lng: number; aqi: number };

/**
 * Continuous AQI → RGB color ramp for the heatmap wash specifically (the
 * markers keep using the discrete 6-band aqiHex() below — that's correct
 * for a marker labeled with an official EPA category). The wash needs a
 * smooth ramp instead: aqiHex() snaps any value to one of 6 flat colors, so
 * two nearby points that are, say, AQI 38 and AQI 47 — a real, visible
 * difference in air quality — render as the exact same flat green, which is
 * why the heatmap looked like it had "no differing values" even once it had
 * real spatial data behind it. Linear-interpolates between anchor colors.
 *
 * Extra anchors at 25/75 (beyond the plain EPA breakpoints) deliberately
 * stretch the contrast within 0–100 specifically: real-world CONUS AQI on
 * any given day clusters almost entirely in 20–60 (confirmed against live
 * /api/aqi-grid output), so a ramp that only bends color at 0/50/100 spends
 * most of its range on values that rarely occur. Splitting that span across
 * green → yellow-green → gold means a 26-vs-59 day reads as a visibly
 * different green-to-gold gradient instead of two shades of the same green.
 */
const AQI_COLOR_STOPS: Array<[number, [number, number, number]]> = [
  [0, [180, 214, 150]], // pale green — pristine air
  [25, [140, 196, 80]], // fresh green
  [50, [223, 199, 45]], // gold-yellow — good/moderate boundary
  [75, [233, 165, 40]], // amber-orange — deep into moderate
  [100, [224, 123, 41]], // orange — moderate/USG boundary
  [150, [216, 90, 48]], // orange-red — unhealthy for sensitive groups
  [200, [226, 75, 74]], // red — unhealthy
  [300, [127, 119, 221]], // purple — very unhealthy
  [500, [153, 60, 29]], // maroon — hazardous
];

function aqiToWashRgb(aqi: number): [number, number, number] {
  const stops = AQI_COLOR_STOPS;
  if (aqi <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [hi, hiRgb] = stops[i];
    if (aqi <= hi) {
      const [lo, loRgb] = stops[i - 1];
      const t = (aqi - lo) / (hi - lo);
      return [
        Math.round(loRgb[0] + (hiRgb[0] - loRgb[0]) * t),
        Math.round(loRgb[1] + (hiRgb[1] - loRgb[1]) * t),
        Math.round(loRgb[2] + (hiRgb[2] - loRgb[2]) * t),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * Custom Leaflet layer: a soft, gradiented color wash showing the current
 * AQI rating across the map — inverse-distance-weighted interpolation (same
 * approach as the wind wash above) over a combined point set: whichever AQI
 * readings are already on screen (AirNow station, NCore/PAMS site, located
 * PurpleAir sensors) PLUS a denser external grid sampled from Open-Meteo's
 * Air Quality API (see loadAqiGrid). The on-screen readings alone are too
 * sparse and often near-duplicate-valued (the NCore reading is itself
 * sourced from "AirNow's nearest reporting site") to show any real spatial
 * variation, so the external grid supplies actual modeled texture for the
 * gradient to render. Each point reads as its own soft "blob" of color using
 * the same aqiHex() scale as the markers, so the gradient stays visually
 * consistent with the rest of the dashboard.
 *
 * Kept deliberately low-opacity (see WASH_ALPHA) — a faint area tint rather
 * than a layer that competes with the markers or basemap — but not so low
 * that the gradient itself becomes imperceptible; see aqiToWashRgb()'s doc
 * comment for why a continuous color ramp (not the markers' discrete
 * aqiHex() bands) is what actually makes the gradient visible at all.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createAqiWashLayer(L: any, getPoints: () => AqiGridPoint[]) {
  const WASH_W = 48;
  const WASH_H = 36;
  // Out of 255. Originally set to 18 (~7%) per a "bring this to near zero"
  // request, but that — combined with aqiHex()'s discrete color bands —
  // left the wash effectively invisible: nothing read as different even
  // when the underlying data wasn't flat. Raised once to 60 (~24%); raised
  // again here to 100 (~39%) alongside the widened 0–100 color contrast
  // above, since on a low-pollution day the real AQI spread (e.g. 26–59
  // CONUS-wide) is inherently low-saturation and needs both a bigger color
  // swing and more opacity to read clearly against the basemap.
  const WASH_ALPHA = 100; // ~39%

  function aqiAt(pts: AqiGridPoint[], lat: number, lng: number): number | null {
    let sumW = 0;
    let sumAqi = 0;
    for (const p of pts) {
      const dLat = lat - p.lat;
      const dLng = lng - p.lng;
      const distSq = dLat * dLat + dLng * dLng;
      const w = 1 / Math.max(distSq, 1e-7);
      sumAqi += p.aqi * w;
      sumW += w;
    }
    if (sumW === 0) return null;
    return sumAqi / sumW;
  }

  const AqiWashLayer = L.Layer.extend({
    onAdd(map: L.Map) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._map = map as any;
      this._canvas = L.DomUtil.create("canvas", "ecolens-aqi-wash-canvas");
      this._ctx = this._canvas.getContext("2d");
      this._lowCanvas = document.createElement("canvas");
      this._lowCanvas.width = WASH_W;
      this._lowCanvas.height = WASH_H;
      this._lowCtx = this._lowCanvas.getContext("2d");

      map.getPanes().overlayPane.appendChild(this._canvas);

      this._reset = this._reset.bind(this);
      this.refresh = this.refresh.bind(this);

      map.on("move", this._reset);
      map.on("resize", this._reset);
      map.on("moveend", this.refresh);

      this._reset();
      this.refresh();
    },
    onRemove(map: L.Map) {
      map.off("move", this._reset);
      map.off("resize", this._reset);
      map.off("moveend", this.refresh);
      L.DomUtil.remove(this._canvas);
    },
    _reset() {
      const topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      const size = this._map.getSize();
      if (this._canvas.width !== size.x || this._canvas.height !== size.y) {
        this._canvas.width = size.x;
        this._canvas.height = size.y;
      }
    },
    refresh() {
      if (!this._map || !this._ctx) return;
      const size = this._map.getSize();
      const pts = getPoints();
      this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      if (!pts.length) return;

      const img = this._lowCtx.createImageData(WASH_W, WASH_H);
      for (let j = 0; j < WASH_H; j++) {
        for (let i = 0; i < WASH_W; i++) {
          const px = ((i + 0.5) / WASH_W) * size.x;
          const py = ((j + 0.5) / WASH_H) * size.y;
          const latlng = this._map.containerPointToLatLng([px, py]);
          const aqi = aqiAt(pts, latlng.lat, latlng.lng);
          const idx = (j * WASH_W + i) * 4;
          if (aqi == null) {
            img.data[idx + 3] = 0;
            continue;
          }
          const [r, g, b] = aqiToWashRgb(aqi);
          img.data[idx] = r;
          img.data[idx + 1] = g;
          img.data[idx + 2] = b;
          img.data[idx + 3] = WASH_ALPHA;
        }
      }
      this._lowCtx.putImageData(img, 0, 0);
      this._ctx.imageSmoothingEnabled = true;
      this._ctx.drawImage(this._lowCanvas, 0, 0, size.x, size.y);
    },
  });

  return new AqiWashLayer();
}

function aqiHex(aqi: number | null): string {
  if (aqi == null) return "#888780";
  if (aqi <= 50) return "#639922";
  if (aqi <= 100) return "#EF9F27";
  if (aqi <= 150) return "#D85A30";
  if (aqi <= 200) return "#E24B4A";
  if (aqi <= 300) return "#7F77DD";
  return "#993C1D";
}

// Hover/selected accent — keep in sync with --highlight in globals.css.
// Hardcoded (rather than var(--highlight)) because Leaflet sets this as an
// SVG presentation attribute / inline style on elements it controls directly,
// and we want it to render identically on every browser, including iOS Safari.
const HIGHLIGHT = "#FF7A1A";

const DEFAULT_CENTER: [number, number] = [35.1495, -90.049]; // Memphis, TN

/** The single official EPA AirNow reading for the searched zip code. */
export interface StationPoint {
  zip_code: string;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
  aqi: number | null;
  aqi_category: string | null;
  pm25: number | null;
  fetched_at: string;
  wind_speed_mph: number | null;
  wind_direction_deg: number | null;
}

/**
 * The fixed Shelby Farms Park reference site — one physical location
 * hosting both the NCore (since 2009) and PAMS (since 2021) monitoring
 * programs. Always rendered on the map regardless of the searched zip;
 * the live numbers here are best-effort (nearest AirNow station + Open-
 * Meteo), not a guaranteed exact match to the NCore monitor's own feed.
 */
export interface NcoreSitePoint {
  name: string;
  lat: number;
  lng: number;
  aqi: number | null;
  aqi_category: string | null;
  pm25: number | null;
  fetched_at: string;
  wind_speed_mph: number | null;
  wind_direction_deg: number | null;
}

export default function SensorMap({
  sensors,
  station,
  ncoreSite,
  selected,
  onSelect,
  addresses,
}: {
  sensors: SensorReading[];
  station?: StationPoint;
  ncoreSite?: NcoreSitePoint;
  selected?: SourceSelection;
  onSelect?: (sel: SourceSelection) => void;
  addresses?: Record<string, string | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef = useRef<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const windLayerRef = useRef<any>(null);
  // Area-wide wind-pattern overlay (animated flow field + speed wash) — off
  // by default, toggled via the Leaflet layers control. See loadWindGrid
  // below; windGridDataRef holds the latest sampled points that the flow
  // layer reads from on every animation frame.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const windFlowLayerRef = useRef<any>(null);
  const windGridDataRef = useRef<WindGridPoint[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const windSourceNoteRef = useRef<any>(null);
  const windGridActiveRef = useRef(false);
  const windGridDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Name of the currently-active base tile layer ("Street", "Satellite",
  // etc.) — read live by the wind-flow particle animation so flecks can
  // switch to a contrasting yellow over Satellite imagery. Updated via the
  // map's 'baselayerchange' event, fired by the layers control.
  const activeBaseLayerRef = useRef<string>("Street");
  // AQI gradient-blob overlay — combines whatever AQI readings are already
  // in props (station, ncoreSite, sensors) with a denser external grid
  // fetched from Open-Meteo's Air Quality API (see loadAqiGrid below), so
  // there's enough real spatial variation for the heatmap to show texture
  // instead of one flat smeared color.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const aqiWashLayerRef = useRef<any>(null);
  const aqiPointsRef = useRef<AqiGridPoint[]>([]);
  const aqiGridDataRef = useRef<AqiGridPoint[]>([]);
  const aqiGridActiveRef = useRef(false);
  const aqiGridDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Boundary-line overlays (congressional districts, counties, ZIP/ZCTA) —
  // plain L.geoJSON vector outlines, no fill, sourced server-side from the
  // Census Bureau's TIGERweb service (see /api/boundaries/*). Tennessee's 9
  // congressional districts are a small fixed set fetched once on toggle;
  // county and ZIP lines are bbox-scoped and refetch on pan like the
  // wind/AQI grids above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const congressionalLayerRef = useRef<any>(null);
  const congressionalLoadedRef = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const countyLayerRef = useRef<any>(null);
  const countyActiveRef = useRef(false);
  const countyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zipLayerRef = useRef<any>(null);
  const zipActiveRef = useRef(false);
  const zipDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once the one-time "fit to all known points" has run (page load /
  // refresh). After that, selection changes pan to the selected point
  // instead of re-fitting the whole metro area.
  const initialFitDoneRef = useRef(false);
  const prevSelectedKeyRef = useRef<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    import("leaflet").then((L) => {
      if (cancelled || !containerRef.current) return;

      const located = sensors.filter((s) => s.lat != null && s.lng != null);
      const allPoints: [number, number][] = [
        ...(station ? [[station.lat, station.lng] as [number, number]] : []),
        ...located.map((s) => [s.lat as number, s.lng as number] as [number, number]),
      ];

      // Feed points for the AQI gradient-blob overlay — every reading with a
      // known AQI and location. Recomputed every effect run so the overlay
      // (if currently toggled on) stays in sync with fresh data.
      aqiPointsRef.current = [
        ...(station && station.aqi != null ? [{ lat: station.lat, lng: station.lng, aqi: station.aqi }] : []),
        ...(ncoreSite && ncoreSite.aqi != null
          ? [{ lat: ncoreSite.lat, lng: ncoreSite.lng, aqi: ncoreSite.aqi }]
          : []),
        ...located
          .filter((s) => s.aqi != null)
          .map((s) => ({ lat: s.lat as number, lng: s.lng as number, aqi: s.aqi as number })),
      ];

      if (!mapRef.current) {
        mapRef.current = L.map(containerRef.current, {
          center: allPoints[0] ?? DEFAULT_CENTER,
          zoom: allPoints.length ? 11 : 9,
          // Scroll-to-zoom while the cursor is over the map, plus Leaflet's
          // native double-click-to-zoom-in / shift+double-click-to-zoom-out.
          scrollWheelZoom: true,
          doubleClickZoom: true,
        });

        // ── Selectable base layers (all free, no API key required) ───────────
        const streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 19,
        });
        const topoLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
          attribution:
            'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
            '<a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; ' +
            '<a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
          maxZoom: 17,
        });
        const satelliteLayer = L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          {
            attribution:
              "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
            maxZoom: 19,
          }
        );
        const lightLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
            '&copy; <a href="https://carto.com/attributions">CARTO</a>',
          maxZoom: 20,
          subdomains: "abcd",
        });
        streetLayer.addTo(mapRef.current);

        // ── Wind direction/speed overlay (toggleable, see below) ─────────────
        windLayerRef.current = L.layerGroup().addTo(mapRef.current);

        // ── Area-wide wind-pattern overlay: animated flow field + speed wash ─
        // Not added to the map yet — starts unchecked, since enabling it
        // triggers a network fetch. The layers control adds/removes it from
        // the map when the user toggles its checkbox, which fires the
        // overlayadd/overlayremove events handled below.
        windFlowLayerRef.current = createWindFlowLayer(L, () => windGridDataRef.current, () =>
          activeBaseLayerRef.current === "Satellite"
            ? { stroke: "rgba(255,214,10,0.9)", shadow: "rgba(255,214,10,0.95)" } // contrasting yellow
            : { stroke: "rgba(0,71,171,0.6)", shadow: "rgba(0,71,171,0.675)" } // default steel blue, ~25% less prominent
        );
        windSourceNoteRef.current = createWindSourceNote(L);

        // ── AQI gradient-blob overlay: faint area wash, marker readings +
        // an external Open-Meteo grid for real spatial variation ──────────
        aqiWashLayerRef.current = createAqiWashLayer(L, () => [
          ...aqiPointsRef.current,
          ...aqiGridDataRef.current,
        ]);

        // ── Boundary-line overlays: plain vector outlines, no fill ───────────
        // Colors match TIGERweb's own default Census renderer for each layer,
        // so they read as "official" and stay visually distinct from the
        // wind (steel blue flecks) and AQI (green-to-gold wash) overlays.
        congressionalLayerRef.current = L.geoJSON(undefined, {
          style: { color: "#1E82C3", weight: 2, dashArray: "6,4", fillOpacity: 0 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onEachFeature: (feature: any, layer: any) => {
            const p = feature.properties ?? {};
            const label = p.CD119 ? `TN Congressional District ${p.CD119}` : p.BASENAME ?? p.NAME;
            if (label) layer.bindPopup(label);
          },
        });
        countyLayerRef.current = L.geoJSON(undefined, {
          style: { color: "#9B9B9B", weight: 1.25, fillOpacity: 0 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onEachFeature: (feature: any, layer: any) => {
            const p = feature.properties ?? {};
            const label = p.BASENAME ?? p.NAME;
            if (label) layer.bindPopup(`${label} County`);
          },
        });
        zipLayerRef.current = L.geoJSON(undefined, {
          style: { color: "#99454A", weight: 1.5, dashArray: "2,4", fillOpacity: 0 },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onEachFeature: (feature: any, layer: any) => {
            const p = feature.properties ?? {};
            const zip = p.ZCTA5 ?? p.BASENAME;
            if (zip) layer.bindPopup(`ZIP ${zip}`);
          },
        });

        mapRef.current.on("baselayerchange", (e: { name: string }) => {
          activeBaseLayerRef.current = e.name;
        });

        const loadWindGrid = () => {
          if (!mapRef.current) return;
          const b = mapRef.current.getBounds();
          const params = new URLSearchParams({
            south: String(b.getSouth()),
            west: String(b.getWest()),
            north: String(b.getNorth()),
            east: String(b.getEast()),
          });
          fetch(`/api/wind-grid?${params}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data: { points?: Array<{ lat: number; lng: number; wind_speed_mph: number | null; wind_direction_deg: number | null }> } | null) => {
              if (!data?.points) return;
              windGridDataRef.current = data.points.filter(
                (p): p is WindGridPoint => p.wind_speed_mph != null && p.wind_direction_deg != null
              );
            })
            .catch(() => {
              // Best-effort overlay — silently skip on network error.
            });
        };

        // Same bbox-grid idiom as loadWindGrid, hitting Open-Meteo's Air
        // Quality API instead — supplies the real spatial variation the AQI
        // heatmap can't get from the handful of on-screen marker readings
        // alone (see createAqiWashLayer's doc comment for why).
        const loadAqiGrid = () => {
          if (!mapRef.current) return;
          const b = mapRef.current.getBounds();
          const params = new URLSearchParams({
            south: String(b.getSouth()),
            west: String(b.getWest()),
            north: String(b.getNorth()),
            east: String(b.getEast()),
          });
          fetch(`/api/aqi-grid?${params}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((data: { points?: Array<{ lat: number; lng: number; aqi: number | null }> } | null) => {
              if (!data?.points) return;
              aqiGridDataRef.current = data.points.filter((p): p is AqiGridPoint => p.aqi != null);
              aqiWashLayerRef.current?.refresh();
            })
            .catch(() => {
              // Best-effort overlay — silently skip on network error.
            });
        };

        // Tennessee has a fixed 9 congressional districts — fetch once on
        // first toggle and keep it cached; no bbox/pan dependency.
        const loadCongressionalDistricts = () => {
          if (congressionalLoadedRef.current) return;
          fetch("/api/boundaries/congressional")
            .then((res) => (res.ok ? res.json() : null))
            .then((geojson) => {
              if (!geojson) return;
              congressionalLoadedRef.current = true;
              congressionalLayerRef.current?.clearLayers();
              congressionalLayerRef.current?.addData(geojson);
            })
            .catch(() => {
              // Best-effort overlay — silently skip on network error.
            });
        };

        // Same bbox-on-viewport idiom as loadWindGrid/loadAqiGrid, hitting
        // the Census Bureau's TIGERweb boundary service instead.
        const loadCountyLines = () => {
          if (!mapRef.current) return;
          const b = mapRef.current.getBounds();
          const params = new URLSearchParams({
            south: String(b.getSouth()),
            west: String(b.getWest()),
            north: String(b.getNorth()),
            east: String(b.getEast()),
          });
          fetch(`/api/boundaries/county?${params}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((geojson) => {
              if (!geojson) return;
              countyLayerRef.current?.clearLayers();
              countyLayerRef.current?.addData(geojson);
            })
            .catch(() => {
              // Best-effort overlay — silently skip on network error.
            });
        };

        const loadZipLines = () => {
          if (!mapRef.current) return;
          const b = mapRef.current.getBounds();
          const params = new URLSearchParams({
            south: String(b.getSouth()),
            west: String(b.getWest()),
            north: String(b.getNorth()),
            east: String(b.getEast()),
          });
          fetch(`/api/boundaries/zip?${params}`)
            .then((res) => (res.ok ? res.json() : null))
            .then((geojson) => {
              if (!geojson) return;
              zipLayerRef.current?.clearLayers();
              zipLayerRef.current?.addData(geojson);
            })
            .catch(() => {
              // Best-effort overlay — silently skip on network error.
            });
        };

        mapRef.current.on("overlayadd", (e: { name: string }) => {
          if (e.name === "Wind pattern (area)") {
            windGridActiveRef.current = true;
            windSourceNoteRef.current?.addTo(mapRef.current);
            loadWindGrid();
          } else if (e.name === "Air quality (heatmap)") {
            aqiGridActiveRef.current = true;
            loadAqiGrid();
          } else if (e.name === "Congressional districts (TN)") {
            loadCongressionalDistricts();
          } else if (e.name === "County lines") {
            countyActiveRef.current = true;
            loadCountyLines();
          } else if (e.name === "ZIP code lines") {
            zipActiveRef.current = true;
            loadZipLines();
          }
        });
        mapRef.current.on("overlayremove", (e: { name: string }) => {
          if (e.name === "Wind pattern (area)") {
            windGridActiveRef.current = false;
            windGridDataRef.current = [];
            mapRef.current.removeControl(windSourceNoteRef.current);
          } else if (e.name === "Air quality (heatmap)") {
            aqiGridActiveRef.current = false;
            aqiGridDataRef.current = [];
          } else if (e.name === "County lines") {
            countyActiveRef.current = false;
          } else if (e.name === "ZIP code lines") {
            zipActiveRef.current = false;
          }
          // Congressional districts: nothing to reset — the small, fixed TN
          // dataset stays cached in the layer so toggling back on is instant.
        });
        mapRef.current.on("moveend", () => {
          if (windGridActiveRef.current) {
            if (windGridDebounceRef.current) clearTimeout(windGridDebounceRef.current);
            windGridDebounceRef.current = setTimeout(loadWindGrid, 400);
          }
          if (aqiGridActiveRef.current) {
            if (aqiGridDebounceRef.current) clearTimeout(aqiGridDebounceRef.current);
            aqiGridDebounceRef.current = setTimeout(loadAqiGrid, 400);
          }
          if (countyActiveRef.current) {
            if (countyDebounceRef.current) clearTimeout(countyDebounceRef.current);
            countyDebounceRef.current = setTimeout(loadCountyLines, 400);
          }
          if (zipActiveRef.current) {
            if (zipDebounceRef.current) clearTimeout(zipDebounceRef.current);
            zipDebounceRef.current = setTimeout(loadZipLines, 400);
          }
        });

        L.control
          .layers(
            {
              Street: streetLayer,
              Topographic: topoLayer,
              Satellite: satelliteLayer,
              Light: lightLayer,
            },
            {
              "Wind (speed + direction)": windLayerRef.current,
              "Wind pattern (area)": windFlowLayerRef.current,
              "Air quality (heatmap)": aqiWashLayerRef.current,
              "Congressional districts (TN)": congressionalLayerRef.current,
              "County lines": countyLayerRef.current,
              "ZIP code lines": zipLayerRef.current,
            },
            { position: "topright", collapsed: true }
          )
          .addTo(mapRef.current);
      }

      // Clear previous markers before redrawing
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      windLayerRef.current?.clearLayers();

      // ── Official EPA AirNow station (diamond marker) ───────────────────
      if (station) {
        const isSelected = !selected || selected.kind === "station";
        const color = aqiHex(station.aqi);
        const size = isSelected ? 26 : 20;
        const normalBorder = isSelected ? `4px solid ${HIGHLIGHT}` : "3px solid #fff";
        const hoverBorder = isSelected ? `4px solid ${HIGHLIGHT}` : `3px solid ${HIGHLIGHT}`;
        const border = normalBorder;
        const icon = L.divIcon({
          className: "",
          html:
            `<div style="width:${size}px;height:${size}px;background:${color};` +
            `border:${border};border-radius:4px;` +
            `box-shadow:0 1px 4px rgba(0,0,0,0.45);transform:rotate(45deg);"></div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });

        const marker = L.marker([station.lat, station.lng], { icon, zIndexOffset: isSelected ? 1000 : 0 }).addTo(
          mapRef.current
        );

        const stationAddress = addresses?.station;
        marker.bindPopup(
          `<strong>EPA AirNow${station.city ? ` — ${station.city}` : ""}</strong><br/>` +
            `Zip ${station.zip_code}<br/>` +
            (stationAddress ? `${escapeHtml(stationAddress)}<br/>` : "") +
            `AQI ${station.aqi ?? "—"}${station.aqi_category ? ` (${station.aqi_category})` : ""}<br/>` +
            `PM2.5: ${station.pm25 != null ? station.pm25.toFixed(1) : "—"} µg/m³<br/>` +
            (station.wind_speed_mph != null
              ? `Wind: ${Math.round(station.wind_speed_mph)} mph${
                  station.wind_direction_deg != null ? ` from ${Math.round(station.wind_direction_deg)}°` : ""
                }<br/>`
              : "") +
            `Updated ${new Date(station.fetched_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}<br/>` +
            mapLinksHtml(station.lat, station.lng)
        );

        marker.on("click", () => onSelect?.({ kind: "station" }));
        marker.on("mouseover", () => {
          const inner = marker.getElement()?.firstElementChild as HTMLElement | null;
          if (inner) inner.style.border = hoverBorder;
        });
        marker.on("mouseout", () => {
          const inner = marker.getElement()?.firstElementChild as HTMLElement | null;
          if (inner) inner.style.border = normalBorder;
        });

        markersRef.current.push(marker);

        // Wind direction/speed badge — only the EPA/Open-Meteo station has
        // wind data; portable PurpleAir sensors don't measure wind.
        if (windLayerRef.current && station.wind_speed_mph != null && station.wind_direction_deg != null) {
          const speed = Math.round(station.wind_speed_mph);
          const compass = degToCompass(station.wind_direction_deg);
          const windIcon = L.divIcon({
            className: "",
            html:
              `<div class="ecolens-wind-badge" style="display:flex;flex-direction:column;` +
              `align-items:center;justify-content:center;width:46px;height:46px;border-radius:50%;` +
              `background:#ffffff;pointer-events:none;">` +
              `<div style="font-size:9px;font-weight:700;line-height:1.1;color:#64748B;letter-spacing:0.03em;">${compass}</div>` +
              `<div style="font-size:15px;font-weight:700;line-height:1;color:#0047AB;">${speed}</div>` +
              `<div style="font-size:7px;font-weight:600;line-height:1.1;color:#64748B;letter-spacing:0.04em;">MPH</div>` +
              `</div>`,
            iconSize: [46, 46],
            iconAnchor: [23, 23],
          });
          L.marker([station.lat, station.lng], {
            icon: windIcon,
            interactive: false,
            zIndexOffset: 2000,
          }).addTo(windLayerRef.current);
        }
      }

      // ── NCore/PAMS reference site (Shelby Farms Park) ───────────────────
      // Always rendered, independent of the searched zip — one physical
      // EPA site hosts both the NCore (since 2009) and PAMS (since 2021)
      // programs, so this is a single marker rather than two. Distinct
      // "lab flask" icon to read as a reference/official site at a glance,
      // separate from the searched-zip diamond and the PurpleAir circles.
      if (ncoreSite) {
        const isSelected = selected?.kind === "ncore";
        const color = aqiHex(ncoreSite.aqi);
        const size = isSelected ? 30 : 24;
        const normalBorder = isSelected ? `4px solid ${HIGHLIGHT}` : `3px solid ${color}`;
        const hoverBorder = `4px solid ${HIGHLIGHT}`;
        const icon = L.divIcon({
          className: "",
          html:
            `<div style="width:${size}px;height:${size}px;background:#fff;` +
            `border:${normalBorder};border-radius:8px;` +
            `box-shadow:0 1px 4px rgba(0,0,0,0.45);display:flex;` +
            `align-items:center;justify-content:center;font-size:${Math.round(size * 0.58)}px;` +
            `line-height:1;">🧪</div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });

        const marker = L.marker([ncoreSite.lat, ncoreSite.lng], {
          icon,
          zIndexOffset: isSelected ? 1000 : 500,
        }).addTo(mapRef.current);

        const ncoreAddress = addresses?.ncore;
        marker.bindPopup(
          `<strong>${escapeHtml(ncoreSite.name)} — NCore / PAMS</strong><br/>` +
            `One EPA site, two monitoring programs: NCore (criteria pollutants, ` +
            `since 2009) and PAMS (speciated VOCs/carbonyls, since 2021).<br/>` +
            (ncoreAddress ? `${escapeHtml(ncoreAddress)}<br/>` : "") +
            `<em>Pin location is approximate (Shelby Farms Park, general ` +
            `coordinates) — the monitor shed's exact address isn't yet ` +
            `confirmed. Reading below is via AirNow's nearest reporting ` +
            `site, not a guaranteed exact monitor match.</em><br/>` +
            `AQI ${ncoreSite.aqi ?? "—"}${ncoreSite.aqi_category ? ` (${ncoreSite.aqi_category})` : ""}<br/>` +
            `PM2.5: ${ncoreSite.pm25 != null ? ncoreSite.pm25.toFixed(1) : "—"} µg/m³<br/>` +
            (ncoreSite.wind_speed_mph != null
              ? `Wind: ${Math.round(ncoreSite.wind_speed_mph)} mph${
                  ncoreSite.wind_direction_deg != null ? ` from ${Math.round(ncoreSite.wind_direction_deg)}°` : ""
                }<br/>`
              : "") +
            `Archival speciated PAMS data: see the PAMS card on the dashboard ` +
            `once EPA AQS access is confirmed.<br/>` +
            `Updated ${new Date(ncoreSite.fetched_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}<br/>` +
            mapLinksHtml(ncoreSite.lat, ncoreSite.lng)
        );

        marker.on("click", () => onSelect?.({ kind: "ncore" }));
        marker.on("mouseover", () => {
          const inner = marker.getElement()?.firstElementChild as HTMLElement | null;
          if (inner) inner.style.border = hoverBorder;
        });
        marker.on("mouseout", () => {
          const inner = marker.getElement()?.firstElementChild as HTMLElement | null;
          if (inner) inner.style.border = normalBorder;
        });

        markersRef.current.push(marker);
      }

      // ── Portable PurpleAir sensors (circle markers) ─────────────────────
      located.forEach((s) => {
        const isSelected = selected?.kind === "sensor" && selected.sensor_index === s.sensor_index;
        const normalStyle = { color: isSelected ? HIGHLIGHT : "#fff", weight: isSelected ? 4 : 2 };
        const hoverStyle = { color: HIGHLIGHT, weight: isSelected ? 4 : 3 };
        const marker = L.circleMarker([s.lat as number, s.lng as number], {
          radius: isSelected ? 14 : 10,
          ...normalStyle,
          fillColor: aqiHex(s.aqi),
          fillOpacity: 0.9,
        }).addTo(mapRef.current);

        const sensorAddress = addresses?.[s.sensor_index];
        marker.bindPopup(
          `<strong>${s.label ?? `Sensor ${s.sensor_index}`}</strong><br/>` +
            (sensorAddress ? `${escapeHtml(sensorAddress)}<br/>` : "") +
            `AQI ${s.aqi ?? "—"}${s.aqi_category ? ` (${s.aqi_category})` : ""}<br/>` +
            `PM2.5: ${s.pm25 != null ? s.pm25.toFixed(1) : "—"} µg/m³<br/>` +
            `Updated ${new Date(s.fetched_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}<br/>` +
            mapLinksHtml(s.lat as number, s.lng as number)
        );

        marker.on("click", () => onSelect?.({ kind: "sensor", sensor_index: s.sensor_index }));
        marker.on("mouseover", () => marker.setStyle(hoverStyle));
        marker.on("mouseout", () => marker.setStyle(normalStyle));

        markersRef.current.push(marker);
      });

      // Keep the AQI gradient-blob overlay in sync with the freshest
      // readings — no-ops safely if the layer isn't currently on the map.
      aqiWashLayerRef.current?.refresh();

      const selectedKey = !selected
        ? null
        : selected.kind === "station"
        ? "station"
        : selected.kind === "ncore"
        ? "ncore"
        : `sensor:${selected.sensor_index}`;

      // On the very first load (or a hard page refresh), fit the view to
      // show every known point — the "metro area" overview. After that,
      // re-running this effect (e.g. because the user clicked a sensor)
      // should NOT re-fit to everything again — it should just pan to
      // whatever got newly selected.
      if (!initialFitDoneRef.current) {
        initialFitDoneRef.current = true;
        if (allPoints.length > 1) {
          mapRef.current.fitBounds(allPoints, { padding: [30, 30], maxZoom: 13 });
        } else if (allPoints.length === 1) {
          mapRef.current.setView(allPoints[0], 12);
        } else {
          mapRef.current.setView(DEFAULT_CENTER, 9);
        }
      } else if (selectedKey && selectedKey !== prevSelectedKeyRef.current && selected) {
        const sel = selected;
        const coords =
          sel.kind === "station"
            ? station
              ? ([station.lat, station.lng] as [number, number])
              : null
            : sel.kind === "ncore"
            ? ncoreSite
              ? ([ncoreSite.lat, ncoreSite.lng] as [number, number])
              : null
            : (() => {
                const s = located.find((s) => s.sensor_index === sel.sensor_index);
                return s ? ([s.lat as number, s.lng as number] as [number, number]) : null;
              })();
        if (coords) mapRef.current.panTo(coords);
      }
      prevSelectedKeyRef.current = selectedKey;
    });

    return () => {
      cancelled = true;
    };
  }, [sensors, station, ncoreSite, selected, onSelect, addresses]);

  // Tear the map down completely on unmount (e.g. fast refresh / nav away)
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Leaflet caches its container's pixel size; a pure CSS height change
  // (expand/collapse) needs an explicit nudge after the transition so tiles
  // fill the new area instead of leaving blank/cropped edges.
  useEffect(() => {
    if (!mapRef.current) return;
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 260);
    return () => clearTimeout(t);
  }, [expanded]);

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-label={expanded ? "Collapse map" : "Expand map"}
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          zIndex: 1000,
          background: "rgba(255,255,255,0.92)",
          color: "#1a1a18",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "4px 9px",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        }}
      >
        {expanded ? "Collapse map" : "Expand map"}
      </button>
      <div
        ref={containerRef}
        className="ecolens-map"
        style={{
          width: "100%",
          height: expanded ? "min(75vh, 720px)" : 320,
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
          transition: "height 0.25s ease",
        }}
        aria-label="Map of live portable air-quality sensors"
      />
    </div>
  );
}
