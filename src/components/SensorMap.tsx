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

/** 16-point-ish compass abbreviation from a wind direction in degrees. */
function degToCompass(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
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
  // Area-wide wind-pattern overlay (grid of sampled arrows) — off by
  // default, toggled via the Leaflet layers control. See loadWindGrid below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const windGridLayerRef = useRef<any>(null);
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
          scrollWheelZoom: false,
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
        const darkLayer = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
            '&copy; <a href="https://carto.com/attributions">CARTO</a>',
          maxZoom: 20,
          subdomains: "abcd",
        });

        streetLayer.addTo(mapRef.current);

        // ── Wind direction/speed overlay (toggleable, see below) ─────────────
        windLayerRef.current = L.layerGroup().addTo(mapRef.current);

        // ── Area-wide wind-pattern overlay: grid of sampled arrows ───────────
        // Not added to the map yet — starts unchecked, since enabling it
        // triggers a network fetch. The layers control adds/removes it from
        // the map when the user toggles its checkbox, which fires the
        // overlayadd/overlayremove events handled below.
        windGridLayerRef.current = L.layerGroup();

        const loadWindGrid = () => {
          if (!mapRef.current || !windGridLayerRef.current) return;
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
              if (!data?.points || !windGridLayerRef.current) return;
              windGridLayerRef.current.clearLayers();
              for (const p of data.points) {
                if (p.wind_speed_mph == null || p.wind_direction_deg == null) continue;
                const dirLabel = degToCompass(p.wind_direction_deg);
                const speed = Math.round(p.wind_speed_mph);
                const icon = L.divIcon({
                  className: "",
                  html:
                    `<div class="ecolens-wind-badge-grid" style="display:flex;flex-direction:column;` +
                    `align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;` +
                    `background:radial-gradient(circle, #60A5FA 0%, #2563EB 75%);color:#fff;` +
                    `pointer-events:none;opacity:0.9;">` +
                    `<div style="font-size:8px;font-weight:700;line-height:1;">${dirLabel}</div>` +
                    `<div style="font-size:7px;line-height:1;">${speed}</div>` +
                    `</div>`,
                  iconSize: [30, 30],
                  iconAnchor: [15, 15],
                });
                L.marker([p.lat, p.lng], { icon, interactive: false }).addTo(windGridLayerRef.current);
              }
            })
            .catch(() => {
              // Best-effort overlay — silently skip on network error.
            });
        };

        mapRef.current.on("overlayadd", (e: { name: string }) => {
          if (e.name !== "Wind pattern (area)") return;
          windGridActiveRef.current = true;
          loadWindGrid();
        });
        mapRef.current.on("overlayremove", (e: { name: string }) => {
          if (e.name !== "Wind pattern (area)") return;
          windGridActiveRef.current = false;
          windGridLayerRef.current?.clearLayers();
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
              Dark: darkLayer,
            },
            {
              "Wind (speed + direction)": windLayerRef.current,
              "Wind pattern (area)": windGridLayerRef.current,
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

        // Wind direction/speed arrow — only the EPA/Open-Meteo station has
        // wind data; portable PurpleAir sensors don't measure wind.
        if (windLayerRef.current && station.wind_speed_mph != null && station.wind_direction_deg != null) {
          const dirLabel = degToCompass(station.wind_direction_deg);
          const speed = Math.round(station.wind_speed_mph);
          const windIcon = L.divIcon({
            className: "",
            html:
              `<div class="ecolens-wind-badge" style="display:flex;flex-direction:column;` +
              `align-items:center;justify-content:center;width:46px;height:46px;border-radius:50%;` +
              `background:radial-gradient(circle, #3B82F6 0%, #1D4ED8 70%);color:#fff;` +
              `pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,0.4);">` +
              `<div style="font-size:12px;font-weight:700;line-height:1;">${dirLabel}</div>` +
              `<div style="font-size:9px;line-height:1.1;margin-top:1px;">${speed} mph</div>` +
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
