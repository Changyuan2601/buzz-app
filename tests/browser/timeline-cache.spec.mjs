import { test, expect } from "./fixture.mjs";
import { open, settle } from "./timeline.mjs";

test.use({
  productionBroker: true,
  historyCounts: { alpha: 20, beta: 3 },
});

test("a short conversation paints its restored rows on the first frame", async ({
  page,
  app,
}) => {
  const history = page.getByRole("region", { name: "Channel message history" });
  const beta = page.getByRole("button", { name: "Beta", exact: true });
  await open(page, app);
  await beta.click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await settle(page);
  expect(
    await history.evaluate(
      (element) => element.scrollHeight <= element.clientHeight,
    ),
  ).toBe(true);
  const positions = await history
    .locator("ol > li")
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().top));
  expect(positions).toHaveLength(3);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await settle(page);
  // Capture before navigation; waiting for the composer would miss a hidden first frame.
  const capture = await page.evaluateHandle(() => {
    const previous = document.querySelector("[data-message-scroller] ol");
    const frames = [];
    let frame;
    const sample = () => {
      const list = document.querySelector("[data-message-scroller] ol");
      if (list && list !== previous && list.children.length)
        frames.push(
          [...list.children].map((row) => ({
            top: row.getBoundingClientRect().top,
            visibility: getComputedStyle(row).visibility,
          })),
        );
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    return { frames, stop: () => cancelAnimationFrame(frame) };
  });
  try {
    await beta.click();
    await expect(
      page.getByRole("textbox", { name: "Message #Beta", exact: true }),
    ).toBeVisible();
    await settle(page);
    const frames = await capture.evaluate(({ frames }) => frames);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0].map((row) => row.top)).toEqual(positions);
    expect(
      frames.every((rows) => rows.every((row) => row.visibility === "visible")),
    ).toBe(true);
  } finally {
    await capture.evaluate(({ stop }) => stop());
    await capture.dispose();
  }
});

// Real row measurement and React remounts must exercise the production cache.
// A DOM emulator cannot establish whether restored geometry retains overscan.
test("warm channel restoration keeps measured rows buffered above the viewport", async ({
  page,
  app,
}) => {
  const history = page.getByRole("region", {
    name: "Channel message history",
  });
  const bufferAbove = () =>
    history.evaluate((element) => {
      const first = element.querySelector("ol > li");
      return first
        ? element.getBoundingClientRect().top -
            first.getBoundingClientRect().bottom
        : 0;
    });
  await open(page, app);
  await settle(page);
  await expect.poll(bufferAbove).toBeGreaterThan(600);
  await page.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Beta", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
  await settle(page);
  await expect.poll(bufferAbove).toBeGreaterThan(600);
});
