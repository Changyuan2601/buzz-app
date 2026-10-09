import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

const opened = async (menu) => {
  await expect(menu).toBeVisible();
  await menu.evaluate((node) =>
    Promise.all(
      node
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().endTime !== Infinity,
        )
        .map((animation) => animation.finished),
    ),
  );
};
test.use({
  productionBroker: true,
  readState: true,
  historyCounts: { alpha: 2, beta: 1 },
  agentMessageDeletion: true,
  viewport: { width: 1280, height: 720 },
  video: "on",
});

test("the verified owner confirms a NIP-09 delete for an agent message", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  const event = app.ownerAgentMessage;
  expect(event).toBeTruthy();
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.getByRole("button", { name: "More message actions" }).click();
  const action = page.getByRole("menuitem", {
    name: "Delete message",
    exact: true,
  });
  await expect(action).toBeVisible();
  const actionMenu = page.getByRole("menu");
  await opened(actionMenu);
  await page.screenshot({
    path: testInfo.outputPath("owned-agent-delete-menu.png"),
  });
  await action.click();

  const confirmation = page.getByRole("alertdialog", {
    name: "Delete message?",
  });
  await expect(confirmation).toBeVisible();
  await expect(
    confirmation.getByRole("heading", { name: "Delete message?" }),
  ).toBeVisible();
  await expect(confirmation).toContainText(
    "This requests removal of this message from Buzz’s relay.",
  );
  await expect(confirmation).toContainText("People may still have copies.");
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await confirmation.evaluate((dialog) =>
    Promise.all(
      dialog
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().endTime !== Infinity,
        )
        .map((animation) => animation.finished),
    ),
  );
  await expect
    .poll(() =>
      app.report.publications.filter(({ event: item }) => item.kind === 5),
    )
    .toHaveLength(0);
  await page.screenshot({
    path: testInfo.outputPath("owned-agent-delete-confirmation.png"),
  });

  await confirmation
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await expect(confirmation).toHaveCount(0);
  const deletion = app.report.publications.find(
    ({ event: item }) =>
      item.kind === 5 &&
      item.tags.some(([name, id]) => name === "e" && id === event.id),
  ).event;
  expect(deletion.pubkey).toBe(app.viewer);
  expect(deletion.tags.filter(([name]) => name !== "client-id")).toEqual([
    ["h", "alpha"],
    ["e", event.id],
    ["k", "9"],
  ]);
  expect(app.report.unexpected).toEqual([]);
});
