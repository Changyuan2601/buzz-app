import { test, expect } from "./source-fixture.mjs";

// Recipients sit beside the text, so a name typed into the text can neither
// add a notification nor take one over from the recipient.
test("a name typed into the text neither adds nor transfers a notification", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const first = await page.evaluate(() => window.mentionFixture.first);
  const input = page.getByRole("textbox", { name: "Message #General" });
  const chip = page.getByRole("button", {
    name: `Remove mention Honey ${first}`,
    exact: true,
  });
  const publications = () =>
    page.evaluate(() => window.mentionFixture.publications);
  const cases = [
    // The chip alone notifies, once, whatever the text says.
    { chip: true, text: "bee @Honey" },
    // Without the chip the same text notifies nobody.
    { chip: false, text: "Hi @Honey" },
  ];
  for (const [index, scenario] of cases.entries()) {
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page
      .getByRole("button", { name: `Honey ${first}`, exact: true })
      .click();
    await expect(chip).toBeVisible();
    await expect(input).toHaveJSProperty("value", "");
    await expect(input).toBeFocused();
    if (!scenario.chip) {
      await chip.click();
      await expect(chip).toHaveCount(0);
    }
    await page.keyboard.insertText(scenario.text);
    await expect(input).toHaveJSProperty("value", scenario.text);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect
      .poll(async () => (await publications()).length)
      .toBe(index + 1);
    const event = (await publications())[index];
    expect(event.content).toBe(scenario.text);
    expect(event.tags.filter(([tag]) => tag === "p")).toEqual(
      scenario.chip ? [["p", first]] : [],
    );
    await expect(input).toHaveJSProperty("value", "");
  }
});

// Native contenteditable selection and React's no-op render boundary need a browser.
test("typing after an unchanged agent prefill does not consume a stale caret command", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const agent = await page.evaluate(() => window.mentionFixture.second);
  const input = page.getByRole("textbox", { name: "Message #General" });
  const chip = page.getByRole("button", {
    name: `Remove mention Honey ${agent}`,
    exact: true,
  });
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await page
    .getByRole("button", { name: `Honey (agent) ${agent}`, exact: true })
    .click();
  await expect(chip).toBeVisible();
  await expect(input).toHaveJSProperty("value", "");
  await expect(input).toBeFocused();
  // Repeat with the exact same next draft: no text, the remembered agent.
  // Clicking Send or refocusing the editor would introduce another render and
  // conceal the pending command.
  for (const count of [1, 2]) {
    await page.keyboard.type("hi");
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(() => window.mentionFixture.publications.length),
      )
      .toBe(count);
    await expect(input).toHaveJSProperty("value", "");
    await expect(chip).toBeVisible();
  }
  for (const [index, character] of [..."nice"].entries()) {
    await page.keyboard.type(character);
    await expect(input).toHaveJSProperty("value", "nice".slice(0, index + 1));
    await expect(input).toHaveJSProperty("selectionStart", index + 1);
    await expect(input).toHaveJSProperty("selectionEnd", index + 1);
  }
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(3);
  const sent = await page.evaluate(() => window.mentionFixture.publications[2]);
  expect(sent.content).toBe("nice");
  expect(sent.tags.filter(([tag]) => tag === "p")).toEqual([["p", agent]]);
  await expect(input).toHaveJSProperty("value", "");
  await expect(chip).toBeVisible();
});

// Reproduce focus returning between the native DOM edit and input/selectionchange.
// Normal locator typing focuses first and cannot exercise this browser boundary.
test("focus during the first edit after send preserves the advanced native caret", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const agent = await page.evaluate(() => window.mentionFixture.second);
  const input = page.getByRole("textbox", { name: "Message #General" });
  const chip = page.getByRole("button", {
    name: `Remove mention Honey ${agent}`,
    exact: true,
  });
  await page
    .getByRole("button", { name: "Mention a member", exact: true })
    .click();
  await page
    .getByRole("button", { name: `Honey (agent) ${agent}`, exact: true })
    .click();
  await expect(chip).toBeVisible();
  await expect(input).toHaveJSProperty("value", "");
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(1);
  await expect(input).toHaveJSProperty("value", "");
  await expect(chip).toBeVisible();

  const firstEdit = await input.evaluate((el) => {
    el.blur();
    const focusedBefore = document.activeElement === el;
    const allowed = el.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: "n",
      }),
    );
    if (!allowed) throw new Error("First insertion was prevented");
    // Model the native insertion while unfocused: the first character makes
    // the empty paragraph's text node. Advancing the real browser Selection
    // returns focus synchronously, before the queued selectionchange.
    const paragraph = el.querySelector("p");
    if (!paragraph) throw new Error("Expected an editable paragraph");
    const node = document.createTextNode("n");
    paragraph.prepend(node);
    const selection = getSelection();
    selection.setBaseAndExtent(node, 1, node, 1);
    const result = {
      focusedBefore,
      focusedAfter: document.activeElement === el,
      // Native DOM edits reach the transaction model at the mutation-observer
      // boundary. Inspect the native caret here, then the model below.
      caret: [1, selection.focusOffset],
    };
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: "n",
      }),
    );
    return result;
  });
  expect(firstEdit).toEqual({
    focusedBefore: false,
    focusedAfter: true,
    caret: [1, 1],
  });
  await expect(input).toHaveJSProperty("value", "n");
  await expect(input).toHaveJSProperty("selectionStart", 1);
  // Do not refocus with a locator action: continue from that native selection.
  await page.keyboard.type("ice");
  await expect(input).toHaveJSProperty("value", "nice");
  await expect(input).toHaveJSProperty("selectionStart", 4);
  await expect(input).toHaveJSProperty("selectionEnd", 4);
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => window.mentionFixture.publications.length))
    .toBe(2);
  const sent = await page.evaluate(() => window.mentionFixture.publications[1]);
  expect(sent.content).toBe("nice");
  expect(sent.tags.filter(([tag]) => tag === "p")).toEqual([["p", agent]]);
  await expect(input).toHaveJSProperty("value", "");
  await expect(chip).toBeVisible();
});
