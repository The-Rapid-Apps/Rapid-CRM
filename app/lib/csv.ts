/**
 * CSV for exports people open in a spreadsheet. Shared so every export gets
 * the same two protections: RFC 4180 quoting, and a guard against CSV
 * injection — values here often come from strangers (App Store search terms,
 * review text), and a cell starting `=HYPERLINK(...)` runs when Excel or
 * Sheets opens the file. OWASP's mitigation: prefix it with a quote, which
 * spreadsheets show as plain text.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvCell(raw: string): string {
  const safe = FORMULA_TRIGGER.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Rows to CSV text, CRLF line endings (RFC 4180, and what Excel expects). */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  return rows
    .map((row) => row.map((cell) => (typeof cell === "number" ? String(cell) : csvCell(cell ?? ""))).join(","))
    .join("\r\n");
}

/**
 * Parses RFC 4180 CSV into objects keyed by the header row. Handles quoted
 * fields holding commas, doubled quotes and line breaks — review text has all
 * three. A leading byte-order mark is ignored.
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header = [], ...body] = rows;
  return body
    .filter((cells) => cells.some((value) => value !== ""))
    .map((cells) => Object.fromEntries(header.map((key, index) => [key.trim(), cells[index] ?? ""])));
}

/**
 * Parse CSV into rows of raw strings.
 *
 * Hand-rolled rather than adding a dependency, and complete enough for the cases
 * that actually break naive splitting: quoted fields containing commas, embedded
 * newlines (a referral note, an address), and escaped quotes (`""`). A merchant
 * named `Smith, Jones & Co` in an unquoted split silently shifts every column after
 * it, which is the kind of corruption that lands as money in the wrong place.
 *
 * Both CRLF and LF line endings, because a CSV downloaded on Windows has the former.
 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // Strip a UTF-8 BOM: Excel writes one, and it would otherwise become part of the
  // first header name and stop it matching any alias.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      // Consume the LF of a CRLF pair so it does not open an empty row.
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      // A blank line is separator noise, not a record.
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }

  return rows;
}
