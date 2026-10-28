import { npubEncode } from "nostr-tools/nip19";
import { test, expect } from "./fixture.mjs";
import { open } from "./timeline.mjs";

test.use({ productionBroker: true });

// The timeline shows a raw message link under its channel's name, but only an
// authored label copies.
const link = `buzz://message?channel=alpha&id=${"b".repeat(64)}`;
const linkHtml = link.replace("&", "&amp;");
const anchors = (viewer) =>
  `Ping <a href="nostr:${npubEncode(viewer)}">@Fixture Reader</a> about <a href="buzz://channel/beta">#Beta</a>, <a href="${linkHtml}">${linkHtml}</a> and <a href="${linkHtml}">Alpha</a>`;
// The composer keeps recipients beside its text, so its own copy has none.
const proseAnchors = `Ping about <a href="buzz://channel/beta">#Beta</a>, <a href="${linkHtml}">${linkHtml}</a> and <a href="${linkHtml}">Alpha</a>`;

/** Deliver both flavors at once, as a real clipboard does. */
const pasteInto = (input, payload) =>
  input.evaluate((element, { text, html }) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    clipboardData.setData("text/html", html);
    element.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
  }, payload);

// Browser-only contract: an engine-native pointer selection copied from the
// timeline reaches the composer through real clipboard flavors, DOMParser and
// the live session's mention candidates, then round-trips composer → composer.
// A pasted profile link becomes a recipient chip and leaves the text.
// Serializer and promotion cases live in the colocated Vitest files.
test("pasting copied messages into the composer restores chips, the recipient and links", async ({
  page,
  app,
  browserName,
}) => {
  await open(page, app);
  const event = app.append(
    "primary",
    "alpha",
    `Ping @Fixture Reader about #Beta, ${link} and [Alpha](${link})`,
    true,
    true,
    undefined,
    undefined,
    [["p", app.viewer]],
  );
  const row = page.locator(
    `[data-channel-timeline] [data-message-id="${event.id}"]`,
  );
  await expect(
    row
      .locator("p")
      .getByRole("button", { name: "View Fixture Reader profile" }),
  ).toBeVisible();
  await expect(row.getByRole("link", { name: "#Beta" })).toBeVisible();
  await expect(row.getByRole("link", { name: "Alpha" })).toHaveCount(2);
  const paragraph = row.locator("p").first();
  const box = await paragraph.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await page.evaluate(() => {
    window.__copyPayload = undefined;
    document.addEventListener(
      "copy",
      (event) => {
        window.__copyPayload = {
          text: event.clipboardData?.getData("text/plain"),
          html: event.clipboardData?.getData("text/html"),
        };
      },
      { once: true },
    );
  });
  // See timeline-copy.spec.mjs for the WebKit copy command.
  if (browserName === "webkit")
    expect(await page.evaluate(() => document.execCommand("copy"))).toBe(true);
  else await page.keyboard.press("ControlOrMeta+c");
  const timeline = {
    text: `Ping @Fixture Reader about #Beta, ${link} and Alpha (${link})`,
    html: `<div data-buzz-copy="timeline"><p>${anchors(app.viewer)}</p></div>`,
  };
  await expect
    .poll(() => page.evaluate(() => window.__copyPayload))
    .toEqual(timeline);

  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  const recipients = page.getByRole("region", { name: "Explicit mentions" });
  const reader = recipients.getByRole("button", {
    name: `Remove mention Fixture Reader ${app.viewer}`,
    exact: true,
  });
  const prose = `Ping about [#Beta](buzz://channel/beta), ${link} and [Alpha](${link})`;
  await input.click();
  await pasteInto(input, timeline);
  await expect(input).toHaveJSProperty("value", prose);
  await expect(input.locator("[data-source]")).toHaveCount(3);
  await expect(input.locator(".inline-chip")).toHaveCount(0);
  await expect(reader).toBeVisible();

  // Composer → composer keeps the prose and links through the composer's own
  // flavors; the recipient stays beside the text, so it is not in them.
  const composer = await input.evaluate((element) => {
    element.setSelectionRange(0, element.value.length);
    const clipboardData = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return {
      text: clipboardData.getData("text/plain"),
      html: clipboardData.getData("text/html"),
    };
  });
  // text/plain stays Markdown source except for channel locators.
  expect(composer).toEqual({
    text: `Ping about #Beta, ${link} and [Alpha](${link})`,
    html: `<div data-buzz-copy="composer"><p>${proseAnchors}</p></div>`,
  });

  // The recipient is the chip's, not the text's: the send tags it.
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(1);
  const published = app.report.publications[0].event;
  expect(published.content).toBe(prose);
  expect(published.tags).toContainEqual(["p", app.viewer]);
  await expect(input).toHaveJSProperty("value", "");
  await expect(recipients).toBeHidden();

  // Pasting the composer's flavors restores the text and adds no recipient.
  await pasteInto(input, composer);
  await expect(input).toHaveJSProperty("value", prose);
  await expect(recipients).toBeHidden();
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(2);
  expect(app.report.publications[1].event.content).toBe(prose);
  expect(
    app.report.publications[1].event.tags.filter(([tag]) => tag === "p"),
  ).toEqual([]);

  // One representative renderer → clipboard → editor → signed-send round trip.
  // The detailed syntax matrix belongs to the colocated component tests.
  const blocks =
    "- one\n- two\n\n3. first\n\n> quoted\n\n```sh\necho hi\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |";
  const structured = app.append("primary", "alpha", blocks);
  const structuredRow = page.locator(
    `[data-channel-timeline] [data-message-id="${structured.id}"]`,
  );
  await expect(structuredRow.locator("table")).toBeVisible();
  const payload = await structuredRow.locator("ul").evaluate((list) => {
    const content = list.parentElement;
    const range = document.createRange();
    range.selectNodeContents(content);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    content.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return {
      text: clipboardData.getData("text/plain"),
      html: clipboardData.getData("text/html"),
    };
  });
  expect(payload.text).toBe(
    "one\ntwo\n\nfirst\n\nquoted\n\necho hi\n\na\tb\n1\t2",
  );
  await expect(input).toHaveJSProperty("value", "");
  await pasteInto(input, payload);
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(3);
  expect(app.report.publications[2].event.content).toBe(
    blocks.replace(/\| a \| b \|[\s\S]*$/, "a\tb\n1\t2"),
  );

  // A real picker-produced token carries Markdown escapes, unlike timeline HTML.
  await expect(input).toHaveJSProperty("value", "");
  await input.pressSequentially("#Bet");
  await page
    .getByRole("listbox", { name: "Channel suggestions" })
    .getByRole("option", { name: "Beta", exact: true })
    .click();
  const channelCopy = await input.evaluate((element) => {
    element.setSelectionRange(0, element.value.length);
    const clipboardData = new DataTransfer();
    element.dispatchEvent(
      new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }),
    );
    return {
      text: clipboardData.getData("text/plain"),
      html: clipboardData.getData("text/html"),
    };
  });
  expect(channelCopy.text).toBe("#Beta ");
  await input.fill("");
  await pasteInto(input, channelCopy);
  await expect(input.locator("[data-link-renderer]")).toHaveText("Beta");
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(4);
  expect(app.report.publications[3].event.content).toBe(
    "[#Beta](buzz://channel/beta)",
  );
});

// Browser integration: external clipboard HTML paints a labelled link in the
// actual composer and survives publication through the session.
test("external linked text stays linked in the composer and sent message", async ({
  page,
  app,
}) => {
  await open(page, app);
  const input = page.getByRole("textbox", {
    name: "Message #Alpha",
    exact: true,
  });
  await input.click();
  await pasteInto(input, {
    text: "Read the guide",
    html: '<p>Read <a href="https://example.com/guide">the guide</a></p>',
  });
  await expect(input).toHaveJSProperty(
    "value",
    "Read [the guide](https://example.com/guide)",
  );
  await expect(input.locator("[data-link-renderer]")).toHaveText("the guide");
  await input.press("Enter");
  await expect.poll(() => app.report.publications.length).toBe(1);
  expect(app.report.publications[0].event.content).toBe(
    "Read [the guide](https://example.com/guide)",
  );
});
