/** Matches Buzz desktop's thread-summary recency ladder (dateFormatters.ts). */
export function relativeTimestamp(
  unixSeconds: number,
  nowSeconds = Date.now() / 1000,
  style: "long" | "compact" = "long",
) {
  const age = Math.max(0, nowSeconds - unixSeconds);
  if (style === "compact") {
    if (age < 60) return "now";
    if (age < 3600) return `${Math.floor(age / 60)}m`;
    if (age < 86400) return `${Math.floor(age / 3600)}h`;
    return `${Math.floor(age / 86400)}d`;
  }
  const ago = (value: number, unit: string) =>
    `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  if (age < 60) return "just now";
  if (age < 3600) return ago(Math.floor(age / 60), "minute");
  if (age < 86400) return ago(Math.floor(age / 3600), "hour");
  if (age < 604800) return ago(Math.floor(age / 86400), "day");
  return `on ${new Date(unixSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}
