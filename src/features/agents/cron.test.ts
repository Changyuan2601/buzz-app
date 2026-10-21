import { describe, expect, it } from "vitest";
import { utcCron } from "./cron";
const at = (date: string) => Date.parse(date) / 1000;

describe("UTC cron", () => {
  it.each([
    ["*/15 9-17 * * 1-5", "2026-10-21T09:30:00Z", true],
    ["*/15 9-17 * * 1-5", "2026-10-21T09:31:00Z", false],
    ["0,30 12 * 10 0,7", "2026-10-25T12:30:00Z", true],
    ["0 12 20 * 3", "2026-10-21T12:00:00Z", true],
    ["0 12 20 * 3", "2026-10-20T12:00:00Z", true],
    ["0 12 20 * 3", "2026-10-22T12:00:00Z", false],
    ["0 12 * * 3", "2026-10-22T12:00:00Z", false],
    ["0 12 */2 * *", "2026-10-21T12:00:00Z", true],
    ["0 12 */2 * *", "2026-10-22T12:00:00Z", false],
  ])("matches %s at %s", (cron, date, expected) => {
    expect(utcCron(cron)(at(date))).toBe(expected);
  });
  it.each([
    "* * * *",
    "60 * * * *",
    "0 24 * * *",
    "0 0 0 * *",
    "0 0 * 13 *",
    "0 0 * * 8",
    "*/0 * * * *",
    "2-1 * * * *",
    "0 0 * * MON",
    "0 0 * * 1.5",
    "0 0 * * 1,",
  ])("rejects %s", (cron) => {
    expect(() => utcCron(cron)).toThrow();
  });
});
