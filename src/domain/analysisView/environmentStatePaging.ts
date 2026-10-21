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

/** Whether a query only pages its list: no parameters, or paging parameters alone. */
export const pagesOnly = (query: string | undefined): boolean =>
  query === undefined ||
  [...parseUrlQueryParameterNames(query)].every((name) =>
    PAGING_PARAMETERS.has(name.toLowerCase()),
  );

/** Paging parameters that bound how many items a page holds. */
const PAGE_SIZE_PARAMETERS = new Set([
  "limit",
  "per_page",
  "perpage",
  "page_size",
  "pagesize",
  "size",
]);

/** The most items a query's page holds: its smallest whole-number page-size value or `_start`–`_end` range width, or undefined without one. */
export const pageSize = (query: string | undefined): number | undefined => {
  let size = Infinity;
  const range = { start: 0, end: Infinity };
  for (const [name, value] of iterateUrlQueryParameters(query ?? "")) {
    const key = name.toLowerCase();
    if (!/^\d+$/u.test(value)) continue;
    // A size of zero bounds nothing: applications read it as no limit, as a whole line naming it shows.
    if (PAGE_SIZE_PARAMETERS.has(key)) {
      if (Number(value) > 0) size = Math.min(size, Number(value));
    } else if (key === "_start") range.start = Number(value);
    else if (key === "_end") range.end = Number(value);
  }
  const width = Math.min(size, Math.max(range.end - range.start, 0));
  return Number.isFinite(width) ? width : undefined;
};
