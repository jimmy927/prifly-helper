/**
 * Chrome match patterns, as an extension's manifest declares the sites
 * `api.helper` may reach: `https://www.linkedin.com/*`, `*://*.example.com/a/*`.
 *
 * A pattern is `<scheme>://<host><path>`. The scheme is `http`, `https` or `*`
 * (both). The host is exact or `*.domain` (the domain and every subdomain);
 * a bare `*` host is refused, as it would declare every site. The path (with
 * the query) matches with `*` as a wildcard.
 *
 * COPY: prifly's `apps/desktop-host/src/helper/match-pattern.ts`, verbatim
 * except this line, so the extension refuses exactly what the host would.
 */

const PATTERN = /^(\*|https?):\/\/(\*\.[^/*]+|[^/*]+)(\/.*)$/;

function parsed(url: string): URL | null {
  try {
    return new URL(url);
  } catch (caught) {
    if (caught instanceof TypeError) return null;
    throw caught;
  }
}

function pathMatches(pattern: string, target: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(target);
}

export function matchesPattern(pattern: string, url: string): boolean {
  const parts = PATTERN.exec(pattern);
  const target = parsed(url);
  if (parts === null || target === null) return false;
  const [, scheme, host, path] = parts;
  if (path === undefined || host === undefined) return false;
  const protocol = target.protocol.slice(0, -1);
  if (scheme === "*" ? protocol !== "http" && protocol !== "https" : protocol !== scheme)
    return false;
  const name = target.hostname;
  if (host.startsWith("*.")) {
    const base = host.slice(2).toLowerCase();
    if (name !== base && !name.endsWith(`.${base}`)) return false;
  } else if (name !== host.toLowerCase()) {
    return false;
  }
  return pathMatches(path, target.pathname + target.search);
}

/** Whether `url` is inside any of the declared patterns. */
export function allowedUrl(patterns: readonly string[], url: string): boolean {
  return patterns.some((pattern) => matchesPattern(pattern, url));
}

/** The lane a URL belongs to unless the plugin names one: its hostname. */
export function siteKeyOf(url: string): string {
  return parsed(url)?.hostname ?? url;
}
