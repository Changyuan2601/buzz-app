import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import { chooseConversationTab } from "./conversation-tabs.mjs";
import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";
const id = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
test.use({
  productionBroker: true,
  channelIds: [id, other, "gamma"],
  channelNames: { [id]: "Alpha", [other]: "Beta", gamma: "Gamma" },
  sessionChannels: [id, other],
  meChannels: [id, other],
  historyCounts: { [id]: 2, [other]: 1, gamma: 1 },
});
// Verifies shell routing, actual hover/focus and retained drafts across the real panel host.
test("Me Activity opens locally, restores per conversation and retires on plugin disable", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await composer.fill("Keep my Me draft");
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  const key = generateSecretKey();
  app.observer(
    {
      kind: "turn_liveness",
      seq: 1,
      timestamp: new Date().toISOString(),
      channelId: id,
      sessionId: "S",
      turnId: "me-activity",
    },
    key,
  );
  const trigger = page.getByRole("button", {
    name: /^Activity: .+ working$/,
  });
  await trigger.hover();
  const preview = page.getByRole("dialog", { name: "Working now" });
  await expect(preview).toBeVisible();
  await trigger.click();
  const panel = page.getByRole("region", {
    name: "Agent activity",
    exact: true,
  });
  await expect(panel).toBeVisible();
  await expect(panel.locator("code").first()).toHaveText(getPublicKey(key));
  await expect(preview).toBeHidden();
  await expect(sidebar).toBeVisible();
  await expect(composer).toHaveText("Keep my Me draft");
  await page
    .getByRole("button", { name: "Close Agent Activity tab", exact: true })
    .click();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(panel).toBeVisible();
  await sidebar.getByRole("button", { name: "Beta", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(composer).toHaveText("Keep my Me draft");
  await page
    .getByRole("button", { name: "Close Agent Activity tab", exact: true })
    .click();
  // Restored panels no longer retain the original trigger element.
  await trigger.focus();
  await page.mouse.move(0, 0);
  await page.keyboard.press("ArrowDown");
  await expect(preview).toBeVisible();
  await expect(preview).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(preview).toBeFocused();
  await page.keyboard.press("Tab");
  const conversationAction = preview.getByRole("button", {
    name: /^Open conversation for/,
  });
  await expect(conversationAction).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(sidebar).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await openPage(page, "Me");
  await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
  await trigger.press("Enter");
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "Your profile", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Plugins", exact: true }).click();
  await page
    .getByRole("switch", { name: "Enable Agent Activity", exact: true })
    .click();
  await openPage(page, "Me");
  await expect(panel).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Agent Activity", exact: true }),
  ).toHaveCount(0);
});
// Two browser-mounted readers must keep native drafts and signed sends scoped.
test("Me tabs retain drafts and send to their own conversation with the Messages tool picker", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  await page
    .getByRole("navigation", { name: "Me conversations" })
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  const mainDraft = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await mainDraft.fill("Main draft stays here");
  const split = page.getByRole("button", {
    name: "Toggle tab pane",
    exact: true,
  });
  await split.click();
  await chooseConversationTab(page, "Gamma", { add: false });
  const workspace = page.locator("[data-panel-workspace]");
  const tabComposer = workspace.getByRole("textbox", {
    name: "Message #Gamma",
    exact: true,
  });
  await tabComposer.fill("From the Me secondary tab");
  await split.click();
  await expect(workspace).toBeHidden();
  await split.click();
  await expect(tabComposer).toHaveText("From the Me secondary tab");
  await workspace.getByRole("button", { name: "Add tab", exact: true }).click();
  const picker = workspace.getByRole("region", { name: "Choose a tab" });
  await expect(
    picker.getByRole("tab", { name: "DMs", exact: true }),
  ).toBeVisible();
  await picker.getByRole("tab", { name: "Tools", exact: true }).click();
  await expect(
    picker.getByRole("searchbox", { name: "Find a channel tool" }),
  ).toBeVisible();
  // Browser hosts deliberately do not advertise a native Terminal.
  await expect(
    picker.getByRole("button", { name: "Terminal", exact: true }),
  ).toHaveCount(0);
  await workspace.getByRole("tab", { name: "Gamma", exact: true }).click();
  await tabComposer.press("Enter");
  await expect
    .poll(() =>
      app.report.publications.some(
        ({ event }) =>
          event.kind === 9 &&
          event.content === "From the Me secondary tab" &&
          event.tags.some(([key, value]) => key === "h" && value === "gamma"),
      ),
    )
    .toBe(true);
  await expect(mainDraft).toHaveText("Main draft stays here");
});

// Real secondary PersonalComposer -> signing boundary, not a mocked prop assertion.
// Owner-authored inventory supplies choices; signed membership remains authority.
test.describe("personal secondary recipients", () => {
  test.use({
    sessionChannels: [id],
    meAgentNames: ["Owned Honey", "Owned Brain"],
    meOutsideAgentNames: ["Outside Agent"],
  });
  test("Me tab signs only explicit owned recipients and rejects an outside identity", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Me");
    await page
      .getByRole("navigation", { name: "Me conversations" })
      .getByRole("button", { name: "Alpha", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Toggle tab pane", exact: true })
      .click();
    await chooseConversationTab(page, "Beta", { add: false });
    const workspace = page.locator("[data-panel-workspace]");
    const composer = workspace.getByRole("textbox", {
      name: "Message #Beta",
      exact: true,
    });
    const [honey, brain, outsider] = app.meAgents;
    await workspace
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Mention a member or agent",
    });
    await expect(
      picker.getByRole("button", {
        name: `${brain.name} ${brain.pubkey}`,
        exact: true,
      }),
    ).toBeVisible();
    await picker
      .getByRole("button", {
        name: `${honey.name} ${honey.pubkey}`,
        exact: true,
      })
      .click();
    await composer.press("End");
    await page.keyboard.insertText("Only this agent from Beta");
    await composer.press("Enter");
    const publications = () =>
      app.report.publications.filter(({ event }) => event.kind === 9);
    await expect.poll(() => publications().length).toBe(1);
    const sent = publications()[0].event;
    expect(verifyEvent(sent)).toBe(true);
    expect(sent.tags.filter(([key]) => key === "h")).toEqual([["h", other]]);
    expect(sent.tags.filter(([key]) => key === "p")).toEqual([
      ["p", honey.pubkey],
    ]);
    // Successful personal sends keep explicit mention chips for follow-up turns.
    await expect(composer).toHaveText(`@${honey.name} `);
    // A draft from the ordinary Messages reader may retain a channel member
    // who isn't in the owner's inventory. Me must reject that explicit recipient.
    await composer.fill("");
    await openPage(page, "Messages");
    await page.locator('[data-channel-id="gamma"]').click();
    await page
      .getByRole("button", { name: "Toggle tab pane", exact: true })
      .click();
    await chooseConversationTab(page, "Beta", { add: false });
    await workspace
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Mention a member or agent" })
      .getByRole("button", {
        name: `${outsider.name} ${outsider.pubkey}`,
        exact: true,
      })
      .click();
    const ordinaryComposer = page.getByRole("textbox", {
      name: "Message #Beta",
      exact: true,
    });
    await ordinaryComposer.press("End");
    await page.keyboard.insertText("Not mine");
    await openPage(page, "Me");
    await page
      .getByRole("navigation", { name: "Me conversations" })
      .getByRole("button", { name: "Alpha", exact: true })
      .click();
    await expect(composer).toContainText("@Outside Agent");
    await composer.press("Enter");
    await expect(
      workspace.getByText(
        "Only your available agents can be mentioned in Me. Remove the unavailable recipient and retry.",
        { exact: true },
      ),
    ).toBeVisible();
    // Error rendering is the completion barrier: rejected admission never reaches outbox.
    expect(publications()).toHaveLength(1);
    await expect(composer).toContainText("Not mine");
  });
});
