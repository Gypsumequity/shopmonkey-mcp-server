// Composite report tools aggregate Shopmonkey list endpoints client-side.
// Shopmonkey has no native /report endpoint — these tools compose the data from
// existing list endpoints. All tools return raw JSON (not Markdown) for
// downstream processing flexibility.
//
// Order-based reports read their date window through fetchOrdersInWindow,
// which asks the API to sort and only pages the whole list when it refuses.
// Each report says which happened (`strategy`) and what it cost (`requests`),
// so a wrong-looking number can be traced to how it was gathered. The
// appointment report uses /appointment/search, whose structured where filter
// works server-side. See docs/LIMITATIONS.md and src/orderWindow.ts.
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { shopmonkeyRequest, getDefaultLocationId, toDateRangeBoundary } from '../client.js';
import { fetchOrdersInWindow } from '../orderWindow.js';
import type { Order, Appointment } from '../types/shopmonkey.js';
import type { ToolHandlerMap } from '../types/tools.js';

export const definitions: Tool[] = [
  {
    name: 'report_revenue_summary',
    description: 'Generate a revenue summary for orders INVOICED within a date range (filtered on invoicedDate, not order creation date). Aggregates by status and splits paid vs. unpaid revenue. Pages the full order list each call for a consistent total — check the returned `truncated` flag if the shop is very large.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        startDate: { type: 'string', description: 'Start date in ISO 8601 format (e.g., "2026-04-01")' },
        endDate: { type: 'string', description: 'End date in ISO 8601 format (e.g., "2026-04-30")' },
        locationId: { type: 'string', description: 'Filter by location ID. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
      },
      required: ['startDate', 'endDate'],
    },
  },
  {
    name: 'report_appointment_summary',
    description: 'Generate an appointment summary for a date range. Counts appointments by confirmation status (Confirmed/Declined/NoResponse). Uses the /appointment/search endpoint, which filters by date server-side.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        startDate: { type: 'string', description: 'Start date in ISO 8601 format (e.g., "2026-04-01")' },
        endDate: { type: 'string', description: 'End date in ISO 8601 format (e.g., "2026-04-30")' },
        locationId: { type: 'string', description: 'Filter by location ID. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
      },
      required: ['startDate', 'endDate'],
    },
  },
  {
    name: 'report_open_estimates',
    description: 'List genuinely open estimates \u2014 unauthorized, never invoiced, and not archived \u2014 with the age in days of each. This is the follow-up list: quotes a customer has not acted on. Records the shop has already closed out, invoiced or archived are excluded, as are repair orders in progress. The result reports how many were excluded and why, under `excluded`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        locationId: { type: 'string', description: 'Filter by location ID. Defaults to SHOPMONKEY_LOCATION_ID env var if set.' },
      },
    },
  },
];

const SEARCH_LIMIT = 500;

function getDefaultLocParam(): Record<string, string> {
  const params: Record<string, string> = {};
  const defaultId = getDefaultLocationId();
  if (defaultId) params.locationId = defaultId;
  return params;
}

export const handlers: ToolHandlerMap = {
  async report_revenue_summary(args) {
    if (!args.startDate) return { content: [{ type: 'text', text: 'Error: startDate is required' }], isError: true };
    if (!args.endDate) return { content: [{ type: 'text', text: 'Error: endDate is required' }], isError: true };

    const params = getDefaultLocParam();
    if (args.locationId !== undefined) params.locationId = String(args.locationId);
    // Filtered on invoicedDate, not createdDate: "revenue invoiced in August"
    // is not "orders created in August" — an order opened in July can be
    // invoiced in August. Orders never invoiced have no invoicedDate and are
    // correctly excluded from revenue.
    const { records: orders, truncated, strategy, requests, orderbyUsed } =
      await fetchOrdersInWindow(params, {
        dateField: 'invoicedDate',
        startDate: String(args.startDate),
        endDate: String(args.endDate),
      });

    // Null-prototype: the keys come from Shopmonkey's own status field, and a
    // value of __proto__ or constructor would otherwise reach Object.prototype.
    const breakdown: Record<string, { count: number; totalCostCents: number }> = Object.create(null);
    let totalCostCents = 0;
    let paidCostCents = 0;

    for (const order of orders) {
      const status = String(order.status ?? 'Unknown');
      const cost = Number(order.totalCostCents ?? 0);

      totalCostCents += cost;
      // Not `if (order.paid) paidCostCents += cost`: that flag is all-or-
      // nothing, so a part-paid ticket counted as zero and a settled one
      // counted its full value. `paidCostCents` is the amount actually
      // received, which is what a revenue report is asking for.
      //
      // The `paid` flag is still the fallback for records that carry no
      // paidCostCents at all, so older or partial payloads do not silently
      // report a shop as having collected nothing.
      const received = order.paidCostCents;
      paidCostCents += received === undefined || received === null
        ? (order.paid ? cost : 0)
        : Number(received);

      if (!breakdown[status]) breakdown[status] = { count: 0, totalCostCents: 0 };
      breakdown[status].count += 1;
      breakdown[status].totalCostCents += cost;
    }

    const result = {
      period: { startDate: args.startDate, endDate: args.endDate },
      totals: {
        totalCostCents,
        paidCostCents,
        unpaidCostCents: totalCostCents - paidCostCents,
      },
      breakdown,
      count: orders.length,
      strategy,
      requests,
      ...(orderbyUsed ? { orderbyUsed } : {}),
      truncated,
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  async report_appointment_summary(args) {
    if (!args.startDate) return { content: [{ type: 'text', text: 'Error: startDate is required' }], isError: true };
    if (!args.endDate) return { content: [{ type: 'text', text: 'Error: endDate is required' }], isError: true };

    const params = getDefaultLocParam();
    if (args.locationId !== undefined) params.locationId = String(args.locationId);
    // /appointment/search honours a structured where filter, unlike the flat
    // GET /appointment list, so the date range is applied server-side here.
    const where = {
      startDate: {
        gte: toDateRangeBoundary(String(args.startDate), 'start'),
        lte: toDateRangeBoundary(String(args.endDate), 'end'),
      },
    };
    const found = await shopmonkeyRequest<Appointment[]>('POST', '/appointment/search', { where, limit: SEARCH_LIMIT });
    const truncated = found.length >= SEARCH_LIMIT;

    const locationId = args.locationId !== undefined ? String(args.locationId) : getDefaultLocationId();
    const appointments = locationId ? found.filter(a => a.locationId === locationId) : found;

    // Null-prototype, as above: confirmationStatus is API-supplied.
    const breakdown: Record<string, { count: number }> = Object.create(null);
    breakdown.Confirmed = { count: 0 };
    breakdown.Declined = { count: 0 };
    breakdown.NoResponse = { count: 0 };

    for (const appt of appointments) {
      const status = String(appt.confirmationStatus ?? 'NoResponse');
      if (breakdown[status]) {
        breakdown[status].count += 1;
      } else {
        breakdown[status] = { count: 1 };
      }
    }

    const result = {
      period: { startDate: args.startDate, endDate: args.endDate },
      totals: { count: appointments.length },
      breakdown,
      truncated,
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },

  async report_open_estimates(args) {
    const params = getDefaultLocParam();
    if (args.locationId !== undefined) params.locationId = String(args.locationId);
    params.status = 'Estimate';

    // Open estimates have no natural date window, so this one still reads the
    // whole list. It asks for a sort anyway: when the API honours it the read
    // is at least stable between calls, which is why two runs an hour apart no
    // longer disagree about how many estimates are open.
    const { records: orders, truncated, strategy, requests } =
      await fetchOrdersInWindow(params, { dateField: 'createdDate', maxRecords: 5000 });

    // What counts as an open estimate.
    //
    // `authorized === false` on its own is not the answer, though it reads like
    // it. That flag stays false on plenty of records that are nothing to do with
    // quoting, and against a live shop it returned 627 "open estimates" of which
    // only 37 were open estimates:
    //
    //   - 278 were already INVOICED, 266 of them fully PAID. An order invoiced
    //     without passing through an authorisation step never sets the flag, so
    //     completed, settled work was being reported as outstanding quotes.
    //   - 187 were RepairOrders in progress — active work, not quotes.
    //   - 125 of the remainder were ARCHIVED: closed out by the shop. The shop
    //     had already dealt with these, which is exactly why they were archived.
    //
    // So three conditions, not one. Each is a distinct way a record stops being
    // an open estimate, and dropping any one of them inflates the count by
    // enough to make the report useless: it was overstating the book by 17x and
    // its value by roughly double.
    const now = new Date();
    const openEstimates = orders
      .filter(o =>
        o.authorized === false &&
        o.status === 'Estimate' &&   // not a RepairOrder or an Invoice
        !o.invoicedDate &&           // never invoiced, belt to the status braces
        o.archived !== true          // not closed out by the shop
      )
      .map(o => {
        const created = o.createdDate ? new Date(String(o.createdDate)) : null;
        const ageInDays = created ? Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24)) : null;
        return { ...o, ageInDays };
      });

    const oldestAgeInDays = openEstimates.reduce((max, o) => {
      const age = o.ageInDays ?? 0;
      return age > max ? age : max;
    }, 0);

    // Say what was dropped. A reader who expects a bigger number deserves to see
    // where it went rather than wonder whether the filter is eating real work.
    const unauthorized = orders.filter(o => o.authorized === false);
    const excluded = {
      alreadyInvoiced: unauthorized.filter(o => o.status === 'Invoice' || !!o.invoicedDate).length,
      repairOrdersInProgress: unauthorized.filter(o => o.status === 'RepairOrder').length,
      archived: unauthorized.filter(
        o => o.status === 'Estimate' && !o.invoicedDate && o.archived === true
      ).length,
    };

    const result = {
      orders: openEstimates,
      count: openEstimates.length,
      oldestAgeInDays,
      excluded,
      strategy,
      requests,
      truncated,
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};
