import { openChannelDetails } from "./channel-details.mjs";
import { openPage, selectSettingsSection } from "./navigation.mjs";
import { test, expect } from "./fixture.mjs";
import { fixtureRelayUrl } from "../relay-config.ts";

test.use({
  productionBroker: true,
  channelLifecycle: true,
  historyCounts: { alpha: 2, beta: 1 },
});

// Browser-only contract: real hit-testing between centered modal layers,
// inside-origin drags, backdrop pointer focus return and Settings survival.
// Cancellation matrices and writes stay in mounted component/domain tests.
test("Canvas confirmation backdrop dismisses only the top layer and retains the draft", async ({
  page,
  app,
}, testInfo) => {
  await page.addInitScript(
    ({ viewer, relay }) => {
      localStorage.setItem("buzz-appearance.v1", "dark");
      localStorage.setItem(
        `buzz-view.v1:${JSON.stringify([`${relay}:${viewer}`, "canvas-draft-v1:alpha"])}`,
        JSON.stringify({ content: "Local draft", base: "a".repeat(64) }),
      );
    },
    { viewer: app.viewer, relay: fixtureRelayUrl },
  );
  await page.goto(app.origin);
  await openPage(page, "Messages");
  await page
    .getByRole("navigation", { name: "Subscribed channels" })
    .getByRole("button", { name: "Alpha", exact: true })
    .click();
  await openChannelDetails(page);
  const settings = page.getByRole("complementary", {
    name: "Channel settings",
    exact: true,
  });
  const trigger = page.getByRole("button", {
    name: "Channel actions",
    exact: true,
  });
  const openCanvas = async () => {
    await trigger.click();
    await page
      .getByRole("menuitem", { name: "View canvas", exact: true })
      .click();
  };
  await openCanvas();
  const editor = page.getByRole("dialog", {
    name: "Channel Canvas",
    exact: true,
  });
  const text = editor.getByRole("textbox", { name: "Canvas Markdown" });
  await expect(text).toHaveValue("Local draft");
  await expect(editor).toHaveCSS("backdrop-filter", "blur(8px)");
  await expect(editor).toHaveCSS("background-color", "rgba(40, 40, 40, 0.9)");
  const reload = editor.getByRole("button", { name: "Reload saved Canvas" });
  await reload.click();
  const confirmation = page.getByRole("dialog", {
    name: "Reload saved Canvas?",
    exact: true,
  });
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await confirmation.getByRole("heading").click();
  await expect(confirmation).toBeVisible();
  const bounds = await confirmation.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds.x + 30, bounds.y + 25);
  await page.mouse.down();
  await page.mouse.move(8, 8);
  await page.mouse.up();
  await expect(confirmation).toBeVisible();
  await confirmation.screenshot({
    path: testInfo.outputPath("canvas-reload-confirmation.png"),
  });
  await page.mouse.click(8, 8);
  await expect(confirmation).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(reload).toBeFocused();
  await expect(text).toHaveValue("Local draft");
  await page.mouse.click(8, 8);
  await expect(editor).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(settings).toBeVisible();
  await openCanvas();
  await expect(text).toHaveValue("Local draft");
  expect(app.report.lifecyclePublications ?? []).toEqual([]);
});

test.describe("saved template and team cancellation", () => {
  test.use({ personalSidebar: true, launchAnimation: true });

  async function openTemplates(page, app) {
    await page.goto(app.origin);
    await page
      .getByRole("button", { name: "Your profile", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await selectSettingsSection(page, "Plugins");
    await page
      .getByRole("switch", { name: "Enable Templates & teams", exact: true })
      .check();
    await selectSettingsSection(page, "Templates", "Templates settings");
  }

  async function saveTemplate(page) {
    await page
      .getByRole("button", { name: "New template", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "New template",
      exact: true,
    });
    await editor
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Incident plan");
    await editor
      .getByRole("button", { name: "Starting Canvas", exact: true })
      .click();
    await editor
      .getByRole("textbox", { name: "Starting Canvas (Markdown)" })
      .fill("# Saved incident plan");
    await editor
      .getByRole("button", { name: "Save template", exact: true })
      .click();
    await expect(editor).toHaveCount(0);
    await expect(
      page.getByRole("article", { name: "Incident plan", exact: true }),
    ).toBeVisible();
  }

  test("template and team deletion backdrops cancel and restore menu focus", async ({
    page,
    app,
  }, info) => {
    await openTemplates(page, app);
    await saveTemplate(page);
    for (const type of ["template", "team"]) {
      const name = type === "template" ? "Incident plan" : "Incident team";
      if (type === "team") {
        await openPage(page, "Agents");
        await page
          .getByRole("button", { name: "Create team", exact: true })
          .click();
        const editor = page.getByRole("dialog", {
          name: "Add team",
          exact: true,
        });
        await editor
          .getByRole("textbox", { name: "Name", exact: true })
          .fill(name);
        await editor
          .getByRole("button", { name: "Save team", exact: true })
          .click();
        await expect(editor).toHaveCount(0);
      }
      const item = page.getByRole("article", { name, exact: true });
      await expect(item).toBeVisible();
      const trigger = item.getByRole("button", { name: `Actions for ${name}` });
      const saved = kitWrites(app);
      for (const dismissal of ["backdrop", "escape"]) {
        await trigger.click();
        await page
          .getByRole("menuitem", { name: `Delete ${type}…`, exact: true })
          .click();
        const confirmation = page.getByRole("dialog", {
          name: `Delete “${name}”?`,
          exact: true,
        });
        await expect(
          confirmation.getByRole("button", { name: "Cancel", exact: true }),
        ).toBeFocused();
        await confirmation.getByRole("heading").click();
        await expect(confirmation).toBeVisible();
        if (dismissal === "backdrop") {
          await dragOutside(page, confirmation);
          await expect(confirmation).toBeVisible();
          await confirmation.screenshot({
            path: info.outputPath(`delete-${type}.png`),
          });
          await page.mouse.click(8, 8);
        } else await page.keyboard.press("Escape");
        await expect(confirmation).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await expect(item).toBeVisible();
        expect(kitWrites(app)).toEqual(saved);
      }
      // Reload through the owning catalog after the close/focus boundary. A
      // cancelled tombstone must not be hidden by the library's mounted state.
      const refreshed = page.waitForResponse("**/channel-kit-decode");
      await page
        .getByRole("button", {
          name: type === "team" ? "Refresh teams" : "Refresh",
          exact: true,
        })
        .click();
      const decoded = await refreshed;
      expect(decoded.ok()).toBe(true);
      await decoded.finished();
      await expect(trigger).toBeEnabled();
      await expect(item).toBeVisible();
    }
  });

  test("portaled template Select cancels only replacement and retains channel setup", async ({
    page,
    app,
  }, info) => {
    // Model a creation-capable host only for opening/cancelling this draft.
    // No creation is submitted; this is not native signing/creation acceptance.
    await page.route("**/api/relay/*/session", async (route) => {
      const response = await route.fetch();
      const session = await response.json();
      await route.fulfill({
        response,
        json: {
          ...session,
          writeKinds: [...new Set([...session.writeKinds, 9007])],
        },
      });
    });
    await openTemplates(page, app);
    await saveTemplate(page);
    const saved = kitWrites(app);
    await openPage(page, "Messages");
    await page
      .locator('[data-sidebar-section="channels"]')
      .getByRole("button", { name: "Create channel", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Create a channel",
      exact: true,
    });
    const name = editor.getByRole("textbox", { name: "Name", exact: true });
    await name.fill("incident-room");
    const template = editor.getByRole("combobox", {
      name: "Template",
      exact: true,
    });
    await template.click();
    await page
      .getByRole("option", { name: "Incident plan", exact: true })
      .click();
    await expect(template).toContainText("Incident plan");
    for (const dismissal of ["backdrop", "escape"]) {
      await template.click();
      const option = page.getByRole("option", {
        name: "None — blank channel",
        exact: true,
      });
      await expect(option).toBeVisible();
      // The Select popup is portaled outside its parent dialog.
      expect(
        await option.evaluate((node) => !!node.closest('[role="dialog"]')),
      ).toBe(false);
      await option.click();
      const confirmation = page.getByRole("dialog", {
        name: "Replace channel setup?",
        exact: true,
      });
      await expect(
        confirmation.getByRole("button", { name: "Cancel", exact: true }),
      ).toBeFocused();
      if (dismissal === "backdrop") {
        await dragOutside(page, confirmation);
        await expect(confirmation).toBeVisible();
        await confirmation.evaluate(async (node) => {
          await Promise.all(
            node
              .getAnimations({ subtree: true })
              .map((animation) => animation.finished),
          );
        });
        await page.screenshot({
          path: info.outputPath("template-replacement.png"),
        });
        await page.mouse.click(8, 8);
      } else await page.keyboard.press("Escape");
      await expect(confirmation).toHaveCount(0);
      await expect(editor).toBeVisible();
      await expect(template).toBeFocused();
      await expect(template).toContainText("Incident plan");
      await expect(name).toHaveValue("incident-room");
      expect(kitWrites(app)).toEqual(saved);
      expect(app.report.lifecyclePublications ?? []).toEqual([]);
    }
    // Cancelling the outer draft follows its existing discard contract.
    await page.mouse.click(8, 8);
    const discard = page.getByRole("dialog", {
      name: "Discard changes?",
      exact: true,
    });
    await expect(discard).toBeVisible();
    await discard
      .getByRole("button", { name: "Keep editing", exact: true })
      .click();
    await expect(template).toContainText("Incident plan");
    await expect(name).toHaveValue("incident-room");
    expect(app.report.lifecyclePublications ?? []).toEqual([]);
  });
});

function kitWrites(app) {
  return (app.report.sidebarPublications ?? [])
    .filter(({ coordinate }) => coordinate.startsWith("buzz-channel-kit-v1:"))
    .map(({ event }) => event.id);
}

async function dragOutside(page, dialog) {
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds.x + 30, bounds.y + 25);
  await page.mouse.down();
  await page.mouse.move(8, 8);
  await page.mouse.up();
}
