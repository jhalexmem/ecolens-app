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

function aqiHex(aqi: number | null): string {
  if (aqi == null) return "#888780";
  if (aqi <= 50) return "#639922";
  if (aqi <= 100) return "#EF9F27";
  if (aqi <= 150) return "#D85A30";
  if (aqi <= 200) return "#E24B4A";
  if (aqi <= 300) return "#7F77DD";
  return "#993C1D";
}

export interface BoundaryInfo {
  zip: string | null;
  county: string | null;
  district: string | null;
  repName: string | null;
}

/**
 * Point-in-polygon lookup behind the floating boundary indicator — shared by
 * the "active selection" effect below and by clicking directly into any of
 * the boundary-line overlays (congressional district / county / ZIP), which
 * always resolves all three designations for the clicked point regardless
 * of which of the three overlays happen to be toggled on.
 */
async function fetchBoundaryInfo(lat: number, lng: number): Promise<BoundaryInfo | null> {
  try {
    const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
    const res = await fetch(`/api/boundaries/lookup?${params}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Which of the 3 designations the user wants surfaced on hover/click — set
// via the checkboxes in the fixed "Show on map" control (see
// createDesignationPrefsControl below). Defaults to "show everything
// available" so behavior out of the box matches what the floating indicator
// always did; the control lets the user narrow that down, and the choice
// persists across subsequent hovers/clicks until changed again.
export interface DesignationPrefs {
  zip: boolean;
  county: boolean;
  district: boolean;
}

function maskBoundaryInfo(data: BoundaryInfo, prefs: DesignationPrefs): BoundaryInfo {
  return {
    zip: prefs.zip ? data.zip : null,
    county: prefs.county ? data.county : null,
    district: prefs.district ? data.district : null,
    repName: prefs.district ? data.repName : null,
  };
}

function formatDesignations(data: BoundaryInfo, prefs: DesignationPrefs): string | null {
  const parts = [
    prefs.zip && data.zip ? `ZIP ${data.zip}` : null,
    prefs.county && data.county ? `${data.county} County` : null,
    prefs.district && data.district ? `Congressional District ${data.district}` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Single, always-visible control (top-right) that is now the one place to
 * manage the 3 boundary divisions: each checkbox both draws/removes that
 * division's line overlay on the map AND decides whether it's surfaced in
 * the hover tooltip and the bottom-left indicator — replacing what used to
 * be split between Leaflet's own layers dropdown (line visibility) and this
 * control (tooltip content). One control, one mental model: check it to see
 * it everywhere, uncheck it to see it nowhere. Also the natural home for any
 * future map-display toggles.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createDesignationPrefsControl(
  L: any,
  prefs: DesignationPrefs,
  onToggle: (key: keyof DesignationPrefs, checked: boolean) => void
) {
  const DesignationPrefsControl = L.Control.extend({
    options: { position: "topright" },
    onAdd() {
      const container = L.DomUtil.create("div", "ecolens-designation-control");

      const title = document.createElement("div");
      title.className = "ecolens-designation-control-title";
      title.textContent = "Show on map:";
      container.appendChild(title);

      const addCheckbox = (key: keyof DesignationPrefs, text: string) => {
        const wrap = document.createElement("label");
        wrap.className = "ecolens-designation-control-checkbox";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = prefs[key];
        input.addEventListener("change", () => {
          prefs[key] = input.checked;
          onToggle(key, input.checked);
        });
        wrap.appendChild(input);
        wrap.appendChild(document.createTextNode(` ${text}`));
        container.appendChild(wrap);
      };

      addCheckbox("zip", "ZIP");
      addCheckbox("county", "County");
      addCheckbox("district", "District");

      L.DomEvent.disableClickPropagation(container);
      return container;
    },
  });
  return new DesignationPrefsControl();
}

// Hover/selected accent — keep in sync with --highlight in globals.css.
// Hardcoded (rather than var(--highlight)) because Leaflet sets this as an
// SVG presentation attribute / inline style on elements it controls directly,
// and we want it to render identically on every browser, including iOS Safari.
const HIGHLIGHT = "#FF7A1A";

// "You are here" dot/cone color — keep in sync with --locate-blue in
// globals.css. Hardcoded for the same reason as HIGHLIGHT above (used in
// Leaflet-controlled inline styles, not just CSS classes).
const LOCATE_BLUE = "#0A84FF";

// Classic "locate me" glyph (ring + center dot + 4 compass ticks), drawn
// entirely in currentColor so the button can flip between idle/following/
// paused just by toggling a CSS class — no markup swap needed.
const LOCATE_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
  '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>' +
  '<circle cx="12" cy="12" r="7"/>' +
  '<line x1="12" y1="1" x2="12" y2="4"/>' +
  '<line x1="12" y1="20" x2="12" y2="23"/>' +
  '<line x1="1" y1="12" x2="4" y2="12"/>' +
  '<line x1="20" y1="12" x2="23" y2="12"/>' +
  "</svg>";

/**
 * "Locate me" button (bottom-right, Apple/Google Maps idiom): tap to start
 * showing your live position as a pulsing blue dot + accuracy circle and
 * center the map on it; tap again while it's actively following turns it
 * off entirely. If you drag the map away while it's following, it quietly
 * drops into a "paused" state instead — the dot keeps updating, but the map
 * stops auto-panning, so it never fights your own panning/zooming (the same
 * "don't fight the user for control of the view" principle behind dropping
 * the old click-popup/pinned-fill boundary behavior). Tap once more from
 * "paused" to re-center and resume following.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createLocateControl(L: any, onClick: () => void) {
  const LocateControl = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
      const button = L.DomUtil.create("button", "ecolens-locate-button");
      button.type = "button";
      button.setAttribute("aria-label", "Show my location");
      button.title = "Show my location";
      button.innerHTML = LOCATE_ICON_SVG;
      L.DomEvent.disableClickPropagation(button);
      L.DomEvent.on(button, "click", (e: Event) => {
        L.DomEvent.stop(e);
        onClick();
      });
      return button;
    },
  });
  return new LocateControl();
}

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
  // Boundary-line overlays (congressional districts, counties, ZIP/ZCTA) —
  // plain L.geoJSON vector outlines, no fill, sourced server-side from the
  // Census Bureau's TIGERweb service (see /api/boundaries/*). Tennessee's 9
  // congressional districts are a small fixed set fetched once on toggle;
  // county and ZIP lines are bbox-scoped and refetch on pan like the
  // wind/AQI grids above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const congressionalLayerRef = useRef<any>(null);
  const congressionalLoadedRef = useRef(false);
  const congressionalActiveRef = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const countyLayerRef = useRef<any>(null);
  const countyActiveRef = useRef(false);
  const countyDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const zipLayerRef = useRef<any>(null);
  const zipActiveRef = useRef(false);
  const zipDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // User's choice of which designations to surface on hover/click, set via
  // the fixed "Show on map" control (top-right). Defaults to "all 3" — a ref
  // (not state) since it's read inside imperative Leaflet event handlers and
  // doesn't itself need to trigger a React re-render when it changes.
  const designationPrefsRef = useRef<DesignationPrefs>({ zip: true, county: true, district: true });
  // Most recent raw (unmasked) BoundaryInfo resolved from hover/click/
  // selection — kept so toggling a checkbox in the prefs control can
  // immediately re-mask and refresh the bottom-left indicator without a
  // fresh server round-trip.
  const lastBoundaryDataRef = useRef<BoundaryInfo | null>(null);
  // "You are here" locator (bottom-right button) — Apple Maps-style blue dot
  // + accuracy circle, with an optional heading cone once compass/GPS-course
  // data is available. "off" | "follow" (map auto-pans to each update) |
  // "paused" (dot still updates; map stays put because the user dragged
  // away). See createLocateControl above and its wiring further below.
  const locateStateRef = useRef<"off" | "follow" | "paused">("off");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const locateMarkerRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const locateAccuracyCircleRef = useRef<any>(null);
  const lastLocatePositionRef = useRef<[number, number] | null>(null);
  // True once the very first GPS fix after activation has centered/zoomed
  // the map — subsequent fixes pan smoothly instead of re-zooming each time.
  const locateInitialFitDoneRef = useRef(false);
  const locateWatchIdRef = useRef<number | null>(null);
  // Removes whichever device-orientation listener (if any) is currently
  // attached, then resets to a no-op once stopped — encapsulating add+remove
  // behind one ref avoids tracking the event name and handler separately.
  const locateOrientationCleanupRef = useRef<() => void>(() => {});
  const locateButtonElRef = useRef<HTMLElement | null>(null);
  const locateErrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once the one-time "fit to all known points" has run (page load /
  // refresh). After that, selection changes pan to the selected point
  // instead of re-fitting the whole metro area.
  const initialFitDoneRef = useRef(false);
  const prevSelectedKeyRef = useRef<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Floating ZIP/county/congressional-district label (bottom-left) — a
  // point-in-polygon lookup for whichever location is currently active.
  // Independent of the toggleable boundary-line overlays above, which only
  // load their data once the user switches them on; this label is meant to
  // always reflect wherever the dashboard is currently focused.
  const [boundaryInfo, setBoundaryInfo] = useState<{
    zip: string | null;
    county: string | null;
    district: string | null;
    repName: string | null;
  } | null>(null);
  // Transient error text (e.g. "Location permission denied") shown near the
  // locate button; auto-clears itself after a few seconds.
  const [locateError, setLocateError] = useState<string | null>(null);

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
        windFlowLayerRef.current = createWindFlowLayer(L, () => windGridDataRef.current, () =>
          activeBaseLayerRef.current === "Satellite"
            ? { stroke: "rgba(255,214,10,0.9)", shadow: "rgba(255,214,10,0.95)" } // contrasting yellow
            : { stroke: "rgba(0,71,171,0.6)", shadow: "rgba(0,71,171,0.675)" } // default steel blue, ~25% less prominent
        );
        windSourceNoteRef.current = createWindSourceNote(L);

        // ── Boundary-line overlays: vector outlines that fill in with their
        // true shape on hover/selection ─────────────────────────────────────
        // Colors match TIGERweb's own default Census renderer for each layer,
        // so they read as "official" and stay visually distinct from the
        // wind (steel blue flecks) overlay.
        //
        // Base fillOpacity is 0.02, not a true 0 — a fully transparent
        // (fillOpacity: 0) polygon isn't "painted" as far as the browser's
        // hit-testing is concerned, so only its stroke would respond to
        // hover/click, not its interior. A near-zero fill keeps the resting
        // look identical (outline-only) while making the whole polygon area
        // hoverable/clickable.
        //
        // attachBoundaryInteractivity wires up the rest: hovering a polygon
        // fills it in (with its own exact geometry — no approximation, since
        // it's the same feature TIGERweb/TNMap returned) to make the area's
        // real shape visible at a glance, and the fill reverts the instant
        // the cursor leaves — nothing stays highlighted once you've moved on
        // to a different spot.
        //
        // Hover and click both resolve all 3 designations for that point
        // server-side, then filter to whichever the user has checked on in
        // the fixed "Show on map" control (designationPrefsRef, top-right,
        // defaulting to all 3) — a deliberate user choice, independent of
        // which overlay lines happen to be drawn on the map at the time.
        // Hover updates the sticky tooltip that follows the cursor; click
        // additionally pins the result into the bottom-left indicator and
        // forces that same tooltip open (useful on touch, where there's no
        // hover) — neither opens a separate popup, so there's only ever one
        // thing on screen telling you what's there.
        const HOVER_FILL_OPACITY = 0.28;

        const attachBoundaryInteractivity = (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          layer: any,
          baseStyle: Record<string, unknown>,
          fallbackLabel: string
        ) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          layer.on("mouseover", (e: any) => {
            layer.setStyle({ fillOpacity: HOVER_FILL_OPACITY });
            layer.bringToFront();
            fetchBoundaryInfo(e.latlng.lat, e.latlng.lng).then((data) => {
              if (!data) return;
              lastBoundaryDataRef.current = data;
              const text = formatDesignations(data, designationPrefsRef.current) ?? fallbackLabel;
              layer.setTooltipContent(text);
            });
          });
          layer.on("mouseout", () => {
            layer.setStyle(baseStyle);
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          layer.on("click", (e: any) => {
            fetchBoundaryInfo(e.latlng.lat, e.latlng.lng).then((data) => {
              if (!data) return;
              lastBoundaryDataRef.current = data;
              const text = formatDesignations(data, designationPrefsRef.current) ?? fallbackLabel;
              layer.setTooltipContent(text);
              layer.openTooltip(e.latlng);
              setBoundaryInfo(maskBoundaryInfo(data, designationPrefsRef.current));
            });
          });
        };

        const congressionalBaseStyle = { color: "#1E82C3", weight: 2, dashArray: "6,4", fillOpacity: 0.02 };
        congressionalLayerRef.current = L.geoJSON(undefined, {
          style: congressionalBaseStyle,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onEachFeature: (feature: any, layer: any) => {
            const p = feature.properties ?? {};
            // TNMap's own field names: DISTRICT ("1".."9"), NAME (the
            // sitting representative, e.g. "Representative Steve Cohen").
            const fallbackLabel = p.DISTRICT ? `District ${p.DISTRICT}` : "";
            if (p.DISTRICT) {
              layer.bindTooltip(fallbackLabel, {
                sticky: true,
                direction: "auto",
                className: "ecolens-boundary-tooltip",
              });
            }
            attachBoundaryInteractivity(layer, congressionalBaseStyle, fallbackLabel);
          },
        });
        const countyBaseStyle = { color: "#9B9B9B", weight: 1.25, fillOpacity: 0.02 };
        countyLayerRef.current = L.geoJSON(undefined, {
          style: countyBaseStyle,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onEachFeature: (feature: any, layer: any) => {
            const p = feature.properties ?? {};
            const label = p.BASENAME ?? p.NAME;
            const fallbackLabel = label ? `${label} County` : "";
            if (label) {
              layer.bindTooltip(fallbackLabel, {
                sticky: true,
                direction: "auto",
                className: "ecolens-boundary-tooltip",
              });
            }
            attachBoundaryInteractivity(layer, countyBaseStyle, fallbackLabel);
          },
        });
        const zipBaseStyle = { color: "#99454A", weight: 1.5, dashArray: "2,4", fillOpacity: 0.02 };
        zipLayerRef.current = L.geoJSON(undefined, {
          style: zipBaseStyle,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onEachFeature: (feature: any, layer: any) => {
            const p = feature.properties ?? {};
            const zip = p.ZCTA5 ?? p.BASENAME;
            const fallbackLabel = zip ? `ZIP ${zip}` : "";
            if (zip) {
              layer.bindTooltip(fallbackLabel, {
                sticky: true,
                direction: "auto",
                className: "ecolens-boundary-tooltip",
              });
            }
            attachBoundaryInteractivity(layer, zipBaseStyle, fallbackLabel);
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

        // Same bbox-on-viewport idiom as loadWindGrid, hitting the Census
        // Bureau's TIGERweb boundary service instead.
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
          }
        });
        mapRef.current.on("overlayremove", (e: { name: string }) => {
          if (e.name === "Wind pattern (area)") {
            windGridActiveRef.current = false;
            windGridDataRef.current = [];
            mapRef.current.removeControl(windSourceNoteRef.current);
          }
        });

        // The 3 boundary divisions (ZIP/county/district) are no longer in
        // Leaflet's own layers dropdown — they're managed entirely by the
        // "Show on map" control below, which needs to both add/remove each
        // division's line layer and flip its activeRef (for the moveend
        // pan-refetch logic just above) in one place.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const boundaryLayerConfig: Record<
          keyof DesignationPrefs,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { layerRef: { current: any }; activeRef: { current: boolean }; load: () => void }
        > = {
          zip: { layerRef: zipLayerRef, activeRef: zipActiveRef, load: loadZipLines },
          county: { layerRef: countyLayerRef, activeRef: countyActiveRef, load: loadCountyLines },
          district: {
            layerRef: congressionalLayerRef,
            activeRef: congressionalActiveRef,
            load: loadCongressionalDistricts,
          },
        };

        const setBoundaryLayerActive = (key: keyof DesignationPrefs, active: boolean) => {
          const cfg = boundaryLayerConfig[key];
          cfg.activeRef.current = active;
          if (active) {
            cfg.layerRef.current?.addTo(mapRef.current);
            cfg.load();
          } else if (cfg.layerRef.current) {
            mapRef.current.removeLayer(cfg.layerRef.current);
          }
        };
        mapRef.current.on("moveend", () => {
          if (windGridActiveRef.current) {
            if (windGridDebounceRef.current) clearTimeout(windGridDebounceRef.current);
            windGridDebounceRef.current = setTimeout(loadWindGrid, 400);
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
            },
            { position: "topright", collapsed: true }
          )
          .addTo(mapRef.current);

        // Fixed "Show on map" checkbox control (top-right, under the layers
        // control) — the one and only place to manage ZIP/county/district:
        // toggling a box draws or removes that division's lines AND decides
        // whether it's surfaced in the hover tooltip/bottom-left indicator.
        createDesignationPrefsControl(L, designationPrefsRef.current, (key, checked) => {
          setBoundaryLayerActive(key, checked);
          if (lastBoundaryDataRef.current) {
            setBoundaryInfo(maskBoundaryInfo(lastBoundaryDataRef.current, designationPrefsRef.current));
          }
        }).addTo(mapRef.current);

        // Prefs default to "all 3 on" — actually turn those 3 divisions on
        // (lines drawn + pan-refetch wired up) to match what the control
        // shows as checked right out of the gate.
        (Object.keys(boundaryLayerConfig) as Array<keyof DesignationPrefs>).forEach((key) => {
          if (designationPrefsRef.current[key]) setBoundaryLayerActive(key, true);
        });

        // ── "You are here" locator (blue dot, bottom-right button) ──────────
        const updateLocateButton = () => {
          const btn = locateButtonElRef.current;
          if (!btn) return;
          btn.classList.toggle("ecolens-locate-active", locateStateRef.current === "follow");
          btn.classList.toggle("ecolens-locate-paused", locateStateRef.current === "paused");
        };

        const showLocateError = (message: string) => {
          setLocateError(message);
          if (locateErrorTimeoutRef.current) clearTimeout(locateErrorTimeoutRef.current);
          locateErrorTimeoutRef.current = setTimeout(() => setLocateError(null), 4000);
        };

        const updateConeRotation = (heading: number) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const el = (locateMarkerRef.current as any)?.getElement?.();
          const cone = el?.querySelector(".ecolens-locate-cone") as HTMLElement | null;
          if (!cone) return;
          cone.style.display = "block";
          cone.style.transform = `rotate(${heading}deg)`;
        };

        // iOS 13+ gates deviceorientation behind an explicit permission
        // prompt that can only be requested from a direct user gesture — the
        // locate button's own click satisfies that. Other browsers expose
        // the event with no extra permission step.
        const attachOrientationListener = () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const handler = (e: any) => {
            const heading =
              typeof e.webkitCompassHeading === "number"
                ? e.webkitCompassHeading
                : typeof e.alpha === "number"
                ? (360 - e.alpha) % 360
                : null;
            if (heading != null) updateConeRotation(heading);
          };
          const eventName =
            "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
          window.addEventListener(eventName, handler);
          locateOrientationCleanupRef.current = () => window.removeEventListener(eventName, handler);
        };

        const requestOrientationIfAvailable = () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const DOE: any = (window as any).DeviceOrientationEvent;
          if (!DOE) return;
          if (typeof DOE.requestPermission === "function") {
            DOE.requestPermission()
              .then((state: string) => {
                if (state === "granted") attachOrientationListener();
              })
              .catch(() => {
                // Prompt dismissed/denied — fall back to the plain dot with
                // no heading cone; not worth surfacing as an error.
              });
          } else {
            attachOrientationListener();
          }
        };

        const handlePosition = (pos: GeolocationPosition) => {
          if (!mapRef.current) return;
          const { latitude, longitude, accuracy, heading } = pos.coords;
          const latlng: [number, number] = [latitude, longitude];
          lastLocatePositionRef.current = latlng;

          if (!locateMarkerRef.current) {
            locateMarkerRef.current = L.marker(latlng, {
              icon: L.divIcon({
                className: "ecolens-locate-icon",
                html:
                  '<div class="ecolens-locate-cone" style="display:none"></div>' +
                  '<div class="ecolens-locate-dot"></div>',
                iconSize: [90, 90],
                iconAnchor: [45, 90],
              }),
              interactive: false,
              keyboard: false,
              zIndexOffset: 3000,
            }).addTo(mapRef.current);
          } else {
            locateMarkerRef.current.setLatLng(latlng);
          }

          if (!locateAccuracyCircleRef.current) {
            locateAccuracyCircleRef.current = L.circle(latlng, {
              radius: accuracy ?? 30,
              color: LOCATE_BLUE,
              weight: 1,
              fillColor: LOCATE_BLUE,
              fillOpacity: 0.12,
              interactive: false,
            }).addTo(mapRef.current);
          } else {
            locateAccuracyCircleRef.current.setLatLng(latlng);
            locateAccuracyCircleRef.current.setRadius(accuracy ?? 30);
          }

          // GPS course heading is only populated while actively moving (e.g.
          // in a car); deviceorientation (above) covers the far more common
          // "standing still, want to know which way I'm facing" case.
          if (typeof heading === "number" && !Number.isNaN(heading)) {
            updateConeRotation(heading);
          }

          if (locateStateRef.current === "follow") {
            if (!locateInitialFitDoneRef.current) {
              locateInitialFitDoneRef.current = true;
              mapRef.current.setView(latlng, Math.max(mapRef.current.getZoom(), 15));
            } else {
              mapRef.current.panTo(latlng, { animate: true });
            }
          }
        };

        const stopLocating = () => {
          if (locateWatchIdRef.current != null) {
            navigator.geolocation.clearWatch(locateWatchIdRef.current);
            locateWatchIdRef.current = null;
          }
          locateOrientationCleanupRef.current();
          locateOrientationCleanupRef.current = () => {};
          locateStateRef.current = "off";
          locateInitialFitDoneRef.current = false;
          lastLocatePositionRef.current = null;
          updateLocateButton();
          if (locateMarkerRef.current) {
            mapRef.current?.removeLayer(locateMarkerRef.current);
            locateMarkerRef.current = null;
          }
          if (locateAccuracyCircleRef.current) {
            mapRef.current?.removeLayer(locateAccuracyCircleRef.current);
            locateAccuracyCircleRef.current = null;
          }
        };

        const startLocating = () => {
          if (!navigator.geolocation) {
            showLocateError("Location isn't supported in this browser.");
            return;
          }
          locateStateRef.current = "follow";
          locateInitialFitDoneRef.current = false;
          updateLocateButton();
          requestOrientationIfAvailable();
          locateWatchIdRef.current = navigator.geolocation.watchPosition(
            handlePosition,
            (err) => {
              // 1 = PERMISSION_DENIED per the Geolocation spec.
              showLocateError(err.code === 1 ? "Location permission denied." : "Location unavailable.");
              stopLocating();
            },
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
          );
        };

        const handleLocateClick = () => {
          if (locateStateRef.current === "off") {
            startLocating();
          } else if (locateStateRef.current === "follow") {
            stopLocating();
          } else {
            locateStateRef.current = "follow";
            updateLocateButton();
            if (lastLocatePositionRef.current) {
              mapRef.current.panTo(lastLocatePositionRef.current, { animate: true });
            }
          }
        };

        // Dragging the map away while following drops us into "paused"
        // instead of fighting the pan on the next position update.
        mapRef.current.on("dragstart", () => {
          if (locateStateRef.current === "follow") {
            locateStateRef.current = "paused";
            updateLocateButton();
          }
        });

        const locateControl = createLocateControl(L, handleLocateClick);
        locateControl.addTo(mapRef.current);
        locateButtonElRef.current = locateControl.getContainer();
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
      if (locateWatchIdRef.current != null) {
        navigator.geolocation.clearWatch(locateWatchIdRef.current);
      }
      locateOrientationCleanupRef.current();
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

  // Resolve the "active" point for the floating boundary label: whatever's
  // currently selected (sensor/ncore), else the searched station, else the
  // NCore/PAMS site as a last resort. Mirrors the panTo logic in the main
  // effect above but kept separate since this fetch is much lighter-weight
  // (one point lookup vs. the full Leaflet render) and shouldn't be gated
  // behind that effect's heavier dependency list.
  useEffect(() => {
    const point: { lat: number; lng: number } | null =
      selected?.kind === "sensor"
        ? (() => {
            const s = sensors.find((s) => s.sensor_index === selected.sensor_index);
            return s && s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null;
          })()
        : selected?.kind === "ncore"
        ? ncoreSite
          ? { lat: ncoreSite.lat, lng: ncoreSite.lng }
          : null
        : station
        ? { lat: station.lat, lng: station.lng }
        : ncoreSite
        ? { lat: ncoreSite.lat, lng: ncoreSite.lng }
        : null;

    if (!point) {
      setBoundaryInfo(null);
      return;
    }

    let cancelled = false;
    fetchBoundaryInfo(point.lat, point.lng).then((data) => {
      if (!cancelled && data) {
        lastBoundaryDataRef.current = data;
        setBoundaryInfo(maskBoundaryInfo(data, designationPrefsRef.current));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selected, station, ncoreSite, sensors]);

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
      {boundaryInfo && (boundaryInfo.zip || boundaryInfo.county || boundaryInfo.district) && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            zIndex: 1000,
            background: "rgba(255,255,255,0.92)",
            color: "#1a1a18",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "4px 9px",
            fontSize: 12,
            fontWeight: 600,
            boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            pointerEvents: "none",
            maxWidth: "min(90%, 360px)",
          }}
        >
          {[
            boundaryInfo.zip ? `ZIP ${boundaryInfo.zip}` : null,
            boundaryInfo.county ? `${boundaryInfo.county} County` : null,
            boundaryInfo.district ? `Congressional District ${boundaryInfo.district}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}
      {locateError && (
        <div
          style={{
            position: "absolute",
            bottom: 50,
            right: 8,
            zIndex: 1000,
            background: "rgba(255,255,255,0.92)",
            color: "#1a1a18",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "4px 9px",
            fontSize: 12,
            fontWeight: 600,
            boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            pointerEvents: "none",
            maxWidth: "min(90%, 280px)",
            textAlign: "right",
          }}
        >
          {locateError}
        </div>
      )}
    </div>
  );
}
