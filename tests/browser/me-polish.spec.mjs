import { test, expect } from "./fixture.mjs";
import { openPage } from "./navigation.mjs";

const id = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
// Real pointer/keyboard menu behavior, dialog focus and pane geometry require a browser.
test.use({
  pluginFixtures: true,
  productionBroker: true,
  channelIds: [id, other],
  channelNames: { [id]: "Alpha", [other]: "Beta" },
  sessionChannels: [id, other],
  meChannels: [id, other],
  historyCounts: { [id]: 2, [other]: 1 },
});

test("Me has a wide new chat, bounded conversation and matching actions", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
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
        composer.evaluate(
          (el) =>
            el.closest("form").getBoundingClientRect().width /
            el.closest("section").getBoundingClientRect().width,
        ),
      )
      .toBeGreaterThan(0.9);
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
    name: "Share conversation",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue("Alpha");
  await expect(
    dialog.getByRole("switch", { name: "Private", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    dialog.getByRole("button", { name: "Share", exact: true }),
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
    const sidebar = page.getByRole("navigation", { name: "Me conversations" });
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
    await expect(sidebar.getByText("Projects", { exact: true })).toBeVisible();
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
    const projectBox = await project.boundingBox();
    const chatBox = await row.boundingBox();
    expect(projectBox).toBeTruthy();
    expect(chatBox).toBeTruthy();
    expect(chatBox.x).toBeGreaterThan(projectBox.x);

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
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
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

test("Share promotes the same conversation and opens its preserved history in Messages", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Me");
  const sidebar = page.getByRole("navigation", { name: "Me conversations" });
  await sidebar
    .getByRole("button", { name: "Alpha", exact: true })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Share…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share conversation" });
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Shared Alpha");
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message #Shared Alpha", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(`primary ${id} message 0`, { exact: false }),
  ).toBeVisible();
  expect(app.report.detailsPublications).toHaveLength(1);
  expect(app.report.detailsPublications[0].tags).toEqual([
    ["h", id],
    ["name", "Shared Alpha"],
    ["about", ""],
  ]);
  expect(app.report.publications).toHaveLength(0);
  await openPage(page, "Me");
  await expect(
    sidebar.getByRole("button", { name: "Shared Alpha", exact: true }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Beta", exact: true }),
  ).toBeVisible();
});
