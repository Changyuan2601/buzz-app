import { test as appTest } from "./fixture.mjs";
import { test, expect } from "./playwright-test.mjs";

// The shared test base stops routes before Playwright closes the context, and
// the `app` fixture stops them before it closes its page.
const held = "http://fixture.invalid/held";

for (const owner of ["page", "context"]) {
  test(`a ${owner} route still in flight at test end does not fail the test`, async ({
    page,
  }) => {
    let started;
    const inFlight = new Promise((resolve) => {
      started = resolve;
    });
    const target = owner === "page" ? page : page.context();
    // The handler is inside page.evaluate when the test returns, so closing the
    // context rejects that call.
    await target.route(held, async (route) => {
      started();
      await page.evaluate(() => new Promise(() => {}));
      await route.fulfill({ body: "unreachable" });
    });
    await page.setContent("<p>route teardown</p>");
    await page.evaluate((url) => {
      void fetch(url).catch(() => {});
    }, held);
    await inFlight;
    await expect(page.getByText("route teardown")).toBeVisible();
  });
}

test("a route error raised while the test runs still fails the test", async ({
  page,
}) => {
  test.fail();
  await page.route(held, async (route) => {
    await route.fulfill({ body: "handled" });
    throw new Error("route handler defect");
  });
  await page.setContent("<p>route teardown</p>");
  await expect
    .poll(() => page.evaluate(async (url) => (await fetch(url)).text(), held))
    .toBe("handled");
});

appTest(
  "an app route still in flight at test end does not fail the test",
  async ({ page, app }) => {
    const target = `${app.origin}/held`;
    let started;
    const inFlight = new Promise((resolve) => {
      started = resolve;
    });
    // `app` closes its page during its own teardown, before the context
    // teardown runs, so it must stop this route first.
    await page.route(target, async (route) => {
      started();
      await page.evaluate(() => new Promise(() => {}));
      await route.fulfill({ body: "unreachable" });
    });
    await page.evaluate((url) => {
      void fetch(url).catch(() => {});
    }, target);
    await inFlight;
  },
);

test("a test that closes its own context still passes", async ({
  page,
  context,
}) => {
  await page.route(held, (route) => route.fulfill({ body: "x" }));
  await context.close();
});
