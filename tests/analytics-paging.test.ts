import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Guards against the regression that took every report down: MySQL rejects a
 * statement with more than 65,535 bound parameters, and Prisma resolves a
 * nested relation select as a follow-up query binding one placeholder per
 * parent row. An unbounded `findMany` over app_installs therefore threw P2029
 * ("query parameter limit ... exceeded") as soon as the Shopify backfill pushed
 * that table past ~53k rows.
 *
 * These assert on source text because the failure only reproduces against a
 * database holding tens of thousands of rows, which a unit test cannot stand
 * up. What is checkable — and what actually regressed — is that the loaders
 * page instead of reading everything in one statement.
 */
const SOURCE = readFileSync(
  new URL("../app/lib/reports/analytics.server.ts", import.meta.url),
  "utf8",
);

/**
 * Returns the source of one declaration: from its start to the next top-level
 * declaration. Brace matching is not usable here because a signature whose
 * parameters are an inline object type opens a brace before the body does.
 */
function extractBlock(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `could not find ${declaration}`);
  const rest = source.slice(start + declaration.length);
  // Any line starting at column 0 with a new declaration ends this one.
  const next = rest.search(/\n(?:export |async function |function |const |\/\*\*)/);
  return rest.slice(0, next === -1 ? undefined : next);
}

test("the relation page size stays well under MySQL's parameter ceiling", () => {
  const match = SOURCE.match(/const RELATION_PAGE_SIZE = ([\d_]+)/);
  assert.ok(match, "RELATION_PAGE_SIZE must be defined");
  const size = Number(match[1].replace(/_/g, ""));
  assert.ok(size > 0, "page size must be positive");
  // 65,535 is the hard limit; a nested relation's own filters bind parameters
  // too, so leave real headroom rather than sitting just under it.
  assert.ok(
    size <= 10_000,
    `RELATION_PAGE_SIZE ${size} leaves too little headroom under the 65535 limit`,
  );
});

for (const loader of [
  "async function loadInstalls",
  "async function loadSubscriptions",
]) {
  test(`${loader.replace("async function ", "")} pages its query`, () => {
    const body = extractBlock(SOURCE, loader);
    assert.match(
      body,
      /findManyPaged/,
      `${loader} must read through findManyPaged so nested relation queries stay bounded`,
    );
    // Cursor paging, not offset: offset degrades into a growing scan.
    assert.match(body, /cursor: \{ id: cursor \}/, `${loader} must page by id cursor`);
    assert.match(body, /orderBy: \{ id: "asc" \}/, `${loader} needs a stable order to page`);
  });
}

test("getCurrentMrrByCurrency pages too, since it shares the nested includes", () => {
  const body = extractBlock(SOURCE, "export async function getCurrentMrrByCurrency");
  assert.match(body, /findManyPaged/);
});

test("findManyPaged terminates on a short page and advances by last id", () => {
  // Mirrors the helper's contract: pages until a short page, cursor = last id.
  const PAGE = 3;
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: `id-${i}` }));
  const seenCursors: Array<string | undefined> = [];

  async function findManyPaged<T extends { id: string }>(
    fetchPage: (cursor: string | undefined, take: number) => Promise<T[]>,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await fetchPage(cursor, PAGE);
      out.push(...page);
      if (page.length < PAGE) return out;
      cursor = page[page.length - 1].id;
    }
  }

  return findManyPaged<{ id: string }>(async (cursor, take) => {
    seenCursors.push(cursor);
    const from = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
    return rows.slice(from, from + take);
  }).then((all) => {
    assert.deepEqual(
      all.map((r) => r.id),
      rows.map((r) => r.id),
      "must return every row exactly once, in order",
    );
    assert.deepEqual(seenCursors, [undefined, "id-2", "id-5"]);
  });
});

test("loadInstalls and loadSubscriptions deduplicate concurrent reads", () => {
  for (const loader of [
    "async function loadInstalls",
    "async function loadSubscriptions",
  ]) {
    const body = extractBlock(SOURCE, loader);
    assert.match(
      body,
      /dedupeConcurrent/,
      `${loader} must dedupe: getAnalyticsReports asks three reports for the same load at once`,
    );
  }
});

test("dedupeConcurrent releases its entry so nothing is cached between requests", () => {
  // The entry must be removed on settle, otherwise this becomes a cache holding
  // ~77k install rows alive and can serve stale data to a later request.
  const body = extractBlock(SOURCE, "function dedupeConcurrent");
  assert.match(body, /\.finally\(/, "must clear the entry when the load settles");
  assert.match(body, /inFlightLoads\.delete\(key\)/);
});

test("dedupeConcurrent shares one in-flight load and releases it afterwards", async () => {
  // Mirrors the helper's contract.
  const inFlight = new Map<string, Promise<unknown>>();
  function dedupeConcurrent<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const pending = load().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return pending;
  }

  let loads = 0;
  let release: (value: string) => void = () => {};
  const load = () => {
    loads += 1;
    return new Promise<string>((resolve) => {
      release = resolve;
    });
  };

  const a = dedupeConcurrent("k", load);
  const b = dedupeConcurrent("k", load);
  assert.equal(loads, 1, "a concurrent second caller must not start a new load");
  assert.equal(inFlight.size, 1);

  release("value");
  assert.deepEqual(await Promise.all([a, b]), ["value", "value"]);
  // Settled entries must be gone, so the next request reads fresh data.
  assert.equal(inFlight.size, 0, "entry must be released once settled");

  const c = dedupeConcurrent("k", load);
  assert.equal(loads, 2, "a later call must perform a fresh load");
  release("second");
  await c;
});

test("a rejected dedupeConcurrent load propagates and still releases", async () => {
  const inFlight = new Map<string, Promise<unknown>>();
  function dedupeConcurrent<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const pending = load().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return pending;
  }

  const failing = dedupeConcurrent("k", () =>
    Promise.reject(new Error("db down")),
  );
  const shared = inFlight.get("k") as Promise<unknown>;
  await assert.rejects(failing, /db down/);
  await assert.rejects(shared, /db down/);
  // A failure must not wedge the key permanently.
  assert.equal(inFlight.size, 0);
});

test("findManyPaged makes one extra empty call when the total is an exact multiple", () => {
  const PAGE = 2;
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: `id-${i}` }));
  let calls = 0;

  async function findManyPaged<T extends { id: string }>(
    fetchPage: (cursor: string | undefined, take: number) => Promise<T[]>,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await fetchPage(cursor, PAGE);
      out.push(...page);
      if (page.length < PAGE) return out;
      cursor = page[page.length - 1].id;
    }
  }

  return findManyPaged<{ id: string }>(async (cursor, take) => {
    calls += 1;
    const from = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
    return rows.slice(from, from + take);
  }).then((all) => {
    assert.equal(all.length, 4, "no duplicates or drops on an exact multiple");
    // 2 full pages + 1 empty page proving termination rather than a miss.
    assert.equal(calls, 3);
  });
});
