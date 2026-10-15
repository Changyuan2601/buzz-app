import { checkDurationLayout } from "./duration-layout.mjs";
import { test, expect } from "./fixture.mjs";
import { generateSecretKey, verifyEvent } from "nostr-tools";
import { openPage } from "./navigation.mjs";

const id = "33333333-3333-4333-8333-333333333333";
const destination = "55555555-5555-4555-8555-555555555555";
const other = "44444444-4444-4444-8444-444444444444";
// Real pointer/keyboard menu behavior, dialog focus and pane geometry require a browser.
test.use({
  pluginFixtures: true,
  productionBroker: true,
  channelIds: [id, other, destination],
  channelNames: { [id]: "Alpha", [other]: "Beta", [destination]: "Team" },
  sessionChannels: [id, other],
  meChannels: [id, other],
  historyCounts: { [id]: 2, [other]: 1, [destination]: 0 },
});

test("Berd centers new and existing chats and keeps context actions usable", async ({
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
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await expect(row).toBeVisible();
  const composer = page.getByRole("textbox", {
    name: "Message your agents",
    exact: true,
  });
  await expect(composer).toBeVisible();
  // A fresh chat uses the same separate context row as a saved chat.
  for (const width of [1440, 700]) {
    await page.setViewportSize({ width, height: 950 });
    const send = page.getByRole("button", {
      name: "Send message",
      exact: true,
    });
    const assistant = page.getByRole("button", {
      name: "Choose follow-up assistant",
      exact: true,
    });
    const project = page.getByRole("button", {
      name: "Project: No project",
      exact: true,
    });
    await expect
      .poll(async () => {
        const [sendBox, assistantBox, projectBox] = await Promise.all([
          send.boundingBox(),
          assistant.boundingBox(),
          project.boundingBox(),
        ]);
        return (
          !!sendBox &&
          !!assistantBox &&
          !!projectBox &&
          assistantBox.y >= sendBox.y + sendBox.height &&
          projectBox.y >= sendBox.y + sendBox.height &&
          sendBox.x > assistantBox.x
        );
      })
      .toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 950 });
  for (const scale of [1, 2]) {
    await page.evaluate(
      (value) =>
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(value),
        ),
      scale,
    );
    await expect
      .poll(() =>
        composer.evaluate((el) => {
          const form = el.closest("form").getBoundingClientRect();
          const pane = el.closest("section").getBoundingClientRect();
          const max =
            52 *
            Number.parseFloat(
              getComputedStyle(document.documentElement).fontSize,
            );
          return (
            form.width <= max &&
            form.left >= pane.left &&
            form.right <= pane.right &&
            Math.abs(
              (form.left + form.right) / 2 - (pane.left + pane.right) / 2,
            ) < 1
          );
        }),
      )
      .toBe(true);
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", {
    name: "Actions for Alpha",
    exact: true,
  });
  await expect(menu).toBeVisible();
  const actions = await menu.getByRole("menuitem").allTextContents();
  expect(actions).toContain("Share…");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "New chat", exact: true }),
  ).toBeVisible();
  await expect(row).toBeFocused();
  await sidebar
    .getByRole("button", { name: "Actions for Alpha", exact: true })
    .click();
  await expect(menu).toBeVisible();
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(actions);
  await page.keyboard.press("Escape");
  await row.focus();
  await row.press("Shift+F10");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Share…", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Share session",
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
    dialog.getByRole("button", { name: /Other access/ }),
  ).toHaveCount(0);
  await expect(
    dialog.getByText(/^The original sharing destination/),
  ).toHaveCount(0);
  await expect(
    dialog.getByText("Session participants", { exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Done", exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("me-share.png") });
  await page.keyboard.press("Escape");
  await expect(row).toBeFocused();
  await row.click();
  await expect(
    page.getByRole("heading", { name: "Alpha", exact: true }),
  ).toBeVisible();
  for (const scale of [1, 2]) {
    await page.evaluate(
      (value) =>
        document.documentElement.style.setProperty(
          "--buzz-text-scale",
          String(value),
        ),
      scale,
    );
    await expect
      .poll(() =>
        composer.evaluate((el) => {
          const pane = el
            .closest("[data-attachment-drop-zone]")
            .getBoundingClientRect();
          return el.closest("form").getBoundingClientRect().width / pane.width;
        }),
      )
      .toBeLessThanOrEqual(0.95);
    await expect
      .poll(() =>
        composer.evaluate((el) => {
          const pane = el
            .closest("[data-attachment-drop-zone]")
            .getBoundingClientRect();
          return el.closest("form").getBoundingClientRect().width / pane.width;
        }),
      )
      .toBeGreaterThan(0.65);
    await expect(composer).toBeInViewport();
  }
  await page.screenshot({ path: test.info().outputPath("me-full-width.png") });
});

test.describe("Berd-style Me organization", () => {
  test.use({ meAgentNames: ["Owned Honey"] });
  test("a project holds two chats and remembers each chat's assistant", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await openPage(page, "Me");
    const sidebar = page.getByRole("navigation", {
      name: "Solo conversations",
    });
    const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Move to", exact: true }).hover();
    await page.getByRole("menuitem", { name: "New project…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Project name" }).fill("Work");
    await dialog.getByRole("button", { name: "Create and move" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(sidebar.getByText("Saving project…")).not.toBeVisible();
    await expect(sidebar.getByRole("alert")).toHaveCount(0);
    await expect(sidebar.getByText("Projects", { exact: true })).toHaveCount(0);
    const project = sidebar.getByRole("button", { name: "Work", exact: true });
    await expect(project).toBeVisible();
    await expect(project).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() => app.report.sidebarPublications?.length ?? 0)
      .toBe(1);
    await page.clock.install();
    await page.clock.runFor(1_100);
    await page.clock.resume();

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
      page.getByRole("button", { name: "Project: Work", exact: true }),
    ).toBeVisible();
    app.meAgentMessage(id, "Agent follow-up fixture");
    const assistant = page.getByRole("button", {
      name: "Choose follow-up assistant",
      exact: true,
    });
    await assistant.click();
    // Its name gains presence (", online") once that is known.
    await page.getByRole("button", { name: /^Owned Honey(,|$)/ }).click();
    await expect(
      page.getByRole("button", { name: /^Change agent: Owned Honey/ }),
    ).toBeVisible();
    const composer = page.getByRole("textbox", {
      name: "Message your agents",
      exact: true,
    });
    const agentMessage = page.getByText("Agent follow-up fixture", {
      exact: true,
    });
    await expect(agentMessage).toBeVisible();
    await composer.fill("Remember the launch checklist");
    await composer.press("Enter");
    const viewerMessage = page.getByText("Remember the launch checklist", {
      exact: true,
    });
    await expect(viewerMessage).toBeVisible();
    await beta.click();
    await expect(
      page.getByRole("button", {
        name: "Choose follow-up assistant",
        exact: true,
      }),
    ).toBeVisible();
    await sidebar.getByText("Alpha", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: /^Change agent: Owned Honey/ }),
    ).toBeVisible();
    const viewerBox = await viewerMessage.boundingBox();
    const agentBox = await agentMessage.boundingBox();
    expect(viewerBox).toBeTruthy();
    expect(agentBox).toBeTruthy();
    expect(viewerBox.x).toBeGreaterThan(agentBox.x);
    const expectHorizontalTools = async () => {
      const attach = await page
        .getByRole("button", { name: "Attach files", exact: true })
        .boundingBox();
      const formatting = await page
        .getByRole("button", { name: "Toggle formatting", exact: true })
        .boundingBox();
      expect(attach).toBeTruthy();
      expect(formatting).toBeTruthy();
      expect(Math.abs(attach.y - formatting.y)).toBeLessThan(4);
    };
    const settle = () =>
      page.evaluate(() =>
        Promise.all(
          document
            .getAnimations({ subtree: true })
            .filter(
              (animation) =>
                animation.effect?.getComputedTiming().endTime !== Infinity,
            )
            .map((animation) => animation.finished.catch(() => {})),
        ),
      );
    await viewerMessage.hover();
    await settle();
    await expectHorizontalTools();
    await page.screenshot({
      path: test.info().outputPath("after-light-wide.png"),
    });
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
      document.documentElement.classList.add("dark");
    });
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await viewerMessage.hover();
    await settle();
    await page.screenshot({
      path: test.info().outputPath("after-dark-wide.png"),
    });
    await page.setViewportSize({ width: 760, height: 900 });
    await expect(composer).toBeInViewport();
    await expectHorizontalTools();
    await viewerMessage.hover();
    await settle();
    await page.screenshot({
      path: test.info().outputPath("after-dark-narrow.png"),
    });
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "light";
      document.documentElement.classList.remove("dark");
      document.documentElement.style.setProperty("--buzz-text-scale", "2");
    });
    await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
    await expect(composer).toBeInViewport();
    await expectHorizontalTools();
    const projectLabel = project.getByText("Work", { exact: true });
    await expect(projectLabel).toBeVisible();
    await expect
      .poll(() => projectLabel.evaluate((element) => element.clientWidth))
      .toBeGreaterThan(20);
    await viewerMessage.hover();
    await settle();
    await page.screenshot({
      path: test.info().outputPath("after-light-text-2x.png"),
    });
    await page.setViewportSize({ width: 760, height: 900 });
    // Browser fixtures have no native model provider. ComposerModels renders
    // the same toolbar IconButton as Send, so this adds its exact fixed-width
    // footprint while the formatting strip remains the flexible scroll owner.
    await page.evaluate(() => {
      const send = document.querySelector(
        'form[aria-label="Send a message to Alpha"] button[aria-label="Send message"]',
      );
      if (!(send instanceof HTMLButtonElement))
        throw new Error("Missing send control");
      const model = send.cloneNode(true);
      model.setAttribute("aria-label", "Model footprint probe");
      send.before(model);
    });
    await expectHorizontalTools();
    const formBox = await composer.evaluate((element) =>
      element.closest("form").getBoundingClientRect().toJSON(),
    );
    const modelBox = await page
      .getByRole("button", { name: "Model footprint probe", exact: true })
      .boundingBox();
    const sendBox = await page
      .getByRole("button", { name: "Send message", exact: true })
      .boundingBox();
    expect(modelBox).toBeTruthy();
    expect(sendBox).toBeTruthy();
    expect(modelBox.x).toBeGreaterThanOrEqual(formBox.x);
    expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(
      formBox.x + formBox.width,
    );
    expect(sendBox.x - modelBox.x).toBeGreaterThan(modelBox.width / 2);
    await page.screenshot({
      path: test.info().outputPath("after-narrow-text-2x.png"),
    });
  });
});

// A real pointer owns the activation distance and hit testing; the saved move
// itself is the row menu's.
test("dragging a chat between a project and Chats saves and reloads like Move to", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
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
  await page.getByRole("menuitem", { name: "New project…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Project name" }).fill("Work");
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

// App wiring proof: grants and the normal link publication preserve Me placement,
// identity/history and navigation, with a held signed grant readback barrier.
test("Share grants access and posts a link without promoting or moving Me", async ({
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
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share session" });
  const search = dialog.getByRole("combobox", { name: "People or channel" });
  await search.fill("Aria");
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
  // Me has a leading conversion action as well as Copy/Share. Real flex wrapping
  // in that selected-channel state is invisible to mounted DOM tests.
  for (const mode of ["light", "dark"]) {
    await page.evaluate(
      (value) => (document.documentElement.dataset.colorMode = value),
      mode,
    );
    for (const width of [950, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      await expect
        .poll(async () => {
          const rows = await Promise.all(
            [convert, copy, primary].map((control) =>
              control.evaluate((element) => {
                const bounds = element.getBoundingClientRect();
                return bounds.top + bounds.height / 2;
              }),
            ),
          );
          return Math.max(...rows) - Math.min(...rows);
        })
        .toBeLessThanOrEqual(1);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`share-channel-footer-${mode}-${width}.png`),
      });
    }
  }
  // Each action is a shared footer item, not a second horizontal scrollport.
  await page.setViewportSize({ width: 390, height: 850 });
  for (const scale of [1, 2]) {
    await page.evaluate((value) => {
      document.documentElement.style.setProperty(
        "--buzz-text-scale",
        String(value),
      );
    }, scale);
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
    if (scale === 1) {
      await expect
        .poll(() => actions.evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBeLessThanOrEqual(1);
      for (const action of [convert, copy, primary])
        await expect(action).toBeInViewport({ ratio: 1 });
    }
    if (scale === 2) {
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
                document.activeElement?.hasAttribute(
                  "data-base-ui-focus-guard",
                ),
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
                document.elementFromPoint(
                  r.x + r.width / 2,
                  r.y + r.height / 2,
                ),
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
    }
    await page.screenshot({
      path: test
        .info()
        .outputPath(`share-channel-footer-dark-390-text-${scale}.png`),
    });
  }
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
  const footerBounds = () =>
    dialog.locator("footer").evaluate((footer) =>
      [...footer.querySelectorAll("button")].map((button) => {
        const { x, y, width, height } = button.getBoundingClientRect();
        return { label: button.textContent, x, y, width, height };
      }),
    );
  const beforeShare = await footerBounds();
  // Screenshots measure pending layout, not relay timeout behavior. Freeze the
  // page clock before the read deadline is armed so slow capture cannot expire it.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 100);
  try {
    await page.keyboard.press("Enter");
    await requestedReadback;
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Start over" }),
    ).toHaveCount(0);
    await expect(primary).toHaveAttribute("aria-busy", "true");
    await expect.poll(footerBounds).toEqual(beforeShare);
    // Held grant readback proves the real initial -> pending layout transition,
    // including light/dark and a narrow viewport where the footer already wraps.
    for (const mode of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.colorMode = value;
      }, mode);
      for (const width of [1280, 950, 390]) {
        await page.setViewportSize({ width, height: 850 });
        await expect(convert).toBeInViewport();
        await expect(primary).toBeInViewport();
        if (width > 390) {
          await expect
            .poll(async () => {
              const rows = await footerBounds();
              return (
                Math.max(...rows.map((row) => row.y)) -
                Math.min(...rows.map((row) => row.y))
              );
            })
            .toBeLessThanOrEqual(1);
        }
        await page.screenshot({
          path: test.info().outputPath(`share-pending-${mode}-${width}.png`),
        });
      }
    }
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
    // Restore the desktop sidebar before asserting its retained row after close.
    await page.setViewportSize({ width: 1280, height: 850 });
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
    `[Session · 33333333](buzz://channel/${id})`,
  );
});

// App composition boundary: signed metadata switches Messages discoverability
// without a route handoff, a new conversation, or a Me preference write.
test("explicit conversion moves the same conversation from Me to Messages and keeps history", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Solo conversations" });
  const row = sidebar.getByRole("button", { name: "Alpha", exact: true });
  await row.click();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  const shareTrigger = page.getByRole("button", { name: "Share", exact: true });
  await shareTrigger.click();
  const share = page.getByRole("dialog", { name: "Share session" });
  const shareConvert = share.getByRole("button", {
    name: "Convert to channel",
    exact: true,
  });
  await expect(shareConvert).toBeEnabled();
  for (const width of [390, 950, 1280]) {
    await page.setViewportSize({ width, height: 850 });
    await expect(shareConvert).toBeInViewport();
    await expect(
      share.getByRole("button", { name: "Done", exact: true }),
    ).toBeInViewport();
    await expect
      .poll(() =>
        shareConvert.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      )
      .toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 850 });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  await share.getByRole("combobox", { name: "People or channel" }).focus();
  let tabs = 0;
  while (
    tabs < 20 &&
    !(await shareConvert.evaluate((el) => el === document.activeElement))
  ) {
    await page.keyboard.press("Tab");
    tabs++;
  }
  await expect(shareConvert).toBeFocused();
  await expect(shareConvert).toBeInViewport();
  await expect
    .poll(() =>
      shareConvert.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        );
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: test.info().outputPath("share-convert-enlarged-390.png"),
  });
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await shareConvert.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Convert to channel",
    exact: true,
  });
  await expect(share).not.toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "Private", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("radio", { name: "Public", exact: true }),
  ).toHaveAccessibleDescription(
    "Everyone in this community will be able to view this channel’s full history.",
  );
  const convert = dialog.getByRole("button", {
    name: "Convert to channel",
    exact: true,
  });
  await expect(convert).toBeEnabled();
  for (const mode of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.colorMode = value;
    }, mode);
    for (const width of [390, 950, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      await expect(convert).toBeEnabled();
      await expect(convert).toBeInViewport();
      await page.screenshot({
        path: test.info().outputPath(`convert-${mode}-${width}.png`),
      });
    }
  }
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "2"),
  );
  await expect(convert).toBeEnabled();
  await page.screenshot({
    path: test.info().outputPath("convert-enlarged.png"),
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(convert).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await page.evaluate(() =>
    document.documentElement.style.setProperty("--buzz-text-scale", "1"),
  );
  await expect(dialog).not.toBeVisible();
  await expect(shareTrigger).toBeFocused();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await row.focus();
  await row.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Convert to channel", exact: true })
    .click();
  await expect(convert).toBeEnabled();
  const publicChoice = dialog.getByRole("radio", {
    name: "Public",
    exact: true,
  });
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
  await expect(sidebar).toHaveCount(0);
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
  ]);
  const placements = (app.report.sidebarPublications ?? []).filter((entry) =>
    entry.coordinate.startsWith("buzz-me-kit"),
  );
  expect(placements).toHaveLength(1);
  expect(placements[0].blob.value.channels).toEqual([other]);
  expect(placements[0].blob.value.assignments[id]).toBeUndefined();
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
  await openPage(page, "Me");
  await expect(row).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
});

// Browser-only: native modal focus handoff to a replacement Messages header.
// The held metadata/completion ordering matrix lives in the mounted page test.
test("Messages conversion restores focus after its session header is replaced", async ({
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
  const share = page.getByRole("dialog", { name: "Share session" });
  await share.getByRole("button", { name: "Convert to channel" }).click();
  const dialog = page.getByRole("dialog", { name: "Convert to channel" });
  await expect(
    dialog.getByRole("button", { name: "Convert to channel" }),
  ).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
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
    page.getByRole("button", { name: "Channel actions" }),
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
  ]);
  const placements = (app.report.sidebarPublications ?? []).filter((entry) =>
    entry.coordinate.startsWith("buzz-me-kit"),
  );
  expect(placements).toHaveLength(1);
  expect(placements[0].blob.value.channels).toEqual([other]);
});

// Real shell layout and route remounts prove Me consumes the shared sidebar owner.
test("Me and Messages share one resizable sidebar width", async ({
  page,
  app,
}) => {
  const width = (name) =>
    page
      .getByRole("complementary", { name, exact: true })
      .evaluate(
        (element) =>
          element
            .closest(".shell-sidebar, .shell-sidebar-default")
            .getBoundingClientRect().width,
      );
  const handle = page.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  await page.goto(app.origin);
  await openPage(page, "Me");
  await expect.poll(() => width("Solo sidebar")).toBe(260);
  await handle.press("End");
  await expect.poll(() => width("Solo sidebar")).toBe(520);
  await openPage(page, "Messages");
  await expect.poll(() => width("Channel sidebar")).toBe(520);
  await handle.press("Home");
  await expect.poll(() => width("Channel sidebar")).toBe(220);
  await openPage(page, "Me");
  await expect.poll(() => width("Solo sidebar")).toBe(220);
  await page.reload();
  await expect.poll(() => width("Solo sidebar")).toBe(220);
});

test("unified session naming and lifetime retain host focus and save only explicit changes", async ({
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
  await openPage(page, "Me");
  const actions = page.getByRole("button", {
    name: "Session settings",
    exact: true,
  });
  await actions.click();
  const settings = page.getByRole("dialog", {
    name: "Session settings",
    exact: true,
  });
  const canvas = settings.getByRole("textbox", { name: "Canvas", exact: true });
  await expect(canvas).toBeVisible();
  await canvas.fill("Keep this local draft");
  const draftName = settings.getByRole("textbox", {
    name: "Session name (optional)",
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
  const inspect = async (dialog, save, prefix, nameLabel) => {
    for (const mode of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.colorMode = value;
      }, mode);
      for (const width of [390, 950, 1280]) {
        await page.setViewportSize({ width, height: 850 });
        const name = dialog.getByRole("textbox", {
          name: nameLabel,
          exact: true,
        });
        await name.scrollIntoViewIfNeeded();
        await expect(name).toBeInViewport();
        await expect(name).toBeEnabled();
        await expect
          .poll(() =>
            dialog.evaluate((el) => {
              const name = el.querySelector("input").closest(".buzz-field");
              const folders = el
                .querySelector("textarea")
                .closest(".buzz-field").parentElement;
              const canvas = [...el.querySelectorAll(".buzz-field")].find(
                (field) =>
                  field.querySelector(".buzz-field-label")?.textContent ===
                  "Canvas",
              );
              const lifetime = el
                .querySelector('[role="radio"]')
                .closest(".buzz-field");
              const boxes = [name, folders, canvas, lifetime].map((field) =>
                field.getBoundingClientRect(),
              );
              return boxes
                .slice(1)
                .map((box, i) => Math.round(box.top - boxes[i].bottom));
            }),
          )
          .toEqual([32, 32, 32]);
        await page.screenshot({
          path: test.info().outputPath(`${prefix}-name-${mode}-${width}.png`),
        });
        const bounds = await name.evaluate((el) => ({
          width: el.getBoundingClientRect().width,
          right: el.getBoundingClientRect().right,
          viewport: innerWidth,
        }));
        expect(bounds.width).toBeGreaterThan(100);
        expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
        await expect(name).toHaveAccessibleDescription("");
        await save.scrollIntoViewIfNeeded();
        await expect(save).toBeInViewport();
        await expect(
          dialog.getByRole("button", { name: "Close", exact: true }),
        ).toBeInViewport();
        // A content-sized form has one body scroll owner and only the shared bottom
        // gutter, not a reserved empty area below the confirmation actions.
        await expect(dialog).toHaveAttribute("data-height", "content");
        await expect(dialog.locator(".buzz-dialog-body")).toHaveCSS(
          "overflow-y",
          "auto",
        );
        await dialog.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect
          .poll(() =>
            dialog.evaluate((element) => {
              const footer = element.querySelector(".buzz-dialog-actions");
              const gutter = Number.parseFloat(
                getComputedStyle(element).paddingBottom,
              );
              return Math.abs(
                element.getBoundingClientRect().bottom -
                  footer.getBoundingClientRect().bottom +
                  Number.parseFloat(getComputedStyle(footer).paddingBottom) -
                  gutter -
                  element.clientTop,
              );
            }),
          )
          .toBeLessThan(1);
        const temporaryControl = dialog.getByRole("radio", {
          name: "Temporary",
          exact: true,
        });
        await temporaryControl.scrollIntoViewIfNeeded();
        await expect(temporaryControl).toBeInViewport();
        await expect(
          dialog.getByText("Lifetime", { exact: true }),
        ).toBeVisible();
        await expect(dialog.getByRole("tab")).toHaveCount(0);
        await expect(
          dialog.getByRole("button", {
            name: /^(Save changes|Check save status)$/,
          }),
        ).toHaveCount(1);
        await dialog.evaluate((element) =>
          Promise.allSettled(
            element
              .getAnimations({ subtree: true })
              .filter(
                (animation) =>
                  animation.effect?.getComputedTiming().endTime !== Infinity,
              )
              .map((animation) => animation.finished),
          ),
        );
        await checkDurationLayout(dialog, { selected: false });
        await page.screenshot({
          path: test
            .info()
            .outputPath(`${prefix}-${mode}-ongoing-${width}.png`),
        });
        await checkDurationLayout(dialog, { alongside: width >= 950 });
        await page.screenshot({
          path: test.info().outputPath(`${prefix}-${mode}-${width}.png`),
        });
      }
    }
    for (const { width, height } of [
      { width: 390, height: 500 },
      { width: 950, height: 400 },
      { width: 1280, height: 600 },
    ]) {
      await page.setViewportSize({ width, height });
      const close = dialog.getByRole("button", { name: "Close", exact: true });
      const name = dialog.getByRole("textbox", {
        name: nameLabel,
      });
      await name.scrollIntoViewIfNeeded();
      await expect(close).toBeInViewport();
      await expect(save).toBeInViewport();
      const body = dialog.locator(".buzz-dialog-body");
      await body.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(close).toBeInViewport();
      await expect(save).toBeInViewport();
      for (const control of [close, save]) {
        await expect
          .poll(() =>
            control.evaluate((el) => {
              const box = el.getBoundingClientRect();
              const popup = el.closest('[role="dialog"]');
              const bounds = popup.getBoundingClientRect();
              const style = getComputedStyle(popup);
              return (
                box.top >=
                  Math.max(0, bounds.top + parseFloat(style.paddingTop)) &&
                box.bottom <=
                  Math.min(
                    innerHeight,
                    bounds.bottom - parseFloat(style.paddingBottom),
                  ) &&
                box.left >=
                  Math.max(0, bounds.left + parseFloat(style.paddingLeft)) &&
                box.right <=
                  Math.min(
                    innerWidth,
                    bounds.right - parseFloat(style.paddingRight),
                  ) &&
                el.contains(
                  document.elementFromPoint(
                    box.left + box.width / 2,
                    box.top + box.height / 2,
                  ),
                )
              );
            }),
          )
          .toBe(true);
      }
      await expect
        .poll(() => body.evaluate((el) => el.scrollHeight > el.clientHeight))
        .toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`${prefix}-short-${width}-${height}.png`),
      });
    }
    // At the native minimum with enlarged text, fixed chrome alone cannot fit.
    // Check pointer access BEFORE focus/scrollIntoView can mask hidden overflow.
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--buzz-text-scale", "2"),
    );
    await page.setViewportSize({ width: 480, height: 400 });
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    const pointerReachable = (control) =>
      control.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const bounds = el.closest('[role="dialog"]').getBoundingClientRect();
        return (
          box.top >= Math.max(0, bounds.top) &&
          box.bottom <= Math.min(innerHeight, bounds.bottom) &&
          box.left >= Math.max(0, bounds.left) &&
          box.right <= Math.min(innerWidth, bounds.right) &&
          el.contains(
            document.elementFromPoint(
              box.left + box.width / 2,
              box.top + box.height / 2,
            ),
          )
        );
      });
    // Wheel over visible chrome, not the body's independent scrollport.
    // Overflow:hidden can be focus-scrolled but cannot pass this pointer path.
    const wheelOuter = async (delta) => {
      const chrome = (await pointerReachable(close)) ? close : cancel;
      const bounds = await chrome.boundingBox();
      expect(bounds).not.toBeNull();
      await page.mouse.move(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
      );
      await page.mouse.wheel(0, delta);
    };
    await wheelOuter(-2000);
    await expect.poll(() => dialog.evaluate((el) => el.scrollTop)).toBe(0);
    await expect.poll(() => pointerReachable(close)).toBe(true);
    await expect(dialog).toHaveCSS("overflow-y", "auto");
    await wheelOuter(2000);
    await expect
      .poll(() => dialog.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    for (const control of [cancel, save]) {
      await expect.poll(() => pointerReachable(control)).toBe(true);
    }
    await page.screenshot({
      path: test.info().outputPath(`${prefix}-minimum-enlarged-footer.png`),
    });
    await wheelOuter(-2000);
    await expect.poll(() => pointerReachable(close)).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`${prefix}-minimum-enlarged-header.png`),
    });
    // Keyboard access is independent of the pointer fallback.
    await close.focus();
    await page.keyboard.press("Tab");
    const minimumName = dialog.getByRole("textbox", {
      name: nameLabel,
      exact: true,
    });
    await expect(minimumName).toBeFocused();
    await expect
      .poll(() =>
        minimumName.evaluate((el) => {
          const box = el.getBoundingClientRect();
          const body = el.closest(".buzz-dialog-body").getBoundingClientRect();
          return box.top >= body.top && box.bottom <= body.bottom;
        }),
      )
      .toBe(true);
    await expect.poll(() => pointerReachable(minimumName)).toBe(true);
    await page.screenshot({
      path: test
        .info()
        .outputPath(`${prefix}-minimum-enlarged-name-focused.png`),
    });
    let minimumTabs = 0;
    while (
      minimumTabs < 20 &&
      !(await save.evaluate((el) => el === document.activeElement))
    ) {
      await page.keyboard.press("Tab");
      minimumTabs++;
    }
    await expect(save).toBeFocused();
    await expect.poll(() => pointerReachable(save)).toBe(true);
    await page.setViewportSize({ width: 390, height: 850 });
    for (const mode of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.colorMode = value;
      }, mode);
      await checkDurationLayout(dialog, { selected: false });
      await page.screenshot({
        path: test
          .info()
          .outputPath(`${prefix}-${mode}-ongoing-enlarged-390.png`),
      });
      await checkDurationLayout(dialog);
      await page.screenshot({
        path: test.info().outputPath(`${prefix}-${mode}-enlarged-390.png`),
      });
    }
    // Start at the user's current control: Tab must expose the footer without
    // programmatic focus/scroll or resetting enlarged text to mask clipping.
    let tabs = 0;
    while (
      tabs < 20 &&
      !(await save.evaluate((el) => el === document.activeElement))
    ) {
      await page.keyboard.press("Tab");
      tabs += 1;
    }
    await expect(save).toBeFocused();
    await expect(save).toBeInViewport();
    await expect
      .poll(() =>
        save.evaluate((el) => {
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
    console.log(
      `${test.info().project.name} ${prefix}: enlarged Save reachable in ${tabs}/20 Tabs; focused, in viewport, center hit-test passed`,
    );
    await page.screenshot({
      path: test.info().outputPath(`${prefix}-enlarged-footer-390.png`),
    });
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--buzz-text-scale", "1"),
    );
    await page.setViewportSize({ width: 1280, height: 850 });
    const worktree = dialog.getByRole("switch", {
      name: "Work in a new worktree",
    });
    await worktree.click();
    await expect(worktree).toBeChecked();
    const repository = dialog.getByRole("textbox", {
      name: "Source repository",
      exact: true,
    });
    const location = dialog.getByRole("textbox", {
      name: "Worktree location",
      exact: true,
    });
    const branch = dialog.getByRole("textbox", {
      name: "Base branch",
      exact: true,
    });
    for (const mode of ["light", "dark"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.colorMode = value;
      }, mode);
      for (const width of [390, 950, 1280]) {
        await page.setViewportSize({ width, height: 850 });
        for (const control of [repository, location, branch]) {
          await control.scrollIntoViewIfNeeded();
          await expect.poll(() => pointerReachable(control)).toBe(true);
        }
        await expect
          .poll(() =>
            location.evaluate((el) => {
              const grid = el.closest(".buzz-field").parentElement;
              const fields = [...grid.children].map((field) =>
                field.getBoundingClientRect(),
              );
              const bounds = grid.getBoundingClientRect();
              return (
                grid.scrollWidth === grid.clientWidth &&
                fields.every(
                  (box) => box.left >= bounds.left && box.right <= bounds.right,
                ) &&
                fields[1].top >= fields[0].bottom
              );
            }),
          )
          .toBe(true);
        await repository.click();
        await page.keyboard.press("Tab");
        await expect(location).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(branch).toBeFocused();
        await expect.poll(() => pointerReachable(branch)).toBe(true);
        await page.screenshot({
          path: test
            .info()
            .outputPath(`${prefix}-worktree-${mode}-${width}.png`),
        });
      }
    }
    // Do not alter this journey's existing Canvas/save intent.
    await worktree.click();
    await expect(worktree).not.toBeChecked();
    await page.setViewportSize({ width: 1280, height: 850 });
    await save.focus();
  };
  await inspect(
    settings,
    draftSave,
    "draft-lifetime",
    "Session name (optional)",
  );
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
    name: "Session settings",
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
  await inspect(lifetime, save, "session-lifetime", "Session name");
  await expect(save).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await expect(lifetime).not.toBeVisible();
  await expect(actions).toBeFocused();
  expect(app.report.detailsPublications ?? []).toHaveLength(0);
  await row.focus();
  await row.press("Shift+F10");
  await page
    .getByRole("menuitem", { name: "Session settings…", exact: true })
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
    .getByRole("textbox", { name: "Session name", exact: true })
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
    ["ttl", "1209600"],
  ]);
  const saved = readbacks.find((entry) =>
    entry.tags.some(([key, value]) => key === "ttl" && value === "1209600"),
  );
  expect(saved).toBeDefined();
  expect(verifyEvent(saved)).toBe(true);
  expect(saved.tags).toContainEqual([
    "about",
    "Buzz session (buzz.sessions/v1)",
  ]);
  expect(saved.tags).toContainEqual(["private"]);
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
    .getByRole("menuitem", { name: "Session settings…", exact: true })
    .click();
  await expect(save).toBeEnabled();
  await expect(temporary).toHaveAccessibleDescription(
    "Archives after 2 weeks without activity.",
  );
  await page.keyboard.press("Escape");

  await expect(renamedRow).toBeFocused();
});
