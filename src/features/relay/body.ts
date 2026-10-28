/** Lightweight application-body boundary, for verified records or session-owned local intent. */
export function objectBody(
  content: string,
): Record<string, unknown> | undefined {
  // Plain bodies, such as NIP-29 metadata, would otherwise throw on every read.
  if (!/^[\t\n\r ]*\{/.test(content)) return;
  try {
    const value: unknown = JSON.parse(content);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
