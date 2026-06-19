/**
 * aqs.ts
 *
 * Client for the EPA Air Quality System (AQS) API v2.
 * Docs: https://aqs.epa.gov/aqsweb/documents/data_api.html
 *
 * AQS holds the deep, speciated pollutant data — PAMS VOCs, carbonyls, NOy,
 * etc. — that AirNow doesn't expose (see lib/airnow.ts for the live AQI
 * feed). AQS is explicitly NOT real-time: EPA states data can take 6+ months
 * to be QA'd and land here. Everything built on top of this client should be
 * presented as historical/archival, not live.
 *
 * Free, instant signup (no approval wait, no password):
 *   GET https://aqs.epa.gov/data/api/signup?email=you@example.com
 * EPA emails a confirmation link, then the key follows. Once you have it,
 * set in .env.local:
 *   AQS_API_EMAIL=you@example.com
 *   AQS_API_KEY=yourkeyhere
 */

const AQS_BASE = "https://aqs.epa.gov/data/api";

// Shelby Farms Park — Memphis/Shelby County NCore + PAMS monitoring site.
export const SHELBY_FARMS_SITE = {
  state: "47", // Tennessee
  county: "157", // Shelby County
  site: "0075", // Shelby Farms Park
};

interface AqsHeaderEntry {
  status: string;
  request_time?: string;
  url?: string;
  rows?: number;
  error?: string;
}

interface AqsRawResponse<T> {
  Header: AqsHeaderEntry[];
  Data: T[];
}

function credsOrNull(): { email: string; key: string } | null {
  const email = process.env.AQS_API_EMAIL;
  const key = process.env.AQS_API_KEY;
  if (!email || !key) {
    console.warn("[aqs] AQS_API_EMAIL/AQS_API_KEY not set — skipping AQS fetch");
    return null;
  }
  return { email, key };
}

async function aqsFetch<T>(
  path: string,
  params: Record<string, string>
): Promise<T[] | null> {
  const creds = credsOrNull();
  if (!creds) return null;

  const qs = new URLSearchParams({ email: creds.email, key: creds.key, ...params });
  const url = `${AQS_BASE}/${path}?${qs.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, {
      // This data is historical and changes at most quarterly — cache a full day.
      next: { revalidate: 86400 },
    });
  } catch (err) {
    console.error(`[aqs] Network error for ${path}:`, err);
    return null;
  }

  if (!res.ok) {
    console.error(`[aqs] HTTP ${res.status} for ${path}`);
    return null;
  }

  const body: AqsRawResponse<T> = await res.json();
  const status = body.Header?.[0]?.status;
  if (status && status !== "Success") {
    console.error(
      `[aqs] ${path} returned status "${status}"${
        body.Header?.[0]?.error ? `: ${body.Header[0].error}` : ""
      }`
    );
    return null;
  }

  return body.Data ?? [];
}

// ─── Discovery endpoints ───────────────────────────────────────────────────
// Use these to confirm parameter codes / site coverage before hardcoding
// anything that feeds the dashboard — AQS has thousands of 5-digit param
// codes and guessing from memory risks silently wrong data.

export interface AqsParameter {
  code: string;
  value_represented: string;
}

/** All parameter codes in a parameter class, e.g. pc="PAMS" or pc="CARBONYLS". */
export function listParametersByClass(pc: string) {
  return aqsFetch<AqsParameter>("list/parametersByClass", { pc });
}

export interface AqsSite {
  code: string;
  value_represented: string;
}

/** All AQS site numbers in a county — used to corroborate the Shelby Farms site number. */
export function listSitesByCounty(
  state: string = SHELBY_FARMS_SITE.state,
  county: string = SHELBY_FARMS_SITE.county
) {
  return aqsFetch<AqsSite>("list/sitesByCounty", { state, county });
}

export interface AqsMonitor {
  state_code: string;
  county_code: string;
  site_number: string;
  parameter_code: string;
  parameter_name: string;
  open_date: string;
  close_date: string | null;
  monitoring_agency: string;
}

/**
 * Monitors actually operating at the Shelby Farms site for a given parameter
 * + date range — confirms what's really measured there (not every PAMS
 * parameter is monitored at every PAMS site).
 */
export function monitorsBySite(param: string, bdate: string, edate: string) {
  return aqsFetch<AqsMonitor>("monitors/bySite", {
    param,
    bdate,
    edate,
    ...SHELBY_FARMS_SITE,
  });
}

// ─── Data endpoints ─────────────────────────────────────────────────────────

export interface AqsDailySummary {
  state_code: string;
  county_code: string;
  site_number: string;
  parameter_code: string;
  parameter: string;
  date_local: string; // YYYY-MM-DD
  units_of_measure: string;
  arithmetic_mean: number | null;
  maximum_value: number | null;
  validity_indicator: string;
  method: string | null;
}

/**
 * Daily summary data for the Shelby Farms site — the aggregation level we
 * show on the dashboard's historical PAMS view.
 *
 * `params` accepts up to 5 comma-joinable AQS parameter codes per call.
 * `bdate`/`edate` are YYYYMMDD and AQS requires them to fall in the same year.
 */
export function dailySummaryBySite(params: string[], bdate: string, edate: string) {
  return aqsFetch<AqsDailySummary>("dailyData/bySite", {
    param: params.join(","),
    bdate,
    edate,
    ...SHELBY_FARMS_SITE,
  });
}

export interface AqsSampleData {
  state_code: string;
  county_code: string;
  site_number: string;
  parameter_code: string;
  parameter: string;
  date_local: string;
  time_local: string;
  sample_measurement: number | null;
  units_of_measure: string;
  validity_indicator: string;
}

/** Finest-grain (typically hourly) sample data, if ever needed beyond daily summaries. */
export function sampleDataBySite(params: string[], bdate: string, edate: string) {
  return aqsFetch<AqsSampleData>("sampleData/bySite", {
    param: params.join(","),
    bdate,
    edate,
    ...SHELBY_FARMS_SITE,
  });
}

// ─── High-level: self-discovering PAMS summary ─────────────────────────────
// Deliberately does NOT hardcode any 5-digit PAMS parameter codes. Instead it
// pulls the canonical PAMS parameter list straight from AQS, queries daily
// summaries for every one of those codes at Shelby Farms, and only keeps the
// codes that actually come back with real rows. Wrong/unmonitored candidate
// codes simply produce zero rows and are dropped — no guessed or
// mis-mapped pollutant data can reach the dashboard.

export interface PamsPollutant {
  parameter: string;
  parameter_code: string;
  date_local: string; // date of the most recent validated reading — NOT "today"
  arithmetic_mean: number | null;
  maximum_value: number | null;
  units_of_measure: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Fetches the most recent validated daily-summary reading for every PAMS
 *  parameter reported at Shelby Farms within a single calendar year. */
async function fetchPamsSummaryForYear(year: number): Promise<AqsDailySummary[]> {
  const bdate = `${year}0101`;
  const edate = `${year}1231`;

  const allParams = await listParametersByClass("PAMS");
  if (!allParams || allParams.length === 0) return [];

  // AQS allows up to 5 parameter codes per call.
  const codeChunks = chunk(allParams.map((p) => p.code), 5);

  // Cap concurrency so we're a reasonable citizen of EPA's public API.
  const CONCURRENCY = 6;
  const allRows: AqsDailySummary[] = [];
  for (let i = 0; i < codeChunks.length; i += CONCURRENCY) {
    const batch = codeChunks.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((codes) => dailySummaryBySite(codes, bdate, edate))
    );
    for (const rows of batchResults) {
      if (rows) allRows.push(...rows);
    }
  }
  return allRows;
}

/**
 * Returns the latest validated reading for every PAMS parameter actually
 * reported at Shelby Farms, checking both the most recently completed
 * calendar year and the current year (PAMS reporting can lag 6+ months, so
 * the current year is often empty — checking both is cheap insurance).
 *
 * Returns `null` if AQS isn't configured (no API key yet), or an array
 * (possibly empty, if no PAMS data has been reported yet) otherwise.
 */
export async function fetchPamsSummaryRecent(): Promise<PamsPollutant[] | null> {
  if (!credsOrNull()) return null;

  const currentYear = new Date().getFullYear();
  const [priorYearRows, currentYearRows] = await Promise.all([
    fetchPamsSummaryForYear(currentYear - 1),
    fetchPamsSummaryForYear(currentYear),
  ]);

  const latestByParam = new Map<string, AqsDailySummary>();
  for (const row of [...priorYearRows, ...currentYearRows]) {
    if (row.validity_indicator !== "Y") continue;
    const existing = latestByParam.get(row.parameter_code);
    if (!existing || row.date_local > existing.date_local) {
      latestByParam.set(row.parameter_code, row);
    }
  }

  return Array.from(latestByParam.values())
    .map((row) => ({
      parameter: row.parameter,
      parameter_code: row.parameter_code,
      date_local: row.date_local,
      arithmetic_mean: row.arithmetic_mean,
      maximum_value: row.maximum_value,
      units_of_measure: row.units_of_measure,
    }))
    .sort((a, b) => a.parameter.localeCompare(b.parameter));
}
