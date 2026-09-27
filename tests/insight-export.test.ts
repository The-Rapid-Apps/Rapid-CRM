import assert from "node:assert/strict";
import test from "node:test";
import {
  insightExportFilename,
  insightExportRows,
  insightRowsToCsv,
  insightRowsToJson,
} from "../app/lib/reports/insight-export";

test("exports every value, not just the eight the pie colours", () => {
  const slices = Array.from({ length: 12 }, (_, i) => ({
    value: `v${i}`,
    count: 12 - i,
  }));
  const rows = insightExportRows(slices, 78);
  assert.equal(rows.length, 12, "the pie's 'Other' fold is a chart limit, not an export one");
});

test("percentages are shares of this pie, to one decimal", () => {
  const rows = insightExportRows([{ value: "a", count: 1 }, { value: "b", count: 2 }], 3);
  assert.deepEqual(rows.map((r) => r.percentage), [33.3, 66.7]);
  assert.deepEqual(insightExportRows([{ value: "a", count: 0 }], 0)[0].percentage, 0);
});

test("a search term that looks like a formula is exported as text (CSV injection)", () => {
  const csv = insightRowsToCsv(
    insightExportRows(
      [
        { value: '=HYPERLINK("http://evil.example","x")', count: 1 },
        { value: "+cmd", count: 1 },
        { value: "-1+1", count: 1 },
        { value: "@SUM(A1)", count: 1 },
      ],
      4,
    ),
    "Search term",
  );
  const cells = csv.split("\r\n").slice(1).map((line) => line.split(",")[0]);
  for (const cell of cells) {
    assert.ok(
      cell.startsWith("'") || cell.startsWith(`"'`),
      `cell must start with a quote so Excel won't evaluate it: ${cell}`,
    );
  }
});

test("commas, quotes and line breaks are quoted per RFC 4180", () => {
  const csv = insightRowsToCsv(
    [
      { value: "pixel, facebook", count: 2, percentage: 50 },
      { value: 'the "best" pixel', count: 1, percentage: 25 },
      { value: "two\nlines", count: 1, percentage: 25 },
    ],
    "Search term",
  );
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "Search term,Count,Percentage");
  assert.equal(lines[1], '"pixel, facebook",2,50');
  assert.equal(lines[2], '"the ""best"" pixel",1,25');
  assert.ok(csv.includes('"two\nlines"'));
});

test("non-Latin values survive untouched", () => {
  const csv = insightRowsToCsv([{ value: "像素", count: 3, percentage: 100 }], "Search term");
  assert.ok(csv.includes("像素,3,100"));
});

test("JSON is a plain array of rows", () => {
  const parsed = JSON.parse(
    insightRowsToJson([{ value: "en", count: 85, percentage: 61.6 }]),
  );
  assert.deepEqual(parsed, [{ value: "en", count: 85, percentage: 61.6 }]);
});

test("filenames are safe slugs with the date", () => {
  assert.equal(
    insightExportFilename({
      dimensionLabel: "Search term",
      eventLabel: "Page views",
      date: new Date("2026-09-24T10:00:00Z"),
      extension: "csv",
    }),
    "traffic-insights-search-term-page-views-2026-09-24.csv",
  );
});

test("a revenue metric exports cents under its own name, not 'count'", () => {
  const rows = insightExportRows([{ value: "a", count: 10.005 }, { value: "b", count: 1 / 3 }], 10.338, true);
  assert.deepEqual(rows.map((r) => r.count), [10.01, 0.33]);
  assert.match(insightRowsToCsv(rows, "Country", "Average CLV (USD)"), /^Country,Average CLV \(USD\),Percentage/);
  const json = JSON.parse(insightRowsToJson(rows, "average_clv_usd"));
  assert.equal(json[0].average_clv_usd, 10.01);
  assert.equal("count" in json[0], false);
  assert.equal(
    insightExportFilename({ dimensionLabel: "Country", eventLabel: "Installed", metricLabel: "Median spend", date: new Date("2026-09-24T00:00:00Z"), extension: "csv" }),
    "traffic-insights-country-installed-median-spend-2026-09-24.csv",
  );
});
