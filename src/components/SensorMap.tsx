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

/** Steel-blue (calm) → pale (strong) ramp for the wind-speed wash, 0–75mph.
 *  Modeled on the reference app's own wind-map legend, which reads counter-
 *  intuitively: calmer air sits in a richer, more saturated blue and the
 *  color washes OUT toward white as speed climbs. Kept fairly narrow/flat —
 *  the reference map looks like a near-uniform color field locally, with
 *  the moving flecks carrying most of the visual information, not big
 *  blocks of contrasting color. Still never drops alpha low enough to read
 *  as "nothing happened" at calm speeds. */
function speedToRgb(mph: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, mph / 75));
  const c0 = [64, 122, 173]; // calm — saturated steel blue
  const c1 = [232, 242, 250]; // strong — washed-out pale blue
  return [
    Math.round(c0[0] + (c1[0] - c0[0]) * t),
    Math.round(c0[1] + (c1[1] - c0[1]) * t),
    Math.round(c0[2] + (c1[2] - c0[2]) * t),
  ];
}

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
 * the local wind direction (a "streamline" effect), plus a soft blue wash
 * tinted by interpolated wind speed underneath. This is our own original
 * take on the "glowing flow lines over a speed-tinted map" idiom used by
 * several mainstream weather/wind apps — built from scratch here (plain
 * canvas + inverse-distance-weighted interpolation over our own sampled
 * grid data), not copied pixel-for-pixel from any one app's exact palette,
 * particle density, or chrome.
 *
 * Two stacked <canvas> elements live in the overlay pane: a "wash" canvas
 * (full repaint only on move/zoom end or new data — cheap) and a "flow"
 * canvas (particle trails, repainted every animation frame). Both are kept
 * pinned to the viewport on every 'move' event so they track the map
 * without needing to be redrawn every pixel of a drag.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createWindFlowLayer(L: any, getPoints: () => WindGridPoint[]) {
  const PARTICLE_COUNT = 420;
  const WASH_W = 48;
  const WASH_H = 36;
  const WASH_ALPHA = 68; // out of 255 — even more see-through, per follow-up tweak

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
      this._washCanvas = L.DomUtil.create("canvas", "ecolens-wind-wash-canvas");
      this._flowCanvas = L.DomUtil.create("canvas", "ecolens-wind-flow-canvas");
      this._washCtx = this._washCanvas.getContext("2d");
      this._flowCtx = this._flowCanvas.getContext("2d");
      this._lowCanvas = document.createElement("canvas");
      this._lowCanvas.width = WASH_W;
      this._lowCanvas.height = WASH_H;
      this._lowCtx = this._lowCanvas.getContext("2d");

      const pane = map.getPanes().overlayPane;
      pane.appendChild(this._washCanvas);
      pane.appendChild(this._flowCanvas);

      this._reset = this._reset.bind(this);
      this._animate = this._animate.bind(this);
      this.refreshWash = this.refreshWash.bind(this);

      map.on("move", this._reset);
      map.on("resize", this._reset);
      map.on("moveend", this.refreshWash);

      this._reset();
      this._particles = [];
      const size = map.getSize();
      for (let i = 0; i < PARTICLE_COUNT; i++) this._particles.push(this._spawn(size));
      this.refreshWash();

      this._running = true;
      this._frame = requestAnimationFrame(this._animate);
    },
    onRemove(map: L.Map) {
      this._running = false;
      if (this._frame) cancelAnimationFrame(this._frame);
      map.off("move", this._reset);
      map.off("resize", this._reset);
      map.off("moveend", this.refreshWash);
      L.DomUtil.remove(this._washCanvas);
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
      L.DomUtil.setPosition(this._washCanvas, topLeft);
      L.DomUtil.setPosition(this._flowCanvas, topLeft);
      const size = this._map.getSize();
      for (const c of [this._washCanvas, this._flowCanvas]) {
        if (c.width !== size.x || c.height !== size.y) {
          c.width = size.x;
          c.height = size.y;
        }
      }
    },
    refreshWash() {
      if (!this._map || !this._washCtx) return;
      const size = this._map.getSize();
      const pts = getPoints();
      this._washCtx.clearRect(0, 0, this._washCanvas.width, this._washCanvas.height);
      if (!pts.length) return;

      const img = this._lowCtx.createImageData(WASH_W, WASH_H);
      for (let j = 0; j < WASH_H; j++) {
        for (let i = 0; i < WASH_W; i++) {
          const px = ((i + 0.5) / WASH_W) * size.x;
          const py = ((j + 0.5) / WASH_H) * size.y;
          const latlng = this._map.containerPointToLatLng([px, py]);
          const wind = windAt(pts, latlng.lat, latlng.lng);
          const speed = wind?.speed ?? 0;
          const [r, g, b] = speedToRgb(speed);
          const idx = (j * WASH_W + i) * 4;
          img.data[idx] = r;
          img.data[idx + 1] = g;
          img.data[idx + 2] = b;
          img.data[idx + 3] = WASH_ALPHA;
        }
      }
      this._lowCtx.putImageData(img, 0, 0);
      this._washCtx.imageSmoothingEnabled = true;
      this._washCtx.drawImage(this._lowCanvas, 0, 0, size.x, size.y);
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
        // reference app's texture than a sharp streamline.
        ctx.shadowColor = "rgba(255,255,255,0.9)";
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

          ctx.strokeStyle = "rgba(255,255,255,0.8)";
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

/** Small vertical legend ("Wind (mph)" 0–75 gradient) shown while the area wind layer is active. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createWindLegend(L: any) {
  const WindLegend = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd() {
      const div = L.DomUtil.create("div", "ecolens-wind-legend");
      div.innerHTML =
        `<div class="ecolens-wind-legend-title">Wind (mph)</div>` +
        `<div class="ecolens-wind-legend-row">` +
        `<div class="ecolens-wind-legend-bar"></div>` +
        `<div class="ecolens-wind-legend-ticks"><span>75</span><span>50</span><span>25</span><span>0</span></div>` +
        `</div>`;
      L.DomEvent.disableClickPropagation(div);
      return div;
    },
  });
  return new WindLegend();
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

export default function SensorMap({
  sensors,
  station,
  selected,
  onSelect,
  addresses,
}: {
  sensors: SensorReading[];
  station?: StationPoint;
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
  const windLegendRef = useRef<any>(null);
  const windGridActiveRef = useRef(false);
  const windGridDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        windFlowLayerRef.current = createWindFlowLayer(L, () => windGridDataRef.current);
        windLegendRef.current = createWindLegend(L);

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
              windFlowLayerRef.current?.refreshWash();
            })
            .catch(() => {
              // Best-effort overlay — silently skip on network error.
            });
        };

        mapRef.current.on("overlayadd", (e: { name: string }) => {
          if (e.name !== "Wind pattern (area)") return;
          windGridActiveRef.current = true;
          windLegendRef.current?.addTo(mapRef.current);
          loadWindGrid();
        });
        mapRef.current.on("overlayremove", (e: { name: string }) => {
          if (e.name !== "Wind pattern (area)") return;
          windGridActiveRef.current = false;
          windGridDataRef.current = [];
          windFlowLayerRef.current?.refreshWash();
          mapRef.current.removeControl(windLegendRef.current);
        });
        mapRef.current.on("moveend", () => {
          if (!windGridActiveRef.current) return;
          if (windGridDebounceRef.current) clearTimeout(windGridDebounceRef.current);
          windGridDebounceRef.current = setTimeout(loadWindGrid, 400);
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

      const selectedKey = !selected
        ? null
        : selected.kind === "station"
        ? "station"
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
  }, [sensors, station, selected, onSelect, addresses]);

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
