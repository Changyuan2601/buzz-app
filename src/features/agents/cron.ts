type Field = Readonly<{ values: ReadonlySet<number>; wildcard: boolean }>;

function field(text: string, min: number, max: number, sunday = false): Field {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error("Invalid UTC cron field");
    const range = match[1] as string;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1)
      throw new Error("Invalid UTC cron step");
    const [first, last] =
      range === "*"
        ? [min, max]
        : range.includes("-")
          ? range.split("-").map(Number)
          : [Number(range), match[2] === undefined ? Number(range) : max];
    if (
      first === undefined ||
      last === undefined ||
      first < min ||
      last > max ||
      first > last
    )
      throw new Error("UTC cron field is out of range");
    for (let value = first; value <= last; value += step)
      values.add(sunday && value === 7 ? 0 : value);
  }
  return {
    values,
    wildcard: text.split(",").some((part) => part.startsWith("*")),
  };
}

/** Five numeric fields in UTC. Restricted day fields use OR. */
export function utcCron(expression: string): (seconds: number) => boolean {
  if (expression.length > 256) throw new Error("UTC cron is too long");
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("UTC cron needs five fields");
  const [minute, hour, day, month, weekday] = [
    field(parts[0] as string, 0, 59),
    field(parts[1] as string, 0, 23),
    field(parts[2] as string, 1, 31),
    field(parts[3] as string, 1, 12),
    field(parts[4] as string, 0, 7, true),
  ] as [Field, Field, Field, Field, Field];
  return (seconds) => {
    const date = new Date(seconds * 1000);
    const dom = day.values.has(date.getUTCDate());
    const dow = weekday.values.has(date.getUTCDay());
    return (
      minute.values.has(date.getUTCMinutes()) &&
      hour.values.has(date.getUTCHours()) &&
      month.values.has(date.getUTCMonth() + 1) &&
      (day.wildcard || weekday.wildcard ? dom && dow : dom || dow)
    );
  };
}
