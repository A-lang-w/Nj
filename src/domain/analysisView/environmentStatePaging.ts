import {
  iterateUrlQueryParameters,
  parseUrlQueryParameterNames,
} from "../recordedTransportUrl.js";

/** Query parameters that page or bound a list without filtering it. */
const PAGING_PARAMETERS = new Set([
  "limit",
  "offset",
  "page",
  "per_page",
  "perpage",
  "page_size",
  "pagesize",
  "size",
  "start",
  "_start",
  "_end",
]);

/** Whether a query parameter pages or bounds a list rather than filtering it. */
export const isPagingParameter = (name: string): boolean =>
  PAGING_PARAMETERS.has(name.toLowerCase());

/** Whether a query only pages its list: no parameters, or paging parameters alone. */
export const pagesOnly = (query: string | undefined): boolean =>
  query === undefined ||
  [...parseUrlQueryParameterNames(query)].every(isPagingParameter);

/** Parameters that name the first item of a page. `page` counts pages, not items. */
const PAGE_START_PARAMETERS = new Set(["offset", "start", "_start"]);

/** Paging parameters that bound how many items a page holds. */
const PAGE_SIZE_PARAMETERS = new Set([
  "limit",
  "per_page",
  "perpage",
  "page_size",
  "pagesize",
  "size",
]);

/** Pages 0 and 1 are the first page; a greater `page` is a later one. */
const FIRST_PAGE = 1;

/**
 * The first item a query asks for. A whole-number `offset`, `start` or `_start`
 * names that index. A `page` of 0 or 1 is the first page. A later page uses
 * `(page - 1)` times a positive page size when one is named, and otherwise is
 * not item 0. The result is the greatest of those. Serving lists a whole
 * collection from item 0 and does not skip to this index, so a nonzero start
 * stays on the recorded path in the read gate, in serving and in the write gate.
 */
export const pageStart = (query: string | undefined): number => {
  let start = 0;
  let page: number | undefined;
  let pageSize: number | undefined;
  for (const [name, value] of iterateUrlQueryParameters(query ?? "")) {
    if (!/^\d+$/u.test(value)) continue;
    const number = Number(value);
    const key = name.toLowerCase();
    if (PAGE_START_PARAMETERS.has(key)) start = Math.max(start, number);
    else if (key === "page") page = Math.max(page ?? 0, number);
    else if (PAGE_SIZE_PARAMETERS.has(key) && number > 0)
      pageSize = Math.min(pageSize ?? Infinity, number);
  }
  if (page !== undefined && page > FIRST_PAGE) {
    const established =
      pageSize === undefined ? undefined : (page - FIRST_PAGE) * pageSize;
    start = Math.max(start, established ?? 1);
  }
  return start;
};

/** The most items a query's page holds: its smallest whole-number page-size value or `_start`–`_end` range width, or undefined without one; with `unboundedZero`, a size of zero is no bound. */
const pageLimit = (
  query: string | undefined,
  unboundedZero: boolean,
): number | undefined => {
  let size = Infinity;
  const range = { start: 0, end: Infinity };
  for (const [name, value] of iterateUrlQueryParameters(query ?? "")) {
    const key = name.toLowerCase();
    if (!/^\d+$/u.test(value)) continue;
    const number = Number(value);
    if (PAGE_SIZE_PARAMETERS.has(key)) {
      if (number > 0 || !unboundedZero) size = Math.min(size, number);
    } else if (key === "_start") range.start = number;
    else if (key === "_end") range.end = number;
  }
  const width = Math.min(size, Math.max(range.end - range.start, 0));
  return Number.isFinite(width) ? width : undefined;
};

/** The most items a line's call lists. A size of zero is no bound on a line whose own recording listed items under it, as an application reading zero as no limit does; every other size and range still bounds the page. */
export const pageBound = (
  query: string | undefined,
  recorded: number,
): number | undefined => pageLimit(query, recorded > 0);
