const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseAllowedUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Auth request URL is invalid");
  }

  if (url.username || url.password) {
    throw new TypeError("Auth request URL must not contain userinfo");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  ) {
    throw new TypeError(
      "Auth requests require HTTPS except for loopback local development",
    );
  }
  return url;
}

/** Build one same-origin auth URL while preserving a base URL path prefix. */
export function resolveAuthRequestUrl(baseUrl: string, path: string): string {
  const base = parseAllowedUrl(baseUrl);
  const basePath = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  base.pathname = basePath;
  base.search = "";
  base.hash = "";

  const relativePath = path.replace(/^\/+/, "");
  const request = parseAllowedUrl(new URL(relativePath, base).href);
  if (
    request.origin !== base.origin ||
    !request.pathname.startsWith(basePath)
  ) {
    throw new TypeError("Auth request URL must stay within configured base URL");
  }
  return request.href;
}

/** Send auth traffic without following redirects that could cross transport boundaries. */
export function fetchAuthRequest(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = resolveAuthRequestUrl(baseUrl, path);
  return fetch(url, { ...init, redirect: "error" });
}
