"use client";

/**
 * SensorMap
 *
 * Renders an OpenStreetMap/Leaflet map with one colored marker per portable
 * PurpleAir sensor. Leaflet touches the DOM directly, so all of its work
 * happens inside useEffect (client-only) — never during SSR.
 */

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type { SensorReading } from "@/types/ecolens";

function aqiHex(aqi: number | null): string {
  if (aqi == null) return "#888780";
  if (aqi <= 50) return "#639922";
  if (aqi <= 100) return "#EF9F27";
  if (aqi <= 150) return "#D85A30";
  if (aqi <= 200) return "#E24B4A";
  if (aqi <= 300) return "#7F77DD";
  return "#993C1D";
}

const DEFAULT_CENTER: [number, number] = [35.1495, -90.049]; // Memphis, TN

export default function SensorMap({ sensors }: { sensors: SensorReading[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef = useRef<any[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    import("leaflet").then((L) => {
      if (cancelled || !containerRef.current) return;

      const located = sensors.filter((s) => s.lat != null && s.lng != null);
      const center: [number, number] = located.length
        ? [
            located.reduce((sum, s) => sum + (s.lat as number), 0) / located.length,
            located.reduce((sum, s) => sum + (s.lng as number), 0) / located.length,
          ]
        : DEFAULT_CENTER;

      if (!mapRef.current) {
        mapRef.current = L.map(containerRef.current, {
          center,
          zoom: located.length ? 11 : 9,
          scrollWheelZoom: false,
        });

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 18,
        }).addTo(mapRef.current);
      } else {
        mapRef.current.setView(center, mapRef.current.getZoom());
      }

      // Clear previous markers before redrawing
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      located.forEach((s) => {
        const marker = L.circleMarker([s.lat as number, s.lng as number], {
          radius: 10,
          color: "#fff",
          weight: 2,
          fillColor: aqiHex(s.aqi),
          fillOpacity: 0.9,
        }).addTo(mapRef.current);

        marker.bindPopup(
          `<strong>${s.label ?? `Sensor ${s.sensor_index}`}</strong><br/>` +
            `AQI ${s.aqi ?? "—"}${s.aqi_category ? ` (${s.aqi_category})` : ""}<br/>` +
            `PM2.5: ${s.pm25 != null ? s.pm25.toFixed(1) : "—"} µg/m³<br/>` +
            `Updated ${new Date(s.fetched_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}`
        );

        markersRef.current.push(marker);
      });
    });

    return () => {
      cancelled = true;
    };
  }, [sensors]);

  // Tear the map down completely on unmount (e.g. fast refresh / nav away)
  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ height: 320, borderRadius: "var(--radius-md)", overflow: "hidden" }}
      aria-label="Map of live portable air-quality sensors"
    />
  );
}
