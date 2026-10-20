import { expect, it } from "vitest";
import { bundledPlugins } from ".";

it("shares every bundled discovery tag between at least two plugins", () => {
  const plugins = new Map<string, string[]>();
  for (const { manifest } of bundledPlugins)
    for (const tag of manifest.discovery?.tags ?? [])
      plugins.set(tag, [...(plugins.get(tag) ?? []), manifest.id]);
  expect(plugins.size).toBeGreaterThan(0);
  for (const [tag, ids] of plugins) expect(ids.length, tag).toBeGreaterThan(1);
});
