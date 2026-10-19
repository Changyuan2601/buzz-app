import { test, expect } from "./fixture.mjs";
import { navigationScope, newChat, openPage } from "./navigation.mjs";

// Browser-only boundaries: measured overflow/simulated native insets, keyboard focus on
// resize, and real App wiring between Messages and Solo chats. Contract matrices stay in RTL.
test.use({ pluginFixtures: true });

test("shared navigation preserves drafts and history across Solo and header pages", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const composer = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await expect(composer).toBeVisible();
  await composer.fill("Keep this draft");
  const topbar = page.getByRole("navigation", { name: "Topbar pages" });
  await expect(topbar.getByRole("tab")).toHaveText([
    "Messages",
    "Reminders",
    "Agents",
    "Workflows",
  ]);
  const sidebar = page.getByRole("complementary", {
    name: "Sidebar",
    exact: true,
  });
  const sidebarNode = await sidebar.elementHandle();
  await newChat(page);
  await expect(
    page.getByRole("textbox", { name: "Message your agents", exact: true }),
  ).toBeVisible();
  await expect(sidebar).toBeVisible();
  expect(await sidebarNode.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  await expect(composer).toHaveCount(0);
  const messages = topbar.getByRole("tab", { name: "Messages", exact: true });
  await expect(messages).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click();
  await expect(page.locator("#shell-navigation")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await newChat(page);
  await expect(
    page.getByRole("textbox", { name: "Message your agents", exact: true }),
  ).toBeFocused();
  await messages.click();
  // The header keeps the current Messages route, including a Solo draft.
  // Pick the original conversation from the shared sidebar to restore its draft.
  await navigationScope(page, "All");
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await expect(composer).toHaveText("Keep this draft");
  const reminders = topbar.getByRole("tab", { name: "Reminders", exact: true });
  const indicator = topbar.locator(".buzz-tabs-indicator");
  await expect
    .poll(async () => {
      const tab = await messages.boundingBox();
      const pill = await indicator.boundingBox();
      return tab && pill
        ? Math.abs(tab.x - pill.x) + Math.abs(tab.width - pill.width)
        : Infinity;
    })
    .toBeLessThan(1);
  await expect(composer).toHaveText("Keep this draft");
  // Enter the page through normal keyboard traversal, not programmatic panel focus.
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    for (const activation of ["Enter", "Space"]) {
      await messages.focus();
      await messages.press("ArrowRight");
      await expect(reminders).toBeFocused();
      await reminders.press(activation);
      const newComposer = page.getByRole("heading", {
        name: "Reminders",
        exact: true,
      });
      await expect(newComposer).toBeVisible();
      // The real destination and its mount effects must settle before checking focus.
      await newComposer.evaluate(
        (element) =>
          new Promise((resolve) => {
            requestAnimationFrame(() => resolve(element.isConnected));
          }),
      );
      await expect(reminders).toHaveAttribute("aria-selected", "true");
      await expect(reminders).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(messages).toBeFocused();
      await expect(reminders).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press(activation);
      await expect(messages).toHaveAttribute("aria-selected", "true");
      await expect(composer).toHaveText("Keep this draft");
      await expect(messages).toBeFocused();
    }
    await reminders.click();
    const newComposer = page.getByRole("heading", {
      name: "Reminders",
      exact: true,
    });
    await expect(newComposer).toBeVisible();
    await newComposer.evaluate(
      (element) =>
        new Promise((resolve) => {
          requestAnimationFrame(() => resolve(element.isConnected));
        }),
    );
    await expect(reminders).toBeFocused();
    for (const name of ["Reminders", "Messages"]) {
      await topbar.getByRole("tab", { name, exact: true }).click();
      const panel = page.getByRole("tabpanel", { name, exact: true });
      await page.locator("#main-content").focus();
      await page.keyboard.press("Tab");
      await expect(panel).toBeFocused();
      await expect(panel).toHaveCSS("outline-style", "solid");
      await expect(panel).toHaveCSS("outline-width", "2px");
      const focus = await panel.evaluate((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        const frame = element.parentElement.getBoundingClientRect();
        return {
          offset: Number.parseFloat(style.outlineOffset),
          width: Number.parseFloat(style.outlineWidth),
          color: style.outlineColor,
          insideFrame:
            box.left >= frame.left &&
            box.right <= frame.right &&
            box.top >= frame.top &&
            box.bottom <= frame.bottom,
        };
      });
      expect(focus.insideFrame).toBe(true);
      expect(focus.color).not.toBe("rgba(0, 0, 0, 0)");
      expect(focus.offset + focus.width).toBeLessThanOrEqual(0);
      const screenshot = await page.screenshot({
        scale: "css",
        path: test.info().outputPath(`panel-focus-${name}-${mode}.png`),
      });
      const edgeColors = await panel.evaluate(async (element, imageBase64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${imageBase64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const box = element.getBoundingClientRect();
        return [
          [box.left + 1, box.top + box.height / 2],
          [box.right - 1, box.top + box.height / 2],
          [box.left + box.width / 2, box.top + 1],
          [box.left + box.width / 2, box.bottom - 1],
        ].map(([x, y]) => {
          const [r, g, b] = context.getImageData(
            Math.floor(x),
            Math.floor(y),
            1,
            1,
          ).data;
          return `rgb(${r}, ${g}, ${b})`;
        });
      }, screenshot.toString("base64"));
      expect(edgeColors).toEqual(Array(4).fill(focus.color));
      await page.keyboard.press("Tab");
      await expect(panel).not.toBeFocused();
      await expect(panel).toHaveCSS("outline-style", "none");
      await topbar.getByRole("tab", { name, exact: true }).click();
      await expect(page.locator("html")).not.toHaveAttribute(
        "data-keyboard-navigation",
      );
    }
  }
  await expect(
    page.getByRole("complementary", { name: "Sidebar", exact: true }),
  ).toBeVisible();
  // The real sidebar changes the route, not the containing Messages area.
  const inbox = page
    .getByRole("navigation", { name: "Pages" })
    .getByRole("button", { name: "Inbox", exact: true });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    for (const activation of ["pointer", "Enter", "Space"]) {
      await inbox.click();
      await expect(inbox).toHaveAttribute("aria-current", "page");
      await expect(messages).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("tabpanel", { name: "Messages", exact: true }),
      ).toHaveAttribute("id", await messages.getAttribute("aria-controls"));
      await expect(page.locator("#main-content")).toBeFocused();
      if (activation === "pointer") await messages.click();
      else {
        await messages.focus();
        await messages.press(activation);
      }
      await expect(composer).toHaveText("Keep this draft");
      await expect(messages).toBeFocused();
    }
  }
  await inbox.click();
  await page.reload();
  await expect(inbox).toHaveAttribute("aria-current", "page");
  await expect(messages).toHaveAttribute("aria-selected", "true");
  await reminders.click();
  await expect(reminders).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(inbox).toHaveAttribute("aria-current", "page");
  await expect(messages).toHaveAttribute("aria-selected", "true");
  await page.goForward();
  await expect(reminders).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(inbox).toHaveAttribute("aria-current", "page");
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await page.setViewportSize({ width: 390, height: 950 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    await page.getByRole("button", { name: "More pages", exact: true }).click();
    const overflow = page.getByRole("navigation", { name: "Header pages" });
    const area = overflow.getByRole("button", {
      name: "Messages",
      exact: true,
    });
    await expect(area).toHaveAttribute("aria-current", "true");
    await expect(area).toBeVisible();
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
    await page.setViewportSize({ width: 1440, height: 950 });
    await expect(messages).toHaveAttribute("aria-selected", "true");
    await page.screenshot({
      path: test.info().outputPath(`messages-inbox-${mode}.png`),
    });
  }
  await messages.click();
  await expect(composer).toHaveText("Keep this draft");
  await openPage(page, "Settings");
  await expect(topbar.locator('[aria-selected="true"]')).toHaveCount(0);
});

test("header pages remain reachable without overlap through scale and resize", async ({
  page,
  app,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("buzz-appearance.v1", "system");
    localStorage.setItem(
      "buzzodz.plugins.v1",
      JSON.stringify({
        version: 2,
        enabled: { "fixture.page-placement": true },
      }),
    );
  });
  await page.goto(app.origin);
  await openPage(page, "Messages");
  const topbar = page.getByRole("navigation", { name: "Topbar pages" });
  const toolbar = page.getByRole("navigation", { name: "Toolbar pages" });
  const more = page.getByRole("button", { name: "More pages", exact: true });
  const reminders = topbar.getByRole("tab", { name: "Reminders", exact: true });
  for (const mode of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await expect(page.locator("html")).toHaveAttribute("data-color-mode", mode);
    await page.setViewportSize({ width: 1600, height: 950 });
    await expect(topbar).toBeVisible();
    const geometry = await page.locator(".shell-header").evaluate((header) => {
      const rect = (selector) =>
        header.querySelector(selector).getBoundingClientRect();
      return {
        left: rect(".shell-history").right,
        center: rect(".shell-topbar-pages").toJSON(),
        create: rect(".shell-create-action").toJSON(),
        search: rect(".shell-search-action").toJSON(),
        right: rect(".shell-actions").left,
        width: header.clientWidth,
      };
    });
    expect(geometry.create.x).toBeGreaterThan(geometry.left);
    expect(geometry.create.right).toBeLessThanOrEqual(geometry.center.x);
    expect(geometry.center.right).toBeLessThanOrEqual(geometry.search.x);
    expect(geometry.search.right).toBeLessThan(geometry.right);
    expect(
      Math.abs(
        geometry.center.x + geometry.center.width / 2 - geometry.width / 2,
      ),
    ).toBeLessThan(1);
    await toolbar.getByRole("button", { name: "Toolbar destination" }).click();
    await expect(
      page.getByRole("heading", { name: "Toolbar destination" }),
    ).toBeVisible();
    await expect(toolbar.getByRole("button")).toHaveAttribute(
      "aria-current",
      "page",
    );
    // 800px exercises measured overflow, not only the <=650px CSS fallback.
    for (const width of [800, 650, 390]) {
      await reminders.focus();
      await page.setViewportSize({ width, height: 950 });
      await expect(more).toBeFocused();
      await expect(topbar).not.toBeVisible();
      await expect(toolbar).not.toBeVisible();
      await more.press("Enter");
      const choices = page.getByRole("navigation", { name: "Header pages" });
      await expect(choices.getByRole("button")).toHaveText([
        "Messages",
        "Reminders",
        "A deliberately long topbar destination",
        "Agents",
        "Toolbar destination",
        "Workflows",
      ]);
      await page.keyboard.press("Escape");
      await expect(choices).toHaveCount(0);
      await expect(more).toBeFocused();
      await more.press("Enter");
      await choices
        .getByRole("button", { name: "Reminders", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Reminders", exact: true }),
      ).toBeVisible();
      await expect(more).not.toHaveAttribute("aria-expanded", "true");
      // Widen with focus inside the open overflow, not only on its trigger.
      await more.click();
      await choices
        .getByRole("button", { name: "Messages", exact: true })
        .focus();
      await page.setViewportSize({ width: 1600, height: 950 });
      await expect(choices).toHaveCount(0);
      await expect(
        topbar.getByRole("tab", { name: "Messages", exact: true }),
      ).toBeFocused();
    }
  }
  // Simulate the native reserve and 200% interface text size, not native drag behavior.
  await page
    .locator(".shell-header")
    .evaluate((header) => header.classList.add("shell-header-mac"));
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await page.setViewportSize({ width: 800, height: 950 });
  await expect(more).toBeVisible();
  await more.click();
  await expect(
    page
      .getByRole("navigation", { name: "Header pages" })
      .getByRole("button", { name: "Messages", exact: true }),
  ).toBeVisible();
});
