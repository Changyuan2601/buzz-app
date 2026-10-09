import { expect, it } from "vitest";
import {
  resolveMatch,
  type Contribution,
  type MatchOrder,
} from "./contributions";

const entry = (key: string, order?: MatchOrder) =>
  Object.freeze({
    key,
    pluginId: key.split("/")[0] ?? key,
    revision: "one",
    matches: () => true,
    order,
  }) as Contribution<{ matches(target: string): boolean; order?: MatchOrder }>;

it("treats a non-finite order result as the default band", () => {
  // Keys sort the default-band entry first, then the non-finite results, then
  // the catch-all. Honouring -Infinity would promote "b/neg" over "a/zero".
  const zero = entry("a/zero");
  const nonFinite = [
    entry("b/neg", () => Number.NEGATIVE_INFINITY),
    entry("c/nan", () => Number.NaN),
    entry("d/inf", () => Number.POSITIVE_INFINITY),
  ];
  const fallback = entry("z/fallback", 100);
  expect(resolveMatch([fallback, ...nonFinite, zero], "x")?.key).toBe("a/zero");
  // Without a declared default, the non-finite results still tie at 0 and
  // beat the catch-all band rather than being skipped.
  expect(resolveMatch([fallback, ...nonFinite], "x")?.key).toBe("b/neg");
});
