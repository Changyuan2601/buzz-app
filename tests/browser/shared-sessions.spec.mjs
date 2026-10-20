import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

// Browser-only: host tab wiring, real Share receipt → View navigation, and
// rendered row geometry across themes cannot be established by a component mount.
test.use({
  pluginFixtures: true,
  productionBroker: true,
  dmLabels: true,
  agentPeers: true,
  soloChannels: ["beta"],
  channelNames: {
    beta: "Beta notifications: investigate duplicate delivery and verify channel permissions",
  },
  channelWriteKinds: [9, 9000, 9007],
  historyCounts: { alpha: 2, beta: 2 },
});

test("a confirmed share opens the durable title-first channel index", async ({
  page,
  app,
}, testInfo) => {
  // Historical cards have no t/s markers and already exist before this device opens.
  app.append(
    "primary",
    "alpha",
    "[Session: Old saved title](buzz://channel/beta)",
    false,
  );
  await open(page, app);
  await page.evaluate((target) => window.fixtureNavigation.open(target), {
    version: 1,
    kind: "conversation",
    channelId: "alpha",
    panel: "shared-sessions",
    scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
  });
  const historical = page.getByRole("region", {
    name: "Shared sessions",
    exact: true,
  });
  await expect(historical.getByRole("listitem")).toHaveCount(1);
  await expect(historical).toContainText("Beta notifications");
  await expect(historical).not.toContainText("Old saved title");
  await page.evaluate((target) => window.fixtureNavigation.open(target), {
    version: 1,
    kind: "conversation",
    channelId: "beta",
    scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
  });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share chat" });
  await dialog
    .getByRole("combobox", { name: "People or channel" })
    .fill("Alpha");
  await page.getByRole("option", { name: "Alpha", exact: true }).click();
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "View", exact: true }).click();
  const region = page.getByRole("region", {
    name: "Shared sessions",
    exact: true,
  });
  await expect(region).toBeVisible();
  await expect(region).toBeFocused();
  const row = region.getByRole("listitem");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Beta");
  const search = region.getByRole("searchbox", {
    name: "Search shared sessions",
  });
  await search.fill("missing topic");
  await expect(region.getByText(/No titles or sharers match/)).toBeVisible();
  await region
    .getByRole("button", { name: "Clear search", exact: true })
    .click();
  await expect(row).toHaveCount(1);
  const person = (await row.getByRole("button").getAttribute("aria-label"))
    .split(", shared by ")[1]
    .split(", ")[0];
  await search.fill(person);
  await expect(row).toHaveCount(1);
  await search.fill("");
  // Keep representative PR evidence; state/search/recovery matrices are mounted tests.
  await page.setViewportSize({ width: 1440, height: 950 });
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await expect(row.getByRole("button")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`shared-sessions-${mode}.png`),
    });
  }
  await row.getByRole("button").click();
  await expect(
    page.getByRole("article", { name: "Conversation", exact: true }),
  ).toContainText("Beta");
});
