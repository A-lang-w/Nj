/** URL route syntax, independent of filesystem path normalization. */
export const routePath = (
  value: string,
  options: { relative?: boolean; navigation?: boolean } = {},
): string | undefined => {
  const end = options.navigation ? value.search(/[?#]/u) : -1;
  const path = end < 0 ? value : value.slice(0, end);
  if (!path || /[\u0000-\u0020\u007f\\]/u.test(path) || path.startsWith("//"))
    return;
  if (!path.startsWith("/") && !options.relative) return;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(path)) return;
  return path.startsWith("/") ? path : `/${path}`;
};

/** A chunk declares a bundled App Router page, not a reachable deployed URL. */
export const nextAppRoutePath = (raw: string): string | undefined => {
  if (raw.includes("\\")) return;
  let value = raw;
  if (raw.includes("://")) {
    try {
      value = new URL(raw).pathname;
    } catch {
      return;
    }
  }
  const match =
    /(?:^|\/)app\/(?:(.*?)\/)?page(?:-[^/?#]+\.js|\.[cm]?jsx?|)(?:[?#].*)?$/u.exec(
      value,
    );
  if (!match) return;
  const segments: string[] = [];
  for (const encoded of (match[1] ?? "").split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(encoded);
    } catch {
      return;
    }
    if (/^\([^)]*\)$/u.test(segment) || segment.startsWith("@")) continue;
    // Intercepted routes need a parent routing context that a filename does not establish.
    if (
      segment.startsWith("(") ||
      segment.includes("/") ||
      segment === "." ||
      segment === ".."
    )
      return;
    const optional = /^\[\[\.\.\.([^\]]+)\]\]$/u.exec(segment);
    const catchAll = /^\[\.\.\.([^\]]+)\]$/u.exec(segment);
    const parameter = /^\[([^\]]+)\]$/u.exec(segment);
    segments.push(
      optional
        ? `:${optional[1]}*`
        : catchAll
          ? `:${catchAll[1]}+`
          : parameter
            ? `:${parameter[1]}`
            : segment,
    );
  }
  return routePath(`/${segments.filter(Boolean).join("/")}`);
};

export const nextScriptBasePath = (source: string): string | undefined => {
  let path = source;
  if (/^https?:\/\//iu.test(source)) {
    try {
      path = new URL(source).pathname;
    } catch {
      return;
    }
  } else if (!source.startsWith("/")) return;
  const at = path.indexOf("/_next/");
  return at < 0 ? undefined : path.slice(0, at);
};
