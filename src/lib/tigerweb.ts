const TIGERWEB_BASE =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer";

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Queries a TIGERweb (U.S. Census Bureau) MapServer layer for features
 * intersecting a bounding box and returns the result as GeoJSON — same
 * "proxy a free public geo API server-side" idiom as lib/openmeteo.ts uses
 * for the wind/AQI grids, just for boundary polygons (congressional
 * districts, counties, ZCTAs) instead of point samples. No API key, no
 * rate limit beyond Census's own fair-use service.
 *
 * `maxAllowableOffset` asks the server to simplify geometry to roughly that
 * many degrees of tolerance. This matters a lot at small map scales: a
 * full-resolution nationwide county or ZCTA layer is tens of megabytes.
 * Scaling it to the bbox's own span means it loosens automatically as the
 * caller zooms out and tightens back up at street level, without either
 * route needing to know about zoom levels directly.
 */
export async function queryTigerwebGeoJSON(
  layerId: number,
  bbox: Bbox,
  opts: { where?: string; outFields?: string } = {}
): Promise<unknown> {
  const span = Math.max(bbox.north - bbox.south, bbox.east - bbox.west);
  const maxAllowableOffset = Math.max(0.0001, span / 1500);

  const params = new URLSearchParams({
    geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: opts.outFields ?? "*",
    maxAllowableOffset: String(maxAllowableOffset),
    f: "geojson",
  });
  if (opts.where) params.set("where", opts.where);

  const res = await fetch(`${TIGERWEB_BASE}/${layerId}/query?${params.toString()}`, {
    // Boundary lines barely change year to year; cache a day server-side.
    next: { revalidate: 86400 },
  });
  if (!res.ok) {
    throw new Error(`TIGERweb HTTP ${res.status}`);
  }
  return res.json();
}
