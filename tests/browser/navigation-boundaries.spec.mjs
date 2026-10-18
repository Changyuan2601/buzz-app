import { openPage, pageChoices } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";
test.use({ pluginFixtures: true, historyCounts: { alpha: 1, beta: 0 } });

async function expectPageChoice(page, name, count) {
  const choices = await pageChoices(page);
  await expect(
    choices.getByRole("option", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect(choices.getByRole("option", { name, exact: true })).toHaveCount(
    count,
  );
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Search Buzz", includeHidden: true }),
  ).toHaveCount(0);
}

// Regressions from the independent review, exercised through production composition.
test("cold destination waits for its enabled provider to activate", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    window.delayFixture = { started: false };
  });
  const target = {
    version: 1,
    kind: "page",
    pluginId: "fixture.delayed",
    pageId: "slow",
  };
  try {
    await page.goto(
      `${app.origin}/#buzz=${encodeURIComponent(JSON.stringify(target))}`,
    );
    await expect
      .poll(() => page.evaluate(() => window.delayFixture.started))
      .toBe(true);
    await expect(page.getByRole("main").getByRole("status")).toHaveText(
      "Opening destination…",
    );
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation?.snapshot().status),
      )
      .toBe("opening");
    const destination = page.getByText("Delayed destination presented", {
      exact: true,
    });
    await expectPageChoice(page, "Delayed fixture", 0);
    await expect(destination).toHaveCount(0);
    await page.evaluate(() => window.delayFixture.release());
    await expect(destination).toBeVisible();
    await expectPageChoice(page, "Delayed fixture", 1);
    await expect
      .poll(() =>
        page.evaluate(() => window.fixtureNavigation.snapshot().status),
      )
      .toBe("opened");
  } finally {
    await page.evaluate(() => window.delayFixture?.release?.());
  }
});

test("Messages default resolution returns opened to cold and warm callers without an extra visit", async ({
  page,
  app,
}) => {
  await page.goto(
    `${app.origin}/#buzz=${encodeURIComponent(
      JSON.stringify({
        version: 1,
        kind: "page",
        pluginId: "buzz.repos",
        pageId: "repos",
      }),
    )}`,
  );
  await expect(
    page.getByRole("heading", {
      name: "Destination no longer available",
      exact: true,
    }),
  ).toBeVisible();
  await expectPageChoice(page, "Messages", 1);
  for (const mode of ["cold", "warm"]) {
    const result = await page.evaluate(async () => {
      const nav = window.fixtureNavigation;
      const pending = nav.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
      });
      const visit = nav.snapshot().entry.id;
      return { result: await pending, visit, resolved: nav.snapshot().entry };
    });
    expect(result.result, mode).toEqual({ status: "opened" });
    expect(result.resolved.id, mode).toBe(result.visit);
    expect(result.resolved.target.channelId, mode).toBe("alpha");
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Go back", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "Destination no longer available",
        exact: true,
      }),
    ).toBeVisible();
  }
});

test("native Alt arrows preserve composer editing; deliberate history shortcuts navigate", async ({
  page,
  app,
}) => {
  await open(page, app);
  await openPage(page, "Workflows");
  await expect(
    page.getByRole("heading", {
      name: "Workflows",
      exact: true,
    }),
  ).toBeVisible();
  await openPage(page, "Messages");
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await composer.fill("one two three");
  const visit = await page.evaluate(
    () => window.fixtureNavigation.snapshot().entry.id,
  );
  for (const arrow of ["ArrowLeft", "ArrowRight"]) {
    await page.keyboard.press(`Alt+${arrow}`);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveJSProperty("value", "one two three");
    expect(
      await page.evaluate(() => window.fixtureNavigation.snapshot().entry.id),
    ).toBe(visit);
  }
  const apple = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform),
  );
  await page.keyboard.press(`${apple ? "Meta" : "Control"}+[`);
  await expect(composer).toHaveCount(0);
  await page.keyboard.press(`${apple ? "Meta" : "Control"}+]`);
  await expect(composer).toHaveJSProperty("value", "one two three");
});
