// Static, hand-built dataset for the "major facilities" overlay: xAI data
// center campuses, the TVA Allen power plant, xAI-financed MLGW/TVA
// substations, and the xAI water-recycling plant under construction.
//
// Why static instead of fetched: Overpass, Nominatim, and even raw GitHub
// GeoJSON mirrors are all unreachable from this app's sandbox/build
// environment, so there is no live geocoding or building-footprint source
// available. Every coordinate and polygon below was instead hand-derived
// from public records gathered via web search (county/Zillow listing data,
// Wikipedia, local news coverage) — see `sourceNote` on each facility.
//
// Accuracy: centers marked "precise" come from a sourced street address or
// an embedded satellite-map coordinate. Centers marked "approximate" are
// triangulated from nearby parcels/landmarks. Footprint and property-line
// polygons are NOT traced building/parcel outlines (no Overpass/GIS access)
// — they are simple rectangles sized from each facility's known building
// square footage or parcel acreage, centered on the best-available point,
// per the project owner's "as best as you can tell" instruction.

export type FacilityCategory =
  | "data_center"
  | "power_plant"
  | "substation"
  | "water_treatment";

export interface Facility {
  id: string;
  /** Short label shown on the map (tooltip + divIcon). */
  shortLabel: string;
  /** Full name shown in the popup header. */
  name: string;
  category: FacilityCategory;
  address: string;
  /** [lat, lng] */
  center: [number, number];
  centerAccuracy: "precise" | "approximate";
  /** Footprint rectangle size in meters: [width (E-W), height (N-S)]. */
  footprintSize: [number, number];
  /** Property/parcel rectangle size in meters: [width (E-W), height (N-S)]. */
  propertySize: [number, number];
  details: string[];
  sourceNote: string;
}

const METERS_PER_DEG_LAT = 111_320;

function metersPerDegLng(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

/** Build a closed rectangular polygon ring (5 points, last = first) around a
 * center point, sized in meters. Axis-aligned (no rotation) — a deliberate
 * simplification given no traced footprint/parcel data is available. */
export function rectAround(
  center: [number, number],
  widthMeters: number,
  heightMeters: number
): [number, number][] {
  const [lat, lng] = center;
  const dLat = heightMeters / 2 / METERS_PER_DEG_LAT;
  const dLng = widthMeters / 2 / metersPerDegLng(lat);
  return [
    [lat - dLat, lng - dLng],
    [lat - dLat, lng + dLng],
    [lat + dLat, lng + dLng],
    [lat + dLat, lng - dLng],
    [lat - dLat, lng - dLng],
  ];
}

export const FACILITIES: Facility[] = [
  {
    id: "colossus-1",
    shortLabel: "Colossus I",
    name: "Colossus I — xAI Data Center",
    category: "data_center",
    address: "3231 Paul R. Lowry Rd, Memphis, TN 38109",
    center: [35.0658, -90.1516],
    centerAccuracy: "approximate",
    footprintSize: [320, 230],
    propertySize: [700, 1070],
    details: [
      "Former Electrolux manufacturing plant, ~785,000 sq ft, repurposed by xAI as its first Memphis AI training campus (\"Colossus\").",
      "Brought online starting mid-2024; powered in part by on-site gas turbines plus a dedicated MLGW/TVA substation.",
    ],
    sourceNote:
      "Address and building history from public reporting; center triangulated from nearby Frank C. Pidgeon Industrial Park and T.E. Maxson WWTP coordinates (no precise parcel geocode reachable).",
  },
  {
    id: "colossus-2",
    shortLabel: "Colossus II",
    name: "Colossus II — xAI Data Center",
    category: "data_center",
    address: "5420 Tulane Rd, Memphis, TN 38109",
    center: [34.99814224243164, -90.03499603271484],
    centerAccuracy: "precise",
    footprintSize: [340, 276],
    propertySize: [575, 555],
    details: [
      "~1,009,363 sq ft building on a 78.55-acre parcel; sold for $72,929,227 in March 2025.",
      "Built 2023; expanded by xAI into a second large-scale AI training data center adjacent to Colossus I's home corridor.",
    ],
    sourceNote:
      "Center geocoded precisely from a Zillow-embedded satellite static-map coordinate for this parcel; building/lot facts from the same listing record.",
  },
  {
    id: "macrohardrr",
    shortLabel: "MACROHARDRR",
    name: "MACROHARDRR (xAI data center)",
    category: "data_center",
    address: "2400 Stateline Rd W, Southaven, MS 38671",
    center: [34.9933967590332, -90.03429412841797],
    centerAccuracy: "precise",
    footprintSize: [300, 251],
    propertySize: [460, 420],
    details: [
      "Publicly known by its actual site name \"MACROHARDRR\" — informally referred to by some press as \"Colossus III,\" but not an official xAI \"Colossus\" designation.",
      "~810,225 sq ft building on a 47.71-acre parcel, just across the Mississippi state line from the Colossus II campus.",
    ],
    sourceNote:
      "Center geocoded precisely from a Zillow-embedded satellite static-map coordinate for this parcel; named per the operator's own public site name rather than press shorthand, per project owner's instruction.",
  },
  {
    id: "duke-energy-site",
    shortLabel: "Former Duke Energy Site",
    name: "Former Duke Energy Site (xAI-affiliated)",
    category: "power_plant",
    address: "2875 Stanton Rd S, Southaven, MS 38671",
    center: [34.987, -90.038],
    centerAccuracy: "approximate",
    footprintSize: [150, 100],
    propertySize: [579, 762],
    details: [
      "Former Duke Energy natural-gas electrical generating plant site; 114.37-acre parcel (legal description: Tulane-Stanton Industrial S/D Lot 2).",
      "Acquired by MZX Tech LLC — a Wyoming entity headquartered at the same Palo Alto, CA address xAI uses — confirming xAI affiliation. Labeled here by its actual current status, not as a numbered \"Colossus\" facility.",
    ],
    sourceNote:
      "Parcel facts and legal description from a LoopNet listing; ownership/xAI-affiliation from local news coverage of the MZX Tech LLC purchase. Center triangulated from the subdivision's road frontage (Stanton Rd / Tulane Rd) — no precise parcel geocode reachable; structure footprint is a rough placeholder since on-site buildings are partially demolished/redeveloping.",
  },
  {
    id: "tva-allen",
    shortLabel: "TVA Allen Plant",
    name: "TVA Allen Combined Cycle Plant",
    category: "power_plant",
    address: "2480 Hennington Ave, Memphis, TN 38109",
    center: [35.06694, -90.14444],
    centerAccuracy: "precise",
    footprintSize: [260, 180],
    propertySize: [1100, 1100],
    details: [
      "1,100 MW natural-gas combined-cycle power plant operated by the Tennessee Valley Authority, replacing the retired coal-fired Allen Fossil Plant on the same reservation.",
      "Supplies a significant share of the grid capacity feeding the southwest-Memphis industrial corridor, including the nearby xAI campuses.",
    ],
    sourceNote:
      "Coordinates from Wikipedia's TVA Allen Plant entry (35°04′01″N 90°08′40″W). Footprint/property sizing approximated from typical combined-cycle plant scale — no traced GIS boundary reachable.",
  },
  {
    id: "mlgw-substation-colossus1",
    shortLabel: "MLGW Substation",
    name: "MLGW/TVA Substation (Colossus I)",
    category: "substation",
    address: "Paul R. Lowry Rd, Memphis, TN 38109 (co-located with Colossus I)",
    center: [35.065, -90.15],
    centerAccuracy: "approximate",
    footprintSize: [150, 100],
    propertySize: [180, 180],
    details: [
      "Substation financed/built to deliver an initial ~150 MW of grid power directly to the Colossus I campus.",
      "No standalone street address was found for this substation in public records — shown here co-located with the Colossus I campus it serves.",
    ],
    sourceNote:
      "Existence and approximate siting from public reporting on xAI's MLGW power-delivery arrangements; exact substation footprint/fence-line not publicly available, so position and size are best-effort estimates.",
  },
  {
    id: "mlgw-substation-colossus2",
    shortLabel: "MLGW/TVA Substation",
    name: "MLGW/TVA Substation (Colossus II)",
    category: "substation",
    address: "Tulane Rd, Memphis, TN 38109 (west of Colossus II)",
    center: [34.998, -90.039],
    centerAccuracy: "approximate",
    footprintSize: [150, 100],
    propertySize: [180, 180],
    details: [
      "A second, larger MLGW/TVA substation built just west of the Colossus II/Tulane Rd campus to supply its expanded power needs.",
      "No standalone street address was found for this substation in public records — shown here just west of the Colossus II campus it serves.",
    ],
    sourceNote:
      "Existence and approximate siting from public reporting on xAI's MLGW power-delivery arrangements; exact substation footprint/fence-line not publicly available, so position and size are best-effort estimates.",
  },
  {
    id: "xai-water-recycling",
    shortLabel: "Water Recycling Plant",
    name: "xAI Water Recycling Plant (under construction)",
    category: "water_treatment",
    address: "Paul R. Lowry Rd corridor, Memphis, TN 38109 (near T.E. Maxson WWTP)",
    center: [35.063, -90.155],
    centerAccuracy: "approximate",
    footprintSize: [120, 90],
    propertySize: [205, 200],
    details: [
      "~$80M ceramic-membrane bioreactor water-recycling facility being built by xAI to treat wastewater for cooling/process use at the Colossus campuses, reducing draw on municipal supply.",
      "Sited near the City of Memphis's T.E. Maxson wastewater treatment plant; targeted to be operational by end of 2026.",
    ],
    sourceNote:
      "Project scope, cost, and siting context from public reporting; exact construction-site coordinates not publicly available, so position is approximated near the Maxson WWTP/Colossus I corridor it serves.",
  },
];

export const FACILITY_CATEGORY_LABELS: Record<FacilityCategory, string> = {
  data_center: "Data center",
  power_plant: "Power plant",
  substation: "Substation",
  water_treatment: "Water treatment",
};

export const FACILITY_CATEGORY_ICONS: Record<FacilityCategory, string> = {
  data_center: "\u{1F5A5}️", // 🖥️
  power_plant: "⚡", // ⚡
  substation: "\u{1F50C}", // 🔌
  water_treatment: "\u{1F4A7}", // 💧
};
