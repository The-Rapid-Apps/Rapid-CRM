import { AD_SURFACE_TYPES, type PivotDimensionKey } from "./traffic-sources.shared";

/**
 * JS twins of the SQL dimension expressions in traffic-sources.shared.ts
 * (`eventParam`/`pageLocationParam`/`searchTermParam`/`sourceParam`),
 * operating on a locally-mirrored TrafficEventFact row instead of building a
 * BigQuery column expression — see traffic-events-sync.server.ts and the
 * plan for why raw events are mirrored locally rather than a precomputed
 * rollup. Verified byte-identical against real production page_location/
 * page_referrer/traffic_source values (2026-08-16) — see
 * tests/traffic-dimensions-local.test.ts. A mismatch here is a silently
 * wrong dimension value in the Traffic report, not a crash, so any change to
 * these functions must be re-verified against real strings, not reasoned
 * about in the abstract.
 */

export interface DimensionRow {
  pageLocation: string | null;
  pageReferrer: string | null;
  campaign: string | null;
  trafficSourceName: string | null;
  trafficSourceMedium: string | null;
  trafficSourceSource: string | null;
  language: string | null;
  country: string | null;
}

const NOT_SET = "(not set)";

/**
 * Mirrors BigQuery's `REGEXP_EXTRACT(str, r"{param}=([^&]+)")` exactly,
 * including its imprecision (no anchor to a `?`/`&` boundary before the key —
 * it will match "param=" as a bare substring, same as the SQL). Do not
 * "improve" this into a real query-string parser; it must match the live SQL
 * behavior bug-for-bug, not correct it.
 */
function extractQueryParam(pageLocation: string | null, param: string): string | null {
  if (!pageLocation) return null;
  const match = new RegExp(`${param}=([^&]+)`).exec(pageLocation);
  return match ? match[1] : null;
}

/** Mirrors BigQuery's `NET.HOST(url)`: the host (with port, if present) of a
 * valid URL, or NULL for anything that doesn't parse as one. */
function netHost(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).host;
    return host || null;
  } catch {
    return null;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

/**
 * Mirrors urlDecoded() in traffic-sources.shared.ts: the same split into
 * `%XX` escapes and literal runs, and the same fallback to the raw text when
 * the bytes aren't valid UTF-8 (`fatal` ↔ `SAFE_CAST`; `ignoreBOM` because
 * BigQuery keeps a leading BOM). Not `decodeURIComponent`, which throws on a
 * lone "%" that the SQL decodes as itself.
 */
function urlDecode(value: string): string {
  const bytes: number[] = [];
  for (const part of value.match(/%[0-9A-Fa-f]{2}|[^%]+|%/g) ?? []) {
    if (part.length === 3 && part.startsWith("%")) {
      bytes.push(parseInt(part.slice(1), 16));
    } else {
      bytes.push(...utf8Encoder.encode(part));
    }
  }
  try {
    return utf8.decode(new Uint8Array(bytes));
  } catch {
    return value;
  }
}

/** Mirrors searchTermParam() in traffic-sources.shared.ts. */
function resolveSearchTerm(pageLocation: string | null): string | null {
  const surface = extractQueryParam(pageLocation, "surface_type");
  if (surface !== "search" && surface !== "search_ad") return null;
  const detail = extractQueryParam(pageLocation, "surface_detail");
  if (detail === null) return null;
  return trimLikeBigQuery(urlDecode(detail.replace(/\+/g, " "))).toLowerCase() || null;
}

/** JS's `trim()` with BigQuery TRIM's two differences, both measured against
 * BigQuery: it keeps a byte-order mark, and it strips U+0085 (next line). */
function trimLikeBigQuery(value: string): string {
  return value.replace(/^(?:[^\S\uFEFF]|\u0085)+|(?:[^\S\uFEFF]|\u0085)+$/g, "");
}

/** Mirrors languageParam() in traffic-sources.shared.ts. */
function resolveLanguage(pageLocation: string | null): string | null {
  if (pageLocation === null) return null;
  return /[?&]locale=([^&#]+)/.exec(pageLocation)?.[1] ?? "en";
}

/** Mirrors mediumParam() in traffic-sources.shared.ts. */
function resolveMedium(
  pageLocation: string | null,
  trafficSourceMedium: string | null,
): string | null {
  if (pageLocation === null) return null;
  const utmMedium = extractQueryParam(pageLocation, "utm_medium");
  if (utmMedium !== null) return utmMedium;
  const surface = extractQueryParam(pageLocation, "surface_type");
  if (surface !== null) {
    return (AD_SURFACE_TYPES as readonly string[]).includes(surface) ? "cpc" : "organic";
  }
  if (
    trafficSourceMedium !== null &&
    trafficSourceMedium !== "(none)" &&
    trafficSourceMedium !== "(not set)"
  ) {
    return trafficSourceMedium;
  }
  return "organic";
}

/** Mirrors sourceParam() in traffic-sources.shared.ts. */
function resolveSource(
  trafficSourceSource: string | null,
  pageReferrer: string | null,
): string | null {
  if (trafficSourceSource === "(direct)") {
    const host = netHost(pageReferrer);
    if (host) return host;
  }
  return trafficSourceSource;
}

/**
 * One dimension's raw (pre-COALESCE) value for `row` — `null`/`undefined`
 * means "not present," matching what the SQL column expression would
 * evaluate to before `COALESCE(..., "(not set)")` is applied at the call
 * site (see resolveDimensionValue below for that step).
 */
function rawDimensionValue(key: PivotDimensionKey, row: DimensionRow): string | null {
  switch (key) {
    case "source":
      return resolveSource(row.trafficSourceSource, row.pageReferrer);
    case "medium":
      return resolveMedium(row.pageLocation, row.trafficSourceMedium);
    case "search_term":
      return resolveSearchTerm(row.pageLocation);
    case "affiliate":
      return extractQueryParam(row.pageLocation, "mref");
    case "referrer_site":
      // Host, not the raw URL — mirrors NET.HOST() in the SQL expression.
      return netHost(row.pageReferrer);
    case "traffic_source_name":
      return row.trafficSourceName;
    case "campaign":
      // utm_campaign off the URL, not the stored `campaign` column — see the
      // campaign entry in traffic-sources.shared.ts's PIVOT_DIMENSIONS. Keeps
      // this path identical to the BigQuery one, so no mirror re-sync needed.
      return extractQueryParam(row.pageLocation, "utm_campaign");
    case "surface_type":
      return extractQueryParam(row.pageLocation, "surface_type");
    case "surface_detail":
      return extractQueryParam(row.pageLocation, "surface_detail");
    case "surface_inter_position":
      return extractQueryParam(row.pageLocation, "surface_inter_position");
    case "surface_intra_position":
      return extractQueryParam(row.pageLocation, "surface_intra_position");
    case "language":
      return resolveLanguage(row.pageLocation);
    case "country":
      return row.country;
    default: {
      const exhaustive: never = key;
      throw new Error(`Unknown pivot dimension: ${String(exhaustive)}`);
    }
  }
}

/** Matches the live query's `COALESCE(${d.column}, "(not set)") AS ${d.key}`
 * wrapping applied to every dimension column. */
export function resolveDimensionValue(key: PivotDimensionKey, row: DimensionRow): string {
  return rawDimensionValue(key, row) ?? NOT_SET;
}

export function resolveAllDimensions(
  keys: PivotDimensionKey[],
  row: DimensionRow,
): Record<PivotDimensionKey, string> {
  const result = {} as Record<PivotDimensionKey, string>;
  for (const key of keys) result[key] = resolveDimensionValue(key, row);
  return result;
}
