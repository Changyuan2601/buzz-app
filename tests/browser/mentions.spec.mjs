import { test, expect } from "./playwright-test.mjs";
import { createServer } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

test("settings-enabled mentions fixture renders the composer and preference", async ({
  page,
}) => {
  // This optional fixture mode mounts the real Vite entry point, not an exported component.
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html?settings`,
    );
    await expect(page.getByRole("textbox")).toBeVisible();
    await expect(page.getByText("Remember mentioned agents")).toBeVisible();
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

test("actual composer selects namesakes by exact key, publishes channel/reply tags, and asks before mentioning removed members", async ({
  page,
}) => {
  // This journey exercises one-message recipients; prefill-on has separate coverage.
  await page.addInitScript(() => {
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  });
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      // Match the app server: native builds must not reload an editing fixture.
      watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
    },
  });
  const errors = watchPageErrors(page);
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html?test-controls`,
    );
    await expect(page.getByRole("textbox")).toBeVisible();
    const keys = await page.evaluate(() => ({
      first: window.mentionFixture.first,
      second: window.mentionFixture.second,
    }));
    // Real layout is required: the popup follows the whole composer, including
    // multiple lines of text, rather than the trigger's toolbar position.
    const expectComposerAnchor = async (popup) => {
      await expect(popup).toHaveClass(/buzz-popover/);
      expect(
        await popup.evaluate((element) => element.closest("form") === null),
      ).toBe(true);
      await expect(popup).toHaveCSS("border-radius", "24px");
      await expect
        .poll(() =>
          popup.evaluate((element) => {
            const composer = document.querySelector("form");
            return (
              composer.getBoundingClientRect().top -
              element.getBoundingClientRect().bottom
            );
          }),
        )
        .toBe(4);
    };
    const choose = async (key) => {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      const picker = page.getByRole("dialog", {
        name: "Mention a member or agent",
      });
      const search = picker.getByRole("searchbox");
      // Both fixture keys are Honey namesakes; public keys are not search terms.
      await search.fill("Honey");
      await expect(
        picker.getByRole("button", { name: new RegExp(key) }),
      ).toBeVisible();
      await expect(search).toBeFocused();
      await expectComposerAnchor(picker);
      await expect(picker).toHaveCSS("width", "380px");
      expect((await picker.boundingBox()).height).toBeLessThanOrEqual(360);
      await search.fill("");
      const choice = picker.getByRole("button", {
        name: new RegExp(key),
      });
      const index = await choice.evaluate((node) =>
        [
          ...node.parentElement.querySelectorAll("[data-mention-choice]"),
        ].indexOf(node),
      );
      // Focus stays in search; the first row starts highlighted.
      for (let step = 0; step < index; step++) await search.press("ArrowDown");
      await expect(choice).toHaveAttribute("data-selected", "true");
      await expect(search).toBeFocused();
      await expect(choice).toHaveCSS("padding", "8px");
      await expect(choice.locator(".buzz-avatar")).toHaveCSS("width", "40px");
      await search.press("ArrowUp");
      await search.press("ArrowDown");
      await expect(choice).toHaveAttribute("data-selected", "true");
      await search.press("Enter");
      await expect(picker).toHaveCount(0);
      await expect(page.getByRole("textbox")).toBeFocused();
    };
    const order = () =>
      page
        .getByRole("button", { name: /^(Mention a member|Emoji and GIFS)$/ })
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label")),
        );
    await expect.poll(order).toEqual(["Mention a member", "Emoji and GIFS"]);
    // Browser-only contract: native shadow search and React search share their
    // shape, typography, clear target and alignment in both appearance modes.
    const searchAppearance = async (field) => {
      // Main animates field focus; compare settled appearance, not an arbitrary frame.
      await field.evaluate(async (element) => {
        await Promise.all(
          element
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished),
        );
      });
      return field.evaluate((element) => {
        const nativeInput = element.querySelector("input");
        // Both the React and vendor search use the shared field boundary.
        const style = getComputedStyle(
          element.matches(".search-field") ? element : nativeInput,
        );
        const input = getComputedStyle(nativeInput);
        const clear = element.querySelector("button");
        return {
          height: style.height,
          radius: style.borderRadius,
          background: style.backgroundColor,
          border: style.border,
          color: input.color,
          font: input.font,
          clear: clear && {
            width: getComputedStyle(clear).width,
            height: getComputedStyle(clear).height,
            radius: getComputedStyle(clear).borderRadius,
            color: getComputedStyle(clear).color,
          },
        };
      });
    };
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .click();
      const mention = page.getByRole("dialog", {
        name: "Mention a member or agent",
      });
      const row = mention.getByRole("button", {
        name: `Honey ${keys.first}`,
        exact: true,
      });
      await expect(row).toHaveCSS("padding", "8px");
      // The first row opens highlighted, so Enter picks it.
      const highlighted = mention.locator(
        "[data-mention-choice][data-selected]",
      );
      await expect(highlighted).toHaveCount(1);
      await expect(
        mention.locator("[data-mention-choice]").first(),
      ).toHaveAttribute("data-selected", "true");
      await expect(highlighted).toHaveCSS(
        "background-color",
        mode === "light" ? "rgb(218, 218, 218)" : "rgb(64, 64, 64)",
      );
      await mention.getByRole("searchbox").fill("");
      const empty = await searchAppearance(mention.locator(".search-field"));
      await mention.getByRole("searchbox").fill("Honey");
      const filled = await searchAppearance(mention.locator(".search-field"));
      await page
        .getByRole("button", { name: "Emoji and GIFS", exact: true })
        .click();
      const emojiField = page.locator("em-emoji-picker .search");
      await expect(emojiField.getByRole("searchbox")).toBeFocused();
      expect(await searchAppearance(emojiField)).toEqual(empty);
      const emojiSearch = emojiField.getByRole("searchbox");
      await emojiSearch.fill("face");
      await expect(
        emojiField.getByRole("button", { name: "Clear", exact: true }),
      ).toBeVisible();
      expect(await searchAppearance(emojiField)).toEqual(filled);
      await emojiField
        .getByRole("button", { name: "Clear", exact: true })
        .click();
      await expect(emojiSearch).toHaveValue("");
      await expect(emojiSearch).toBeFocused();
      await emojiSearch.press("Escape");
    }
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "light";
    });
    const input = page.getByRole("textbox", { name: "Message #General" });
    const recipients = page.getByRole("region", {
      name: "Explicit mentions",
    });
    const chip = (key) =>
      recipients.getByRole("button", {
        name: `Remove mention Honey ${key}`,
        exact: true,
      });
    // A picked person is a recipient beside the text, not text in it.
    await choose(keys.first);
    await expect(chip(keys.first)).toBeVisible();
    await expect(input).toHaveJSProperty("value", "");
    await choose(keys.second);
    await expect(recipients.getByRole("button")).toHaveCount(2);
    await expect(chip(keys.second)).toBeVisible();
    await expect(input).toHaveJSProperty("value", "");
    await expect(input.locator(".inline-chip")).toHaveCount(0);
    // The picker returned focus to the editor, so typing goes straight in.
    await page.keyboard.type("x");
    await expect(input).toHaveJSProperty("value", "x");
    await page.keyboard.press("Backspace");
    await expect(input).toHaveJSProperty("value", "");
    await expect(recipients.getByRole("button")).toHaveCount(2);
    // The merged toolbar must preserve exact recipients while the new picker
    // inserts Unicode and follows the host mode without recreating the draft.
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    await page
      .getByRole("button", { name: "Emoji and GIFS", exact: true })
      .click();
    const search = page.getByRole("searchbox", { name: "Search" });
    await expect(page.locator("em-emoji-picker #root")).toHaveAttribute(
      "data-theme",
      "dark",
    );
    await expectComposerAnchor(
      page.getByRole("dialog", { name: "Emoji picker" }),
    );
    await search.fill("grinning");
    await page.getByRole("button", { name: "😀", exact: true }).click();
    await expect(input).toHaveJSProperty("value", "😀");
    await expect(recipients.getByRole("button")).toHaveCount(2);
    await expect(
      recipients.locator('.buzz-avatar[data-avatar-shape="circle"]'),
    ).toHaveCount(1);
    await expect(
      recipients.locator('.buzz-avatar[data-avatar-shape="squircle"]'),
    ).toHaveCount(1);
    await expect
      .poll(() =>
        recipients
          .locator("img")
          .evaluateAll(
            (images) =>
              images.length === 2 &&
              images.every((image) => image.complete && image.naturalWidth > 0),
          ),
      )
      .toBe(true);
    const mentionTool = page.getByRole("button", {
      name: "Mention a member",
      exact: true,
    });
    const emojiTool = page.getByRole("button", {
      name: "Emoji and GIFS",
      exact: true,
    });
    await mentionTool.focus();
    for (const recipient of await recipients.getByRole("button").all()) {
      await page.keyboard.press("Tab");
      await expect(recipient).toBeFocused();
    }
    await page.keyboard.press("Tab");
    await expect(emojiTool).toBeFocused();
    // Browser-only: the recipient row's geometry across themes and widths.
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      for (const width of [360, 768, 1440]) {
        await page.setViewportSize({ width, height: 950 });
        // Avatars stay beside @, before Emoji, even on the narrow composer.
        const mentionBox = await mentionTool.boundingBox();
        const recipientsBox = await recipients.boundingBox();
        const emojiBox = await emojiTool.boundingBox();
        expect(recipientsBox.x).toBeGreaterThanOrEqual(
          mentionBox.x + mentionBox.width,
        );
        expect(recipientsBox.x + recipientsBox.width).toBeLessThanOrEqual(
          emojiBox.x,
        );
        expect(Math.abs(recipientsBox.y - mentionBox.y)).toBeLessThanOrEqual(2);
        await expect(input).toHaveJSProperty("value", "😀");
      }
    }
    await page.screenshot({
      path: test.info().outputPath("mention-recipients.png"),
    });
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.mentionFixture.publications.length ||
            window.mentionFixture
              .outbox()
              .map((item) => ({ state: item.delivery, error: item.error })),
        ),
      )
      .toBe(1);
    const first = await page.evaluate(
      () => window.mentionFixture.publications[0],
    );
    expect(first.content).toBe("@Honey @Honey 😀");
    expect(first.tags.filter(([tag]) => tag === "p")).toEqual([
      ["p", keys.first],
      ["p", keys.second],
    ]);
    expect(first.tags.filter(([tag]) => tag === "h")).toEqual([["h", "c"]]);
    await page.getByRole("button", { name: "Toggle thread" }).click();
    await choose(keys.second);
    await page.evaluate(() =>
      window.mentionFixture.change("disable", "buzz.mentions"),
    );
    await expect(
      page.getByRole("button", { name: "Mention a member", exact: true }),
    ).toHaveCount(0);
    // Recipients stay with the composer after the chooser is disabled.
    await expect(recipients.getByRole("button")).toHaveCount(1);
    await expect(chip(keys.second)).toBeVisible();
    await page.getByRole("textbox").pressSequentially("reply");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(2);
    const reply = await page.evaluate(
      () => window.mentionFixture.publications[1],
    );
    expect(reply.content).toBe("@Honey reply");
    expect(reply.tags).toContainEqual(["e", "a".repeat(64), "", "reply"]);
    expect(reply.tags.filter(([tag]) => tag === "p")).toEqual([
      ["p", keys.second],
    ]);
    await page.evaluate(() =>
      window.mentionFixture.change("enable", "buzz.mentions"),
    );
    await expect.poll(order).toEqual(["Mention a member", "Emoji and GIFS"]);
    await choose(keys.first);
    await page.getByRole("textbox").pressSequentially("hi");
    await page
      .getByRole("button", { name: "Remove first Honey", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    // An untyped channel is an ordinary channel: the removed member is now
    // outside it, so the sender chooses. Closing keeps the draft unsent.
    const outside = page.getByRole("dialog", {
      name: "Mention people outside this channel?",
    });
    await expect(outside).toContainText("Honey is not in this channel.");
    await outside.getByRole("button", { name: "Close" }).click();
    await expect(outside).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveJSProperty("value", "hi");
    expect(
      await page.evaluate(() => window.mentionFixture.publications.length),
    ).toBe(2);
    // A child layout effect sees disabled DOM before parent command props refresh.
    // Both commands must fail, even with the previous render's enabled closures.
    // The outside-person prompt above also disabled the composer once.
    const before = await page.evaluate(
      () => window.mentionFixture.disabledCalls.length,
    );
    await page
      .getByRole("button", { name: "Toggle disabled", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toBeDisabled();
    await expect(recipients.getByRole("button")).toBeDisabled();
    expect(
      await page.evaluate(() => window.mentionFixture.disabledCalls),
    ).toEqual(
      Array(before + 1).fill({
        inputDisabled: true,
        text: false,
        mention: false,
      }),
    );
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveJSProperty("value", "hi");
    await expect(recipients.getByRole("button")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Toggle disabled", exact: true })
      .click();
    await choose(keys.second);
    await expect(recipients.getByRole("button")).toHaveCount(2);
    await expect(
      page.getByRole("textbox", { name: "Reply to thread" }),
    ).toHaveJSProperty("value", "hi");
    await chip(keys.first).click();
    await expect(chip(keys.first)).toHaveCount(0);
    await expect(page.getByRole("textbox")).toBeFocused();
    await expect(page.getByRole("textbox")).toHaveJSProperty("value", "hi");
    await expect(recipients.getByRole("button")).toHaveCount(1);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(3);
    const afterRemoval = await page.evaluate(() =>
      window.mentionFixture.publications.at(-1),
    );
    expect(afterRemoval.content).toBe("@Honey hi");
    expect(afterRemoval.tags.filter(([tag]) => tag === "p")).toEqual([
      ["p", keys.second],
    ]);
    expect(errors.unexplained()).toEqual([]);
  } finally {
    await server.close();
  }
});

test("picking inside a code literal leaves it alone and keeps recipients through draft restore and channel/reply publication", async ({
  page,
}) => {
  // Browser-only boundary: real picker insertion with the caret in a code literal.
  await page.addInitScript(() => {
    localStorage.setItem("buzz-remember-mentioned-agents.v1", "off");
  });
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      // Match the app server: native builds must not reload an editing fixture.
      watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
    },
  });
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html?test-controls`,
    );
    await expect(page.getByRole("textbox")).toBeVisible();
    const keys = await page.evaluate(() => [
      window.mentionFixture.first,
      window.mentionFixture.second,
    ]);
    const input = page.getByRole("textbox");
    const recipients = page.getByRole("region", {
      name: "Explicit mentions",
    });
    for (const reply of [false, true]) {
      await input.fill("`run`");
      await input.evaluate((element) => element.setSelectionRange(2, 2));
      for (const key of keys) {
        await page
          .getByRole("button", { name: "Mention a member", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Mention a member or agent" })
          .getByRole("button", { name: new RegExp(key) })
          .click();
      }
      const source = "`run`";
      await expect(input).toHaveJSProperty("value", source);
      await expect(recipients.getByRole("button")).toHaveCount(2);
      // Retargeting unmounts the destination's composer and restores its saved draft.
      await page.getByRole("button", { name: "Toggle thread" }).click();
      await expect(input).toHaveJSProperty("value", "");
      await expect(recipients).toBeHidden();
      await page.getByRole("button", { name: "Toggle thread" }).click();
      await expect(input).toHaveJSProperty("value", source);
      await expect(recipients.getByRole("button")).toHaveCount(2);
      await input.focus();
      await input.press("ControlOrMeta+a");
      const copied = await input.evaluate((element) => {
        const clipboardData = new DataTransfer();
        element.dispatchEvent(
          new ClipboardEvent("copy", {
            bubbles: true,
            cancelable: true,
            clipboardData,
          }),
        );
        return clipboardData.getData("text/plain");
      });
      expect(copied).toBe(source);
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => window.mentionFixture.publications.length),
        )
        .toBe(reply ? 2 : 1);
      const sent = await page.evaluate(() =>
        window.mentionFixture.publications.at(-1),
      );
      expect(sent.content).toBe(`@Honey @Honey ${source}`);
      expect(sent.tags.filter(([tag]) => tag === "p")).toEqual(
        keys.map((key) => ["p", key]),
      );
      expect(sent.tags.filter(([tag]) => tag === "h")).toEqual([["h", "c"]]);
      expect(sent.tags.filter(([tag]) => tag === "e")).toEqual(
        reply ? [["e", "a".repeat(64), "", "reply"]] : [],
      );
      if (!reply)
        await page.getByRole("button", { name: "Toggle thread" }).click();
    }
  } finally {
    await server.close();
  }
});

// Browser-only contract: at touch width, tapped namesakes stay separate
// recipients, inside the viewport, and keep their keys through live name changes.
test("namesake recipients stay distinct and in view on touch after live name changes", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  const server = await createServer({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    configFile: false,
    envFile: false,
    plugins: [react()],
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      // Match the app server: native builds must not reload an editing fixture.
      watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
    },
  });
  try {
    await server.listen();
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/mentions.html?identity-names`,
    );
    await page.evaluate(() => {
      document.documentElement.dataset.colorMode = "dark";
    });
    const keys = await page.evaluate(() => [
      window.mentionFixture.first,
      window.mentionFixture.second,
    ]);
    const choose = async (key) => {
      await page
        .getByRole("button", { name: "Mention a member", exact: true })
        .tap();
      await page
        .getByRole("dialog", { name: "Mention a member or agent" })
        .getByRole("button", { name: new RegExp(key) })
        .tap();
    };
    await page.evaluate(() => window.mentionFixture.collide(false));
    await choose(keys[0]);
    await choose(keys[1]);
    const input = page.getByRole("textbox");
    const recipients = page.getByRole("region", {
      name: "Explicit mentions",
    });
    const chips = recipients.getByRole("button");
    const chip = (key) =>
      recipients.getByRole("button", { name: new RegExp(`${key}$`) });
    await expect(chips).toHaveCount(2);
    await expect(chip(keys[0])).toBeVisible();
    await expect(chip(keys[1])).toBeVisible();
    await expect(input).toHaveJSProperty("value", "");
    await page.evaluate(() => window.mentionFixture.collide(true));
    await expect(chips).toHaveCount(2);
    const inView = async () => {
      for (const item of await chips.all()) {
        await expect(item).toBeVisible();
        expect(
          await item.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth;
          }),
        ).toBe(true);
      }
    };
    await inView();
    await page.screenshot({
      path: test.info().outputPath("recipient-namesakes-touch.png"),
    });
    // Removing one leaves the other; adding it back restores both.
    await chip(keys[1]).tap();
    await expect(chips).toHaveCount(1);
    await expect(chip(keys[0])).toBeVisible();
    await choose(keys[1]);
    await expect(chips).toHaveCount(2);
    await page.evaluate(() => window.mentionFixture.collide(false));
    await expect(chips).toHaveCount(2);
    await inView();
    await input.pressSequentially("hello");
    await page.getByRole("button", { name: "Send message", exact: true }).tap();
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(1);
    const sent = await page.evaluate(
      () => window.mentionFixture.publications[0],
    );
    expect(sent.content).toBe("@Honey @Honey hello");
    expect(
      sent.tags
        .filter((tag) => tag[0] === "p")
        .map((tag) => tag[1])
        .sort(),
    ).toEqual(keys.sort());
  } finally {
    await context.close();
    await server.close();
  }
});
