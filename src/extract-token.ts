export function extractAccessToken(payload: Record<string, unknown>): string | null {
  if (typeof payload.accessToken === "string") return payload.accessToken;
  if (typeof payload.access_token === "string") return payload.access_token;
  if (typeof payload.token === "string") return payload.token;

  const data = payload.data;
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.accessToken === "string") return d.accessToken;
    if (typeof d.access_token === "string") return d.access_token;
  }

  const session = payload.session;
  if (session && typeof session === "object") {
    const s = session as Record<string, unknown>;
    if (typeof s.accessToken === "string") return s.accessToken;
    if (typeof s.access_token === "string") return s.access_token;
  }

  return null;
}
