import { test, expect } from "./fixture.mjs";
import { generateSecretKey, verifyEvent } from "nostr-tools";
import { newChat, openPage } from "./navigation.mjs";

const id = "33333333-3333-4333-8333-333333333333";
const destination = "55555555-5555-4555-8555-555555555555";
const other = "44444444-4444-4444-8444-444444444444";
// Real pointer/keyboard menu behavior, dialog focus and pane geometry require a browser.
test.use({
  pluginFixtures: true,
  productionBroker: true,
  channelIds: [id, other, destination],
  channelNames: { [id]: "Alpha", [other]: "Beta", [destination]: "Team" },
  soloChannels: [id, other],
  ownSoloChannels: [id, other],
  historyCounts: { [id]: 2, [other]: 1, [destination]: 0 },
});

test("chat row menus open Share with the chat's people and restore focus", async ({
  page,
  app,
}) => {
  const agents = ["Blossom", "Bubbles"].map((name) =>
    app.serveProfile(generateSecretKey(), { name, is_agent: true }),
  );
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (!filters.some((filter) => filter.kinds?.includes(39002)))
      return route.continue();
    const response = await route.fetch();
    const events = await response.json();
    await route.fulfill({
      json: events.map((event) =>
        event.kind === 39002 &&
        event.tags.some(([key, value]) => key === "d" && value === id)
          ? app.signRelay({
              ...event,
              tags: [
                ...event.tags,
                ...agents.map((agent) => ["p", agent.pubkey, "", "bot"]),
              ],
            })
          : event,
      ),
    });
  });
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await expect(row).toBeVisible();
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", {
    name: "Actions for Alpha",
    exact: true,
  });
  // Lifecycle items mount after each opening's permission read.
  const lifecycleReady = menu.getByRole("menuitem", {
    name: "Delete chat",
    exact: true,
  });
  await expect(lifecycleReady).toBeVisible();
  const actions = await menu.getByRole("menuitem").allTextContents();
  expect(actions).toContain("Share");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "New chat", exact: true }),
  ).toBeVisible();
  await expect(row).toBeFocused();
  await sidebar
    .getByRole("button", { name: "Actions for Alpha", exact: true })
    .click();
  await expect(lifecycleReady).toBeVisible();
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(actions);
  await page.keyboard.press("Escape");
  await row.focus();
  await row.press("Shift+F10");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Share chat",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "People or channel" }),
  ).toBeFocused();
  const individual = dialog.getByRole("region", { name: "Individual access" });
  await expect(individual.getByText("Blossom", { exact: true })).toBeVisible();
  await expect(individual.getByText("Bubbles", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
});

test.describe("Berd-style Solo project organization", () => {
  test.use({ soloAgentNames: ["Owned Honey"] });
  test("a project retains two chats and their exact tagged drafts", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await newChat(page);
    const sidebar = page.getByRole("navigation", {
      name: "Solo conversations",
    });
    // Stable identity: after reload an unread count joins the accessible label.
    const row = sidebar.locator(`[data-solo-channel-id="${id}"]`);
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
    await page.getByRole("menuitem", { name: "New workspace…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Workspace name" }).fill("Work");
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(sidebar.getByText("Saving workspace…")).not.toBeVisible();
    await expect(sidebar.getByRole("alert")).toHaveCount(0);
    const project = sidebar.getByRole("button", { name: "Work", exact: true });
    await expect(project).toBeVisible();
    await expect(project).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() => app.report.sidebarPublications?.length ?? 0)
      .toBe(1);
    await page.clock.install();
    await page.clock.runFor(1_100);
    await page.clock.resume();

    await newChat(page);
    for (const [before, choice, after] of [
      ["Add workspace", "Work", "Workspace: Work"],
      ["Workspace: Work", "No workspace", "Add workspace"],
    ]) {
      const trigger = page.getByRole("button", { name: before, exact: true });
      await trigger.focus();
      await trigger.press("Enter");
      const popup = page.getByRole("menu").filter({
        has: page.getByRole("menuitemradio", {
          name: "No workspace",
          exact: true,
        }),
      });
      const option = popup.getByRole("menuitemradio", {
        name: choice,
        exact: true,
      });
      await option.focus();
      await option.press("Enter");
      // Wait for popup teardown, when Base UI restores focus to the trigger.
      await expect(popup).toHaveCount(0);
      await expect
        .soft(page.getByRole("button", { name: after, exact: true }))
        .toBeFocused();
    }

    const beta = sidebar.getByRole("button", { name: "Beta", exact: true });
    await beta.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
    await page.getByRole("menuitem", { name: "Work", exact: true }).click();
    await expect
      .poll(() => app.report.sidebarPublications?.length ?? 0)
      .toBe(2);
    await expect(row).toBeVisible();
    await expect(beta).toBeVisible();
    // Filing is demonstrated by disclosure behavior, not child indentation.
    await project.click();
    await expect(row).not.toBeVisible();
    await expect(beta).not.toBeVisible();
    await project.click();
    await expect(row).toBeVisible();
    await expect(beta).toBeVisible();

    await sidebar.getByText("Alpha", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Workspace: Work", exact: true }),
    ).toBeVisible();
    app.soloAgentMessage(id, "Agent follow-up fixture");
    const [agent] = app.soloAgents;
    const tag = page.getByRole("button", {
      name: `Remove mention ${agent.name} ${agent.pubkey}`,
      exact: true,
    });
    await expect(tag).toHaveCount(0);
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Mention a member or agent" })
      .getByRole("button", {
        name: `${agent.name} ${agent.pubkey}`,
        exact: true,
      })
      .click();
    await expect(tag).toBeVisible();
    const composer = page.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    const agentMessage = page.getByText("Agent follow-up fixture", {
      exact: true,
    });
    await expect(agentMessage).toBeVisible();
    await composer.press("End");
    await page.keyboard.insertText("Remember the launch checklist");
    await composer.press("Enter");
    const publications = () =>
      app.report.publications.filter(({ event }) => event.kind === 9);
    await expect.poll(() => publications().length).toBe(1);
    const sent = publications()[0].event;
    expect(verifyEvent(sent)).toBe(true);
    expect(sent.tags.filter(([key]) => key === "p")).toEqual([
      ["p", agent.pubkey],
    ]);
    expect(sent.tags.filter(([key]) => key === "h")).toEqual([["h", id]]);
    const viewerMessage = page.locator(`[data-message-id="${sent.id}"]`);
    await expect(viewerMessage).toContainText("Remember the launch checklist");
    await expect(tag).toBeVisible();
    await composer.press("End");
    await page.keyboard.insertText("Keep this follow-up draft");
    await beta.click();
    await expect(composer).not.toContainText("Keep this follow-up draft");
    await sidebar.getByText("Alpha", { exact: true }).click();
    await expect(composer).toContainText("Keep this follow-up draft");
    await expect(tag).toBeVisible();
    await page.reload();
    await expect(composer).toContainText("Keep this follow-up draft");
    await expect(tag).toBeVisible();
    await expect(project).toHaveAttribute("aria-expanded", "true");
    await expect(row).toBeVisible();
    await expect(beta).toBeVisible();
    await expect(agentMessage).toBeVisible();
  });
});

// A real pointer owns the activation distance and hit testing; the saved move
// itself is the row menu's.
test("dragging a chat between a project and Chats saves and reloads like Move to", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const chat = (name) => sidebar.getByRole("button", { name, exact: true });
  const inProject = (name) =>
    sidebar
      .locator("[data-project]")
      .getByRole("button", { name, exact: true });
  const published = async (count) => {
    await expect
      .poll(() => app.report.sidebarPublications?.length ?? 0)
      .toBe(count);
    // Each replaceable preference write needs a later second.
    await page.clock.runFor(1_100);
    return app.report.sidebarPublications.at(-1).blob.value.assignments;
  };
  // Hold a real pointer drag over a section header, then release it.
  async function drag(name, section, target = true) {
    const from = await chat(name).boundingBox();
    const to = await chat(section).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 8,
    });
    await expect(sidebar.locator("[data-channel-dragging]")).toBeVisible();
    await expect(sidebar.locator("[data-drop-target]")).toHaveCount(
      target ? 1 : 0,
    );
    await page.mouse.up();
    await expect(sidebar.locator("[data-channel-dragging]")).toHaveCount(0);
  }
  await page.clock.install();
  await chat("Alpha").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
  await page.getByRole("menuitem", { name: "New workspace…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Workspace name" }).fill("Work");
  await dialog.getByRole("button", { name: "Create and move" }).click();
  await expect(inProject("Alpha")).toBeVisible();
  const work = (await published(1))[id];

  await drag("Alpha", "Chats");
  await expect(chat("Alpha")).toBeFocused();
  await expect(inProject("Alpha")).toHaveCount(0);
  expect(await published(2)).toEqual({});

  await drag("Beta", "Work");
  await expect(inProject("Beta")).toBeFocused();
  expect(await published(3)).toEqual({ [other]: work });

  // Dropping back on the chat's own section is not a move.
  await drag("Beta", "Work", false);
  await expect(inProject("Beta")).toBeVisible();
  expect(app.report.sidebarPublications).toHaveLength(3);

  await page.reload();
  await expect(inProject("Beta")).toBeVisible();
  await expect(chat("Alpha")).toBeVisible();
  await expect(inProject("Alpha")).toHaveCount(0);
});

// App wiring proof: grants and the normal link publication preserve Solo placement,
// identity/history and navigation, with a held signed grant readback barrier.
test("Share grants access and posts a link without promoting or moving the Solo chat", async ({
  page,
  app,
}) => {
  await page.clock.install();
  const person = app.serveProfile(generateSecretKey(), { name: "Aria" });
  const grants = [];
  const evidence = [];
  let signalReadback;
  const requestedReadback = new Promise((resolve) => {
    signalReadback = resolve;
  });
  let releaseReadback;
  const heldReadback = new Promise((resolve) => {
    releaseReadback = resolve;
  });
  let readbackHeld = false;
  let rosterTime = Math.floor(Date.now() / 1000);
  await page.route("**/api/relay/**/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (
      filters.some(
        (filter) => filter.kinds?.includes(0) && filter.search === "Aria",
      )
    ) {
      return route.fulfill({ json: [person] });
    }
    const response = await route.fetch();
    const events = await response.json();
    if (filters.some((filter) => filter.kinds?.includes(39002))) {
      if (
        !readbackHeld &&
        grants.length &&
        filters.some(
          (filter) =>
            filter.kinds?.includes(39002) &&
            filter["#d"]?.includes(id) &&
            filter.consistency === "strong",
        ) &&
        events.some(
          (event) =>
            event.kind === 39002 &&
            event.tags.some(([key, value]) => key === "d" && value === id),
        )
      ) {
        readbackHeld = true;
        evidence.push("readback-requested");
        signalReadback();
        await heldReadback;
        evidence.push("readback-released");
      }
      return route.fulfill({
        json: events.map((event) => {
          if (
            event.kind !== 39002 ||
            event.tags.find(([key]) => key === "d")?.[1] !== id
          )
            return event;
          return app.signRelay({
            kind: 39002,
            content: "",
            created_at: ++rosterTime,
            tags: [
              ...event.tags,
              ...grants.map((grant) => [
                "p",
                grant.tags.find(([key]) => key === "p")[1],
                "",
                "member",
              ]),
            ],
          });
        }),
      });
    }
    return route.fulfill({ response });
  });
  await page.route("**/api/relay/**/publish", async (route) => {
    const event = route.request().postDataJSON();
    if (event.kind === 9) evidence.push("link");
    if (event.kind !== 9000) return route.continue();
    expect(verifyEvent(event)).toBe(true);
    expect(event.pubkey).toBe(app.viewer);
    grants.push(event);
    evidence.push("grant");
    await route.fulfill({ json: { accepted: true, event_id: event.id } });
  });
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share chat" });
  const search = dialog.getByRole("combobox", { name: "People or channel" });
  // Text entry starts after the menu-to-dialog transition and focus handoff.
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  await search.click();
  await expect(search).toBeFocused();
  await search.fill("Aria");
  await expect(search).toHaveValue("Aria");
  await page.getByRole("option", { name: /Aria/ }).click();
  await search.fill("Team");
  await page.getByRole("option", { name: "Team", exact: true }).click();
  const primary = dialog.getByRole("button", {
    name: "Share",
    exact: true,
  });
  const copy = dialog.getByRole("button", { name: "Copy link", exact: true });
  const convert = dialog.getByRole("button", {
    name: "Convert to channel",
    exact: true,
  });
  // The conversion action leads Copy/Share. At a narrow width with enlarged text
  // the footer actions wrap; real flex wrapping, Tab order and hit testing are
  // invisible to mounted DOM tests.
  await page.setViewportSize({ width: 390, height: 850 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  const actions = dialog.locator(".buzz-dialog-actions");
  await expect
    .poll(() =>
      actions.evaluate((footer) => {
        const widest = Math.max(
          ...[...footer.querySelectorAll("button")].map(
            (button) => button.getBoundingClientRect().width,
          ),
        );
        // Include the shared focus-ring inset around an oversized action.
        const style = getComputedStyle(footer);
        const inset =
          parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        return (
          footer.scrollWidth - Math.max(footer.clientWidth, widest + inset)
        );
      }),
    )
    .toBeLessThanOrEqual(1);
  await expect
    .poll(async () => {
      const copied = await copy.boundingBox();
      const shared = await primary.boundingBox();
      return shared.y >= copied.y + copied.height;
    })
    .toBe(true);
  // Focus the preceding body control, then traverse every wrapped action.
  await search.focus();
  for (const action of [convert, copy, primary]) {
    for (
      let step = 0;
      !(await action.evaluate((el) => el === document.activeElement));
      step++
    ) {
      expect(step).toBeLessThan(12);
      await page.keyboard.press("Tab");
      await expect
        .poll(() =>
          page.evaluate(() =>
            document.activeElement?.hasAttribute("data-base-ui-focus-guard"),
          ),
        )
        .toBe(false);
    }
    // Convert alone exceeds the row at 2x text; its ends are tested below.
    await expect(action).toBeInViewport(
      action === convert ? undefined : { ratio: 1 },
    );
    await expect
      .poll(() =>
        action.evaluate((element) => {
          const r = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          );
        }),
      )
      .toBe(true);
  }
  // The shared footer's single-action overflow remains scrollable at both
  // ends. Use pointer wheel input, not scrollLeft or scrollIntoView.
  await convert.hover();
  await page.mouse.wheel(600, 0);
  await expect
    .poll(() =>
      convert.evaluate((button) => {
        const footer = button.closest("footer").getBoundingClientRect();
        return button.getBoundingClientRect().right <= footer.right + 1;
      }),
    )
    .toBe(true);
  await page.mouse.wheel(-600, 0);
  await expect
    .poll(() =>
      convert.evaluate((button) => {
        const footer = button.closest("footer").getBoundingClientRect();
        return button.getBoundingClientRect().left >= footer.left - 1;
      }),
    )
    .toBe(true);
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await page.setViewportSize({ width: 1280, height: 850 });
  const hint = page.getByRole("tooltip").filter({
    hasText: "Sharing grants access and posts a link in the selected channel.",
  });
  await primary.hover();
  await expect(hint).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(hint).not.toBeVisible();
  await copy.focus();
  await page.keyboard.press("Tab");
  await expect(primary).toBeFocused();
  await expect(hint).toBeVisible();
  await expect(primary).toHaveAccessibleDescription(
    "Sharing grants access and posts a link in the selected channel.",
  );
  // Tooltip dismissal consumes only its own Escape, not the enclosing modal.
  await page.keyboard.press("Escape");
  await expect(hint).not.toBeVisible();
  await expect(dialog).toBeVisible();
  // Hold the page clock so the held readback cannot reach its read deadline.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  try {
    await page.keyboard.press("Enter");
    await requestedReadback;
    await expect(dialog).toBeVisible();
    await expect(primary).toHaveAttribute("aria-busy", "true");
    await expect(
      dialog.getByRole("combobox", { name: "People or channel" }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeDisabled();
    expect(evidence).toEqual(["grant", "readback-requested"]);
    expect(
      app.report.publications.filter(({ event }) => event.kind === 9),
    ).toHaveLength(0);
    releaseReadback();
    await page.clock.resume();
    await expect(dialog).not.toBeVisible();
    expect(evidence).toEqual([
      "grant",
      "readback-requested",
      "readback-released",
      "link",
    ]);
  } finally {
    releaseReadback();
    await page.clock.resume();
  }
  await expect(row).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  expect(grants).toHaveLength(1);
  expect(grants[0].tags).toContainEqual(["h", id]);
  expect(grants[0].tags).toContainEqual(["p", person.pubkey]);
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  expect(
    (app.report.sidebarPublications ?? []).filter((entry) =>
      entry.coordinate.startsWith("buzz-me-kit"),
    ),
  ).toHaveLength(0);
  const links = app.report.publications.filter(({ event }) => event.kind === 9);
  expect(links).toHaveLength(1);
  expect(links[0].event.tags).toContainEqual(["h", destination]);
  expect(links[0].event.tags.filter(([key]) => key === "p")).toHaveLength(0);
  expect(links[0].event.content).toBe(
    `[Session: 33333333](buzz://channel/${id})`,
  );
});

// App composition boundary: signed metadata switches Messages discoverability
// without a route handoff, a new conversation, or a Solo preference write.
test("explicit conversion moves the same conversation from Solo to Messages and keeps history", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await newChat(page);
  const sidebar = page.getByRole("navigation", {
    name: "Solo conversations",
  });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await row.focus();
  await row.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Convert to channel", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Convert to channel",
    exact: true,
  });
  await expect(
    dialog.getByRole("radio", { name: "Private", exact: true }),
  ).toBeChecked();
  const publicChoice = dialog.getByRole("radio", {
    name: "Public",
    exact: true,
  });
  await expect(publicChoice).toHaveAccessibleDescription(
    "Everyone in this community will be able to view this channel’s full history.",
  );
  const convert = dialog.getByRole("button", {
    name: "Convert to channel",
    exact: true,
  });
  await expect(convert).toBeEnabled();
  await publicChoice.click();
  await expect(publicChoice).toBeChecked();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await convert.click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("Converted to channel.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Channel actions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator(`[data-solo-channel-id="${id}"]`)).toHaveCount(
    0,
  );
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  expect(app.report.detailsPublications).toHaveLength(1);
  const event = app.report.detailsPublications[0];
  expect(verifyEvent(event)).toBe(true);
  expect(event.kind).toBe(9002);
  expect(event.tags).toEqual([
    ["h", id],
    ["name", "Alpha"],
    ["about", ""],
    ["visibility", "open"],
    ["t", ""],
  ]);
  // An unfiled chat has no project assignment to remove.
  expect(
    (app.report.sidebarPublications ?? []).filter((entry) =>
      entry.coordinate.startsWith("buzz-me-kit"),
    ),
  ).toHaveLength(0);
  expect(
    app.report.publications.filter(({ event }) =>
      [9, 9000, 9007, 30315].includes(event.kind),
    ),
  ).toHaveLength(0);
  await openPage(page, "Messages");
  const messages = page.getByRole("button", { name: "Alpha", exact: true });
  await expect(messages).toBeVisible();
  await messages.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await newChat(page);
  await expect(row).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
});

// Browser-only: native modal focus handoff to a replacement Messages header.
// The held metadata/completion ordering matrix lives in the mounted page test.
test("Messages conversion restores focus after its chat header is replaced", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await expect
    .poll(() =>
      page.evaluate(() => window.fixtureNavigation?.snapshot().status),
    )
    .toBe("opened");
  expect(
    await page.evaluate((target) => window.fixtureNavigation.open(target), {
      version: 1,
      kind: "conversation",
      channelId: id,
      scope: { viewer: app.viewer, communityOrigin: "https://primary.example" },
    }),
  ).toEqual({ status: "opened" });
  const trigger = page.getByRole("button", { name: "Share", exact: true });
  await trigger.click();
  const share = page.getByRole("dialog", { name: "Share chat" });
  await share.getByRole("button", { name: "Convert to channel" }).click();
  const dialog = page.getByRole("dialog", { name: "Convert to channel" });
  await expect(
    dialog.getByRole("button", { name: "Convert to channel" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await share.getByRole("button", { name: "Convert to channel" }).click();
  const confirm = dialog.getByRole("button", { name: "Convert to channel" });
  await expect(confirm).toBeEnabled();
  await confirm.focus();
  await confirm.press("Enter");
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText("Converted to channel.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await expect(trigger).toHaveCount(0);
  expect(app.report.detailsPublications).toHaveLength(1);
  expect(app.report.detailsPublications[0].tags).toEqual([
    ["h", id],
    ["name", "Alpha"],
    ["about", ""],
    ["t", ""],
  ]);
});

test("unified chat naming and lifetime retain host focus and save only explicit changes", async ({
  page,
  app,
}) => {
  const readbacks = [];
  await page.route("**/api/relay/**/query", async (route) => {
    const response = await route.fetch();
    const events = await response.json();
    readbacks.push(
      ...events.filter(
        (event) =>
          event.kind === 39000 &&
          event.tags.some(([key, value]) => key === "d" && value === id),
      ),
    );
    await route.fulfill({ response });
  });
  await page.goto(app.origin);
  await newChat(page);
  const actions = page.getByRole("button", {
    name: "Chat settings",
    exact: true,
  });
  await actions.click();
  const settings = page.getByRole("dialog", {
    name: "Chat settings",
    exact: true,
  });
  const canvas = settings.getByRole("textbox", { name: /^Instructions/ });
  await expect(canvas).toBeVisible();
  await canvas.fill("Keep this local draft");
  const draftName = settings.getByRole("textbox", {
    name: "Chat name (optional)",
    exact: true,
  });
  await draftName.fill("Make contrast meet accessibility standards");
  const draftTemporary = settings.getByRole("radio", {
    name: "Temporary",
    exact: true,
  });
  await settings
    .locator("label")
    .filter({
      has: page.getByRole("radio", { name: "Temporary", exact: true }),
    })
    .click();
  await expect(draftTemporary).toBeChecked();
  await settings.getByRole("button", { name: "Increase duration" }).click();
  await expect(draftTemporary).toHaveAccessibleDescription(
    "Archives after 2 weeks without activity.",
  );
  await settings.getByRole("button", { name: "Decrease duration" }).click();
  await expect(draftTemporary).toHaveAccessibleDescription(
    "Archives after 7 days without activity.",
  );
  const draftSave = settings.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  // Real narrow, enlarged-text layout: Tab must expose Save without programmatic
  // focus/scroll or resetting the text size to mask clipping.
  await page.setViewportSize({ width: 390, height: 850 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  await draftName.focus();
  let tabs = 0;
  while (
    tabs < 20 &&
    !(await draftSave.evaluate((el) => el === document.activeElement))
  ) {
    await page.keyboard.press("Tab");
    tabs += 1;
  }
  await expect(draftSave).toBeFocused();
  await expect(draftSave).toBeInViewport();
  await expect
    .poll(() =>
      draftSave.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return el.contains(
          document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          ),
        );
      }),
    )
    .toBe(true);
  // The rest of the journey needs the desktop sidebar.
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await page.setViewportSize({ width: 1280, height: 850 });
  await draftSave.focus();
  await expect(draftSave).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(settings).not.toBeVisible();
  await expect(actions).toBeFocused();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await actions.click();
  await expect(canvas).toHaveValue("Keep this local draft");
  await expect(draftName).toHaveValue(
    "Make contrast meet accessibility standards",
  );
  await expect(draftTemporary).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();

  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await actions.click();
  const lifetime = page.getByRole("dialog", {
    name: "Chat settings",
    exact: true,
  });
  const save = lifetime.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  await expect(save).toBeEnabled();
  await expect(
    lifetime.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  const ongoing = lifetime.getByRole("radio", { name: "Ongoing", exact: true });
  const temporary = lifetime.getByRole("radio", {
    name: "Temporary",
    exact: true,
  });
  await ongoing.focus();
  await page.keyboard.press("ArrowDown");
  await expect(temporary).toBeChecked();
  await lifetime.getByRole("button", { name: "Increase duration" }).click();
  await save.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(lifetime).not.toBeVisible();
  await expect(actions).toBeFocused();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await row.focus();
  await row.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Chat settings…", exact: true })
    .click();
  await expect(save).toBeEnabled();
  await expect(ongoing).toBeChecked();
  await lifetime
    .locator("label")
    .filter({
      has: page.getByRole("radio", { name: "Temporary", exact: true }),
    })
    .click();
  await lifetime.getByRole("button", { name: "Increase duration" }).click();
  await lifetime
    .getByRole("textbox", { name: "Chat name", exact: true })
    .fill("Make contrast meet accessibility standards");
  await save.click();
  await expect(lifetime).not.toBeVisible();
  const renamedRow = sidebar.getByRole("button", {
    name: "Make contrast meet accessibility standards",
    exact: true,
  });
  await expect(renamedRow).toBeFocused();
  await expect(renamedRow).toBeVisible();
  expect(app.report.detailsPublications).toHaveLength(1);
  const event = app.report.detailsPublications[0];
  expect(verifyEvent(event)).toBe(true);
  expect(event.kind).toBe(9002);
  expect(event.tags).toEqual([
    ["h", id],
    ["name", "Make contrast meet accessibility standards"],
    ["about", ""],
    ["ttl", "1209600"],
    ["t", "buzz.solo"],
    ["t", "buzz.session.named"],
  ]);
  const saved = readbacks.find((entry) =>
    entry.tags.some(([key, value]) => key === "ttl" && value === "1209600"),
  );
  expect(saved).toBeDefined();
  expect(verifyEvent(saved)).toBe(true);
  expect(saved.tags).toContainEqual(["private"]);
  expect(saved.tags.filter(([key]) => key === "t")).toEqual([
    ["t", "stream"],
    ["t", "buzz.solo"],
    ["t", "buzz.session.named"],
  ]);
  expect(saved.tags).not.toContainEqual(["public"]);
  expect(
    (app.report.sidebarPublications ?? []).filter((entry) =>
      entry.coordinate.startsWith("buzz-me-kit"),
    ),
  ).toHaveLength(0);
  expect(
    app.report.publications.filter(({ event }) =>
      [9, 9000, 9007, 30315, 40100].includes(event.kind),
    ),
  ).toHaveLength(0);
  await renamedRow.focus();
  await renamedRow.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Chat settings…", exact: true })
    .click();
  await expect(save).toBeEnabled();
  await expect(temporary).toHaveAccessibleDescription(
    "Archives after 2 weeks without activity.",
  );
  await page.keyboard.press("Escape");

  await expect(renamedRow).toBeFocused();
});

// Native caret placement after focus handoffs and popup picks needs a browser.
test.describe("Solo composer caret", () => {
  test.use({ soloAgentNames: ["Owned Honey", "Owned Brain"] });
  test("a returning draft resumes at its end and picked agents join the leading tags", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await newChat(page);
    const composer = page.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    const caret = () =>
      composer.evaluate((el) => [el.value, el.selectionStart, el.selectionEnd]);
    const [honey, brain] = app.soloAgents;
    const pick = async (agent) => {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Mention a member or agent" })
        .getByRole("button", {
          name: `${agent.name} ${agent.pubkey}`,
          exact: true,
        })
        .click();
    };
    await expect(composer).toHaveText(`@${honey.name} `);
    await page.keyboard.insertText("first");
    const sidebar = page.getByRole("navigation", {
      name: "Solo conversations",
    });
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
    await expect(composer).toHaveText("");
    await composer.click();
    await page.keyboard.insertText("alpha draft");
    // Returning focuses the restored draft at its end, not before its tag.
    await newChat(page);
    await expect.poll(caret).toEqual([`@${honey.name} first`, 18, 18]);

    // The picker files the agent after the leading tag; typing continues
    // where the caret was.
    await pick(brain);
    const tagged = `@${honey.name} @${brain.name} first`;
    await expect.poll(caret).toEqual([tagged, tagged.length, tagged.length]);
    await page.keyboard.insertText(" again");
    await expect(composer).toHaveText(`${tagged} again`);

    // Untagged prose gets its tag in front, even from a blurred composer.
    await sidebar.getByRole("button", { name: "Alpha", exact: true }).click();
    await expect(composer).toHaveText("alpha draft");
    await composer.blur();
    await pick(honey);
    const alpha = `@${honey.name} alpha draft`;
    await expect.poll(caret).toEqual([alpha, alpha.length, alpha.length]);
    // Undo removes the tag and returns to the prose caret, not the front.
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(caret).toEqual(["alpha draft", 11, 11]);
    await page.keyboard.insertText("!");
    await expect(composer).toHaveText("alpha draft!");
  });
});

// Real :focus-visible matching on a focused, briefly non-editable editor needs a
// browser. Solo admission disables the editor while its membership refreshes.
test.describe("Solo send focus", () => {
  test.use({ soloAgentNames: ["Owned Honey"] });
  test("sending keeps the keyboard focus ring off the briefly disabled editor", async ({
    page,
    app,
  }) => {
    let hold = false;
    let held = false;
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    await page.route("**/api/relay/**/query", async (route) => {
      const filters = route.request().postDataJSON();
      if (!hold || !filters.some((filter) => filter.kinds?.includes(39002)))
        return route.continue();
      held = true;
      await released;
      await route.continue().catch(() => {});
    });
    await page.goto(app.origin);
    await page
      .getByRole("navigation", { name: "Solo conversations" })
      .getByRole("button", { name: "Alpha", exact: true })
      .click();
    const [agent] = app.soloAgents;
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Mention a member or agent" })
      .getByRole("button", {
        name: `${agent.name} ${agent.pubkey}`,
        exact: true,
      })
      .click();
    const composer = page.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    // End is caret navigation, so the app's keyboard focus treatment is live.
    await composer.press("End");
    await page.keyboard.insertText("No ring while sending");
    await expect(page.locator("html")).toHaveAttribute(
      "data-keyboard-navigation",
      "",
    );
    hold = true;
    try {
      await composer.press("Enter");
      await expect.poll(() => held).toBe(true);
      await expect(composer).toHaveAttribute("aria-disabled", "true");
      await expect(composer).toBeFocused();
      await expect(composer).toHaveCSS("outline-style", "none");
    } finally {
      hold = false;
      release();
    }
    const publications = () =>
      app.report.publications.filter(({ event }) => event.kind === 9);
    await expect.poll(() => publications().length).toBe(1);
    await expect(composer).not.toHaveAttribute("aria-disabled");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveCSS("outline-style", "none");
  });
});
