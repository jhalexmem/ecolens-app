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
  const res = await fetch(MATA_GTFS_URL, { next: { revalidate: 86400 } });
  if (!res.ok) {
    throw new Error(`MATA GTFS HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const readFile = async (name: string): Promise<string> => {
    const file = zip.file(name);
    if (!file) throw new Error(`GTFS zip missing ${name}`);
    return file.async("string");
  };

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
