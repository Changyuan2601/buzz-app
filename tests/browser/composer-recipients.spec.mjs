import { test, expect } from "./source-fixture.mjs";

// Browser-only: native selection, focus and bold formatting in the real editor
// must stay put when the recipients beside the text are replaced.
test("recipient replacement leaves the prose, its selection, formatting and focus alone", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/mentions.html");
  const input = page.getByRole("textbox", { name: "Message #General" });
  const chip = (key) =>
    page.getByRole("button", {
      name: new RegExp(`^Remove mention .+ ${key}$`),
    });
  const [first, second] = await page.evaluate(() => [
    window.mentionFixture.first,
    window.mentionFixture.second,
  ]);
  await input.fill("Keep this prose");
  await input.press("ControlOrMeta+a");
  await input.press("ControlOrMeta+b");
  const replace = (which) =>
    page.evaluate(
      (which) =>
        window.mentionFixture.replaceRecipients([
          {
            pubkey: window.mentionFixture[which],
            name: which === "first" ? "Honey" : "Mary Jane",
          },
        ]),
      which,
    );
  await expect.poll(() => replace("first")).toBe(true);
  await expect(chip(first)).toBeVisible();
  await input.evaluate((el) => el.setSelectionRange(12, 16));
  const selected = () =>
    input.evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
  const before = await selected();
  expect(await replace("second")).toBe(true);
  // The second replaces the first; the text and its caret are untouched.
  await expect(chip(second)).toBeVisible();
  await expect(chip(first)).toHaveCount(0);
  await expect(input).toBeFocused();
  await expect(input).toHaveJSProperty("value", "Keep this prose");
  expect(await selected()).toBe(before);
  await expect(input.locator("strong")).toContainText("Keep this prose");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.mentionFixture.publications.filter((event) => event.kind === 9)
            .length,
      ),
    )
    .toBe(1);
  const sent = await page.evaluate(() =>
    window.mentionFixture.publications.find((event) => event.kind === 9),
  );
  expect(
    sent.tags.filter(([tag]) => tag === "p").map(([, key]) => key),
  ).toEqual([second]);
  expect(sent.content).toBe("@Mary Jane **Keep this prose**");
});

for (const enabled of [true, false]) {
  test(`recipient replacement keeps explicitly ${enabled ? "enabled" : "disabled"} bold typing`, async ({
    page,
  }) => {
    await page.goto("/tests/fixtures/mentions.html");
    const input = page.getByRole("textbox", { name: "Message #General" });
    await input.fill(enabled ? "" : "bold");
    if (!enabled) {
      await input.press("ControlOrMeta+a");
      await input.press("ControlOrMeta+b");
      await input.evaluate((el) => el.setSelectionRange(2, 2));
    }
    await input.press("ControlOrMeta+b");
    expect(
      await page.evaluate(() =>
        window.mentionFixture.replaceRecipients([
          { pubkey: window.mentionFixture.first, name: "Honey" },
        ]),
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", { name: /^Remove mention Honey / }),
    ).toBeVisible();
    await input.press("X");
    const bold = await input.locator("strong").allTextContents();
    expect(bold.some((text) => text.includes("X"))).toBe(enabled);
  });
}
