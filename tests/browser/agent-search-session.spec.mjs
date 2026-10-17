import { test, expect } from "./fixture.mjs";

const earlier = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  channelIds: [earlier],
  channelNames: { [earlier]: "Earlier with Honey" },
  sessionChannels: [earlier],
  meChannels: [earlier],
  historyCounts: { [earlier]: 1 },
  meAgentNames: ["Owned Honey"],
});

test("search opens a new Solo session with one of the viewer's agents", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+k`);
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  await dialog.getByRole("combobox", { name: "Search Buzz" }).fill("honey");
  const choice = dialog
    .getByRole("group", { name: "Agents" })
    .getByRole("option", { name: /Owned Honey/ });
  await expect(choice).toContainText("New session");
  // The earlier session is still found by its name.
  await expect(
    dialog
      .getByRole("group", { name: "Channels" })
      .getByRole("option", { name: /Earlier with Honey/ }),
  ).toContainText("Session");
  await page.screenshot({ path: testInfo.outputPath("search.png") });
  await choice.click();
  await expect(dialog).toHaveCount(0);
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await expect(composer).toBeFocused();
  // The new chat starts tagged with the chosen agent.
  const [agent] = app.meAgents;
  await expect(
    page.getByRole("button", {
      name: `Remove mention ${agent.name} ${agent.pubkey}`,
      exact: true,
    }),
  ).toBeVisible();
  // This browser fixture cannot start Solo sessions (it says so below the
  // composer). NewSessionComposer tests cover the first message.
  await page.screenshot({
    path: testInfo.outputPath("session.png"),
    clip: { x: 0, y: 0, width: 1440, height: 905 },
  });
});
