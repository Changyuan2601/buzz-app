import { test, expect } from "./fixture.mjs";
const target = (app) => ({
  version: 1,
  kind: "conversation",
  channelId: pendingChannel,
  scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
});
const openTarget = (page, value) =>
  page.evaluate((target) => window.fixtureNavigation.open(target), value);
const history = (page) =>
  page.getByRole("region", { name: "Channel message history", exact: true });
// Real copied-link navigation must reach the shared composer/outbox boundary in both engines.

const pendingChannel = "22222222-2222-4222-8222-222222222222";
test.use({
  channelIds: [pendingChannel, "beta"],
  sessionChannels: [pendingChannel],
  historyCounts: { [pendingChannel]: 0, beta: 5 },
  pluginFixtures: true,
});
test("ordinary session links cannot bypass a pending start receipt", async ({
  page,
  app,
}) => {
  const scope = `https://primary.example:${app.viewer}`;
  const key = `buzz-view.v1:${JSON.stringify([scope, "sessions:section:work:pending"])}`;
  const receipt = JSON.stringify({
    id: pendingChannel,
    text: "Original first message",
    creationId: "c".repeat(64),
    setup: { sectionId: "work", canvas: "Frozen instructions", agents: [] },
    setupDone: false,
  });
  await page.goto(app.origin);
  await expect
    .poll(() =>
      page.evaluate(() => window.fixtureNavigation?.snapshot().status),
    )
    .toBe("opened");
  await page.evaluate(
    ({ key, receipt }) => localStorage.setItem(key, receipt),
    { key, receipt },
  );
  expect(
    await openTarget(page, { ...target(app), channelId: pendingChannel }),
  ).toEqual({ status: "opened" });
  const composer = page.getByRole("textbox", {
    name: "Message this session",
    exact: true,
  });
  await composer.fill("Cannot skip setup");
  await composer.press("Enter");
  await expect(
    page.getByText(
      "Finish setting up this session in Sessions before sending messages.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(composer).toHaveText("Cannot skip setup");
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    receipt,
  );
  expect(
    app.report.publications.filter(({ event }) => event.kind === 9),
  ).toHaveLength(0);
  // Retiring the receipt represents successful recovery; the ordinary route is usable again.
  await page.evaluate((key) => localStorage.removeItem(key), key);
  await composer.press("Enter");
  await expect(
    history(page).getByText("Cannot skip setup", { exact: true }),
  ).toBeVisible();
});
