// Simplified interstate-highway centerlines for the Memphis metro area, used
// to visually highlight the major interstates (I-40, I-55, I-240, I-69) on
// top of the base map tiles.
//
// Why hand-built: Overpass (OSM) is unreachable from this app's sandbox/
// build environment, and a public highway GeoJSON mirror on
// raw.githubusercontent.com is also unreachable (confirmed via direct
// curl — connection refused/blocked). With no live highway-geometry source
// available, these polylines are hand-plotted waypoints based on general
// knowledge of the Memphis interstate layout — a deliberate, best-effort
// simplification (5-9 points per route) rather than a traced/OSM-accurate
// alignment. Good enough to visually highlight "where the interstate runs"
// at the zoom levels this app is used at; not suitable for turn-by-turn or
// surveying use.

export interface HighwayRoute {
  id: string;
  label: string;
  /** [lat, lng] waypoints, ordered along the route through the metro area. */
  path: [number, number][];
  /** Where to place the route-shield label marker(s), as indices into `path`. */
  labelAt: number[];
}

export const HIGHWAYS: HighwayRoute[] = [
  {
    id: "i40",
    label: "I-40",
    path: [
      [35.1508, -90.0735], // West Memphis, AR approach
      [35.1503, -90.0635], // Hernando de Soto Bridge
      [35.1497, -90.0500], // Downtown Memphis riverfront
      [35.1493, -90.0440], // I-40/I-69 split, Danny Thomas Blvd
      [35.1600, -90.0050], // North Memphis / Highland Heights
      [35.1672, -89.9550], // I-40/I-240 north interchange
      [35.1660, -89.8700], // Memphis/Bartlett east side
      [35.1645, -89.8100], // toward Jackson, TN
    ],
    labelAt: [2, 6],
  },
  {
    id: "i55",
    label: "I-55",
    path: [
      [35.1345, -90.0700], // Arkansas approach
      [35.1330, -90.0590], // Memphis-Arkansas Bridge
      [35.1190, -90.0560], // Downtown south / South Bluffs
      [35.1000, -90.0470], // Near I-55/I-240 interchange
      [35.0450, -90.0350], // Whitehaven
      [34.9960, -90.0250], // Near TN/MS state line
      [34.9500, -90.0120], // Into Mississippi
    ],
    labelAt: [2, 5],
  },
  {
    id: "i240",
    label: "I-240",
    path: [
      [35.1672, -89.9550], // North junction with I-40
      [35.1450, -89.9100], // East Memphis (Sycamore View/Summer)
      [35.1100, -89.8950], // Mt. Moriah / Perkins
      [35.0750, -89.9200], // Near Memphis International Airport
      [35.0450, -89.9700], // Getwell/Winchester area
      [35.0280, -90.0150], // South junction with I-55 (near Graceland)
    ],
    labelAt: [1, 4],
  },
  {
    id: "i69",
    label: "I-69",
    path: [
      [35.1493, -90.0440], // Shared with I-40 downtown (split point)
      [35.1190, -90.0560], // Shared alignment with I-55 south
      [35.0450, -90.0350], // Whitehaven (concurrent with I-55)
      [34.9960, -90.0250], // Near state line
      [34.9300, -90.0050], // Splits SW toward Hernando, MS
      [34.8700, -89.9700], // Continuing toward Hernando/Tunica
    ],
    labelAt: [4],
  },
];
