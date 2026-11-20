import {
  fetchAllRecords,
  shopmonkeyRequestWithMeta,
  isWithinDateRange,
  toDateRangeBoundary,
  type FetchAllResult,
} from './client.js';
import type { Order } from './types/shopmonkey.js';

// ── Windowed order reads ─────────────────────────────────────────────────────
//
// The problem this solves
// -----------------------
// `GET /order` has no stable sort. Identical requests seconds apart return
// different, sometimes non-overlapping subsets, so `skip`/`limit` do not walk
// the list — they sample it. Reading a week of invoices by paging to exhaustion
// and filtering client-side therefore (a) costs one request per 100 orders in
// the whole shop, and (b) still misses records: a 58-pass sweep of a ~900-order
// shop converged on 623 distinct records and stopped yielding new ones, while
// records pulled days earlier proved invoices existed that those 58 passes
// never returned. See docs/LIMITATIONS.md, "No stable sort".
//
// The lever
// ---------
// Shopmonkey's list endpoints document an `orderby` parameter ("the order
// instructions for the result") alongside `where`, `limit` and `skip`. `where`
// is known to be ignored on the flat list endpoints. `orderby` had never been
// tried. If it is honoured, the list acquires a stable order, which makes
// `skip` meaningful and lets a date-windowed read stop as soon as it pages past
// the start of the window — two or three requests for a week instead of fifty.
//
// Why this probes instead of assuming
// -----------------------------------
// The exact encoding `orderby` expects is not documented, and this project has
// a history of bugs caused by trusting the documentation (see
// docs/API-PROVENANCE.md). So rather than pick an encoding and hope, this
// module tries the plausible ones and *checks the response*: a page is only
// accepted as sorted if its own values are actually monotonic on the sort key.
// An API that ignores `orderby` returns an unsorted page, fails that check, and
// the caller transparently falls back to the exhaustive sweep. A wrong guess
// costs one extra request, never a wrong answer.
//
// The winning encoding is remembered for the life of the process, so the probe
// runs once rather than per call.

/** Candidate encodings for `orderby`, most likely first. */
const ORDERBY_ENCODINGS: Array<(field: string, dir: 'asc' | 'desc') => string> = [
  (f, d) => JSON.stringify({ [f]: d }),
  (f, d) => JSON.stringify([{ [f]: d }]),
  (f, d) => (d === 'desc' ? `-${f}` : f),
  (f, d) => `${f} ${d}`,
  (f, d) => `${f}:${d}`,
];

type Probe = { encode: (f: string, d: 'asc' | 'desc') => string } | 'unsupported' | null;

/** Cached probe result. `null` = not yet probed, 'unsupported' = orderby ignored. */
let cachedProbe: Probe = null;

// When the probe fails, remember that only briefly. A permanent cache means one
// bad probe downgrades every later call for the life of the process, and a
// long-lived server then keeps sweeping long after whatever caused it has
// passed. Ten minutes is long enough to avoid re-probing on every call in a
// burst, short enough that the server heals itself.
const UNSUPPORTED_TTL_MS = 10 * 60 * 1000;
let unsupportedUntil = 0;

/** Test hook: forget what the probe learned. */
export function resetOrderbyProbe(): void {
  cachedProbe = null;
  unsupportedUntil = 0;
}

const PAGE_SIZE = 100;
/** How far the probe will page past null values before giving up on a field. */
const PROBE_MAX_SKIP = 500;

function dateValue(record: Order, field: string): number {
  const raw = (record as Record<string, unknown>)[field];
  if (typeof raw !== 'string') return Number.NaN;
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? Number.NaN : ts;
}

/**
 * True when `page` is ordered on `field` in `dir`, judged by the records' own
 * values rather than by the request having been accepted.
 *
 * Records with a missing or unparseable value for the field are skipped rather
 * than failing the check: Shopmonkey sorts nulls to one end, and an estimate
 * that was never invoiced legitimately has no `invoicedDate`. A page carrying
 * fewer than two comparable values proves nothing, so it is not treated as
 * evidence of sorting.
 */
export type Sortedness = 'sorted' | 'unsorted' | 'inconclusive';

export function checkPageSorted(page: Order[], field: string, dir: 'asc' | 'desc'): Sortedness {
  const values: number[] = [];
  for (const record of page) {
    const v = dateValue(record, field);
    if (!Number.isNaN(v)) values.push(v);
  }
  // Fewer than two comparable values proves nothing either way. This is not a
  // hypothetical: sorting on invoicedDate descending puts every never-invoiced
  // order at one end, and once a shop has more than a page of those, the first
  // page is all nulls. Reading that as "the API ignored orderby" is how a
  // working sorted read silently became a sweep in production.
  if (values.length < 2) return 'inconclusive';

  for (let i = 1; i < values.length; i++) {
    if (dir === 'desc' ? values[i] > values[i - 1] : values[i] < values[i - 1]) return 'unsorted';
  }
  return 'sorted';
}

/** Back-compat shim: true only when a page is positively sorted. */
export function isPageSorted(page: Order[], field: string, dir: 'asc' | 'desc'): boolean {
  return checkPageSorted(page, field, dir) === 'sorted';
}

export interface WindowedResult extends FetchAllResult<Order> {
  /**
   * How the records were obtained:
   *   'sorted' — `orderby` was honoured; the window was read directly and
   *              `truncated: false` means what it says: this is every record.
   *   'swept'  — `orderby` was ignored; fell back to paging the whole list.
   *              `truncated` is ALWAYS true here, because a sweep of an
   *              unsorted endpoint cannot establish that it saw everything.
   *              Treat the numbers as a floor and say so to whoever reads them.
   */
  strategy: 'sorted' | 'swept';
  /** Requests spent. Worth watching: 'swept' on a large shop is dozens. */
  requests: number;
  /** The encoding that worked, when one did. Useful for documenting the API. */
  orderbyUsed?: string;
}

/**
 * Reads the orders whose `dateField` falls in [startDate, endDate].
 *
 * Takes the sorted path when the API honours `orderby`, and the exhaustive
 * sweep when it does not. Either way the returned records are filtered to the
 * window and de-duplicated by id, so callers get the same answer from both
 * paths — only the cost differs.
 */
export async function fetchOrdersInWindow(
  params: Record<string, string>,
  opts: {
    dateField?: string;
    startDate?: string;
    endDate?: string;
    maxRecords?: number;
  } = {}
): Promise<WindowedResult> {
  const dateField = opts.dateField ?? 'invoicedDate';
  const maxRecords = opts.maxRecords ?? 5000;
  const { startDate, endDate } = opts;

  let requests = 0;

  // An expired 'unsupported' verdict goes back to being no verdict at all.
  if (cachedProbe === 'unsupported' && Date.now() >= unsupportedUntil) cachedProbe = null;

  const encodingsToTry =
    cachedProbe === 'unsupported'
      ? []
      : cachedProbe
        ? [cachedProbe.encode]
        : ORDERBY_ENCODINGS;

  for (const encode of encodingsToTry) {
    const orderby = encode(dateField, 'desc');

    let firstPage: Order[];
    try {
      const { data } = await shopmonkeyRequestWithMeta<Order[]>('GET', '/order', undefined, {
        ...params,
        orderby,
        limit: String(PAGE_SIZE),
        skip: '0',
      });
      requests++;
      firstPage = Array.isArray(data) ? data : [];
    } catch {
      // A rejected encoding is information, not a failure: try the next one.
      requests++;
      continue;
    }

    let verdict = checkPageSorted(firstPage, dateField, 'desc');

    // An inconclusive first page means "look further", not "give up". Page past
    // the nulls until the records start carrying the field, up to a bounded
    // number of probes so a shop that is all nulls cannot stall here.
    let probeSkip = 0;
    let probePage = firstPage;
    while (verdict === 'inconclusive' && probeSkip < PROBE_MAX_SKIP && probePage.length === PAGE_SIZE) {
      probeSkip += PAGE_SIZE;
      try {
        const { data } = await shopmonkeyRequestWithMeta<Order[]>('GET', '/order', undefined, {
          ...params, orderby, limit: String(PAGE_SIZE), skip: String(probeSkip),
        });
        requests++;
        probePage = Array.isArray(data) ? data : [];
      } catch {
        requests++;
        break;
      }
      if (probePage.length === 0) break;
      verdict = checkPageSorted(probePage, dateField, 'desc');
    }

    if (verdict !== 'sorted') continue;

    cachedProbe = { encode };
    try {
      const read = await readSortedWindow(
        params, orderby, dateField, startDate, endDate, maxRecords, firstPage
      );
      return { ...read, requests: requests + read.requests, strategy: 'sorted', orderbyUsed: orderby };
    } catch (error) {
      // The endpoint sorted the first page and then stopped. A partial sorted
      // read is worse than no sorted read — it looks complete and is not — so
      // discard it, stop trusting orderby for this process, and sweep instead.
      if (!(error instanceof OrderbyBetrayedError)) throw error;
      cachedProbe = 'unsupported';
      unsupportedUntil = Date.now() + UNSUPPORTED_TTL_MS;
      break;
    }
  }

  // Nothing sorted the list. Remember that so later calls skip the probe, and
  // fall back to the behaviour that was there before — slow, but correct as far
  // as it reaches, and honest about truncation.
  if (cachedProbe === null) {
    cachedProbe = 'unsupported';
    unsupportedUntil = Date.now() + UNSUPPORTED_TTL_MS;
  }

  const { records } = await fetchAllRecords<Order>('/order', params, { maxRecords });
  const filtered = records.filter((o) =>
    isWithinDateRange((o as Record<string, unknown>)[dateField] as string | undefined, startDate, endDate)
  );
  return {
    records: filtered,
    // Always true on this path, whatever fetchAllRecords thought.
    //
    // The sweep runs until the endpoint stops yielding, and on an endpoint with
    // no stable sort that is not the same as having seen everything: it
    // converges on an arbitrary subset and then goes quiet. Measured against
    // this shop, 58 passes settled on 623 of ~900 records and stopped finding
    // more, while records pulled days earlier proved the rest existed.
    //
    // Reporting truncated:false there is worse than reporting nothing. It is a
    // claim of completeness that the method cannot support, and it is precisely
    // the failure this module exists to prevent — a partial answer that looks
    // whole. A swept answer is a floor. Say so.
    truncated: true,
    strategy: 'swept',
    requests: requests + Math.ceil(records.length / PAGE_SIZE),
  };
}

/**
 * Walks a list the API has agreed to sort, newest first, stopping at the first
 * record older than the window.
 *
 * Every page is re-checked for sortedness, not just the first: the endpoint has
 * a documented habit of changing its mind between identical requests, and
 * stopping early on an unsorted page would silently truncate the window. A page
 * that fails the check aborts the sorted read so the caller can fall back.
 */
async function readSortedWindow(
  params: Record<string, string>,
  orderby: string,
  dateField: string,
  startDate: string | undefined,
  endDate: string | undefined,
  maxRecords: number,
  firstPage: Order[]
): Promise<FetchAllResult<Order> & { requests: number }> {
  const startTs = startDate ? Date.parse(toDateRangeBoundary(startDate, 'start')) : -Infinity;

  const kept: Order[] = [];
  const seen = new Set<unknown>();
  let requests = 0;
  let skip = 0;
  let page = firstPage;
  let reachedStart = false;

  while (true) {
    for (const record of page) {
      if (record?.id !== undefined) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
      }
      const raw = (record as Record<string, unknown>)[dateField] as string | undefined;
      if (isWithinDateRange(raw, startDate, endDate)) kept.push(record);
    }

    // Sorted newest-first, so once a page ends before the window starts there
    // is nothing older worth reading.
    const last = page[page.length - 1];
    const lastTs = last ? dateValue(last, dateField) : Number.NaN;
    if (!Number.isNaN(lastTs) && lastTs < startTs) { reachedStart = true; break; }

    if (page.length < PAGE_SIZE) { reachedStart = true; break; }

    skip += page.length;
    if (skip >= maxRecords) break;

    const { data } = await shopmonkeyRequestWithMeta<Order[]>('GET', '/order', undefined, {
      ...params,
      orderby,
      limit: String(PAGE_SIZE),
      skip: String(skip),
    });
    requests++;
    page = Array.isArray(data) ? data : [];
    if (page.length === 0) { reachedStart = true; break; }

    if (!isPageSorted(page, dateField, 'desc')) {
      throw new OrderbyBetrayedError(
        `/order returned an unsorted page at skip=${skip} after accepting orderby=${orderby}`
      );
    }
  }

  return { records: kept, truncated: !reachedStart, requests };
}

/** Thrown when the endpoint sorts one page and not the next. */
export class OrderbyBetrayedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderbyBetrayedError';
  }
}
