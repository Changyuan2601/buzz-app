import { test, expect } from "./fixture.mjs";

const earlier = "33333333-3333-4333-8333-333333333333";
test.use({
  productionBroker: true,
  channelIds: [earlier],
  channelNames: { [earlier]: "Earlier with Honey" },
  soloChannels: [earlier],
  ownSoloChannels: [earlier],
  historyCounts: { [earlier]: 1 },
  soloAgentNames: ["Owned Honey"],
});

test("search opens a new Solo chat with one of the viewer's agents", async ({
  page,
  app,
}, testInfo) => {
  await page.goto(app.origin);
  const scope = (name) => page.getByRole("tab", { name, exact: true });
  await scope("All").click();
  await expect(scope("All")).toHaveAttribute("aria-selected", "true");
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+k`);
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  await dialog.getByRole("combobox", { name: "Search Buzz" }).fill("honey");
  const choice = dialog
    .getByRole("group", { name: "Agents" })
    .getByRole("option", { name: /Owned Honey/ });
  await expect(choice).toContainText("New chat");
  // The earlier chat is still found by its name.
  await expect(
    dialog
      .getByRole("group", { name: "Channels" })
      .getByRole("option", { name: /Earlier with Honey/ }),
  ).toContainText("Chat");
  await page.screenshot({ path: testInfo.outputPath("search.png") });
  await choice.click();
  await expect(dialog).toHaveCount(0);
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await expect(composer).toBeFocused();
  // The new chat starts tagged with the chosen agent.
  const [agent] = app.soloAgents;
  await expect(
    page.getByRole("button", {
      name: `Remove mention ${agent.name} ${agent.pubkey}`,
      exact: true,
    }),
  ).toBeVisible();
  // Landing in a chat selects Solo, even from All.
  await expect(scope("Solo")).toHaveAttribute("aria-selected", "true");
  // This browser fixture cannot start Solo chats (it says so below the
  // composer). SoloDraft tests cover the first message.
  await page.screenshot({
    path: testInfo.outputPath("chat.png"),
    clip: { x: 0, y: 0, width: 1440, height: 905 },
  });
});
