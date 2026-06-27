import JSZip from "jszip";

// MATA's own published GTFS static feed — linked from
// matatransit.com/how-do-you-travel/route-schedules/gtfs-feed. This is the
// authoritative source for real route geometry (street-by-street shapes),
// unlike HIGHWAYS in highways.ts which is hand-plotted because no live
// highway-geometry source was reachable.
const MATA_GTFS_URL = "https://gtfs.mata.cadavl.com/MATA/GTFS/GTFS_MATA.zip";

// GTFS route_type 3 = "Bus" per the spec. MATA's feed also bundles its
// trolley routes (route_type 0, streetcar/light rail) under the same feed —
// excluded here since the ask is specifically bus routes.
const BUS_ROUTE_TYPE = "3";

// Cap shapes kept per route — most MATA routes have 2 (outbound + inbound),
// occasionally a few more for branch variants. This just guards against one
// mis-tagged trip silently ballooning the payload.
const MAX_SHAPES_PER_ROUTE = 6;

/**
 * Minimal RFC4180-ish CSV parser — good enough for GTFS's well-formed text
 * files. Handles quoted fields (including escaped "" and embedded commas),
 * which a naive String.split(",") would mangle on fields like some
 * route_long_name values.
 */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const splitLine = (line: string): string[] => {
    const fields: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        fields.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    fields.push(cur);
    return fields.map((f) => f.trim());
  };

  const header = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitLine(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = values[i] ?? "";
    });
    return row;
  });
}

interface ShapePoint {
  seq: number;
  lng: number;
  lat: number;
}

/**
 * Downloads + unzips MATA's GTFS feed once, returning a reader function for
 * any member file's text content. Shared by fetchMataRoutesGeoJSON and
 * fetchMataStopsGeoJSON below so both stay byte-for-byte in sync (same feed
 * snapshot) without duplicating the fetch/unzip boilerplate. Next's fetch
 * Data Cache (next: { revalidate: 86400 }) means a second call within the
 * revalidate window reuses the cached response bytes rather than
 * re-downloading, even though each is a separate serverless invocation.
 */
async function loadMataGtfsZip(): Promise<(name: string) => Promise<string>> {
  const res = await fetch(MATA_GTFS_URL, { next: { revalidate: 86400 } });
  if (!res.ok) {
    throw new Error(`MATA GTFS HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  return async (name: string): Promise<string> => {
    const file = zip.file(name);
    if (!file) throw new Error(`GTFS zip missing ${name}`);
    return file.async("string");
  };
}

/**
 * Fetches MATA's GTFS zip, unzips it in memory, and converts
 * routes.txt + trips.txt + shapes.txt into a GeoJSON FeatureCollection of
 * LineStrings — one feature per unique route+shape (typically outbound and
 * inbound per route). Each feature's properties carry route_short_name,
 * route_long_name, and color (from GTFS's own route_color, falling back to
 * a default transit blue when a route doesn't define one).
 */
export async function fetchMataRoutesGeoJSON(): Promise<{
  type: "FeatureCollection";
  features: GeoJSON.Feature[];
}> {
  const readFile = await loadMataGtfsZip();

  const [routesTxt, tripsTxt, shapesTxt] = await Promise.all([
    readFile("routes.txt"),
    readFile("trips.txt"),
    readFile("shapes.txt"),
  ]);

  const routes = parseCsv(routesTxt);
  const trips = parseCsv(tripsTxt);
  const shapeRows = parseCsv(shapesTxt);

  // shape_id -> ordered list of points (sorted below once fully collected).
  const shapePoints = new Map<string, ShapePoint[]>();
  for (const row of shapeRows) {
    const id = row.shape_id;
    if (!id) continue;
    const lat = parseFloat(row.shape_pt_lat);
    const lng = parseFloat(row.shape_pt_lon);
    const seq = parseInt(row.shape_pt_sequence, 10);
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;
    const arr = shapePoints.get(id) ?? [];
    arr.push({ seq, lng, lat });
    shapePoints.set(id, arr);
  }

  // route_id -> set of distinct shape_ids actually used by its trips.
  const routeToShapes = new Map<string, Set<string>>();
  for (const trip of trips) {
    if (!trip.route_id || !trip.shape_id) continue;
    const set = routeToShapes.get(trip.route_id) ?? new Set<string>();
    set.add(trip.shape_id);
    routeToShapes.set(trip.route_id, set);
  }

  const routeById = new Map(routes.map((r) => [r.route_id, r]));

  const features: GeoJSON.Feature[] = [];
  // Array.from(...) on these two iterations (rather than bare for-of over
  // the Map/Set directly) sidesteps a downlevelIteration type error under
  // this project's tsconfig (no explicit `target`, so TS defaults to one
  // that doesn't allow for-of over Map/Set without it).
  for (const [routeId, shapeIds] of Array.from(routeToShapes)) {
    const route = routeById.get(routeId);
    if (!route || route.route_type !== BUS_ROUTE_TYPE) continue;

    const color =
      route.route_color && /^[0-9a-fA-F]{6}$/.test(route.route_color)
        ? `#${route.route_color}`
        : "#3A8FCE";

    let count = 0;
    for (const shapeId of Array.from(shapeIds)) {
      if (count >= MAX_SHAPES_PER_ROUTE) break;
      const pts = shapePoints.get(shapeId);
      if (!pts || pts.length < 2) continue;
      pts.sort((a, b) => a.seq - b.seq);
      features.push({
        type: "Feature",
        properties: {
          route_id: routeId,
          route_short_name: route.route_short_name || "",
          route_long_name: route.route_long_name || "",
          color,
        },
        geometry: {
          type: "LineString",
          coordinates: pts.map((p) => [p.lng, p.lat]),
        },
      });
      count++;
    }
  }

  return { type: "FeatureCollection", features };
}

/**
 * Fetches MATA's GTFS zip and converts stops.txt into a GeoJSON
 * FeatureCollection of Points — one per official stop that's actually
 * served by at least one bus trip (route_type 3), determined by walking
 * stop_times.txt -> trips.txt -> routes.txt. Trolley-only stops (route_type
 * 0) are excluded, mirroring the same BUS_ROUTE_TYPE filter
 * fetchMataRoutesGeoJSON applies to route lines, so the stop markers always
 * line up with whichever routes are drawn. Each feature's properties carry
 * stop_name and, when present, the rider-facing stop_code (the short number
 * printed on the physical stop sign/used for SMS arrival lookups) as a
 * secondary "designation" alongside the name.
 */
export async function fetchMataStopsGeoJSON(): Promise<{
  type: "FeatureCollection";
  features: GeoJSON.Feature[];
}> {
  const readFile = await loadMataGtfsZip();

  const [routesTxt, tripsTxt, stopTimesTxt, stopsTxt] = await Promise.all([
    readFile("routes.txt"),
    readFile("trips.txt"),
    readFile("stop_times.txt"),
    readFile("stops.txt"),
  ]);

  const routes = parseCsv(routesTxt);
  const trips = parseCsv(tripsTxt);
  const stopTimes = parseCsv(stopTimesTxt);
  const stops = parseCsv(stopsTxt);

  const routeById = new Map(routes.map((r) => [r.route_id, r]));

  // trip_id -> included only when that trip belongs to a bus route.
  const busTripIds = new Set<string>();
  for (const trip of trips) {
    if (!trip.trip_id || !trip.route_id) continue;
    const route = routeById.get(trip.route_id);
    if (route?.route_type === BUS_ROUTE_TYPE) busTripIds.add(trip.trip_id);
  }

  // stop_id -> included once any bus trip's stop_times rows reference it.
  const busStopIds = new Set<string>();
  for (const st of stopTimes) {
    if (st.trip_id && st.stop_id && busTripIds.has(st.trip_id)) {
      busStopIds.add(st.stop_id);
    }
  }

  const features: GeoJSON.Feature[] = [];
  for (const stop of stops) {
    if (!stop.stop_id || !busStopIds.has(stop.stop_id)) continue;
    const lat = parseFloat(stop.stop_lat);
    const lng = parseFloat(stop.stop_lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;
    features.push({
      type: "Feature",
      properties: {
        stop_id: stop.stop_id,
        name: stop.stop_name || "",
        code: stop.stop_code || "",
      },
      geometry: { type: "Point", coordinates: [lng, lat] },
    });
  }

  return { type: "FeatureCollection", features };
}
