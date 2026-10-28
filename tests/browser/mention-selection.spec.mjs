import { test, expect } from "./source-fixture.mjs";
import { wcagRatio } from "../../scripts/design-system/apca.mjs";

// Recipients sit beside the text, so no mention is an atom inside it: native
// caret and selection movement is plain prose editing and needs no handoff.
async function compose(page) {
  await page.goto("/tests/fixtures/mentions.html");
  const keys = await page.evaluate(() => ({
    first: window.mentionFixture.first,
    second: window.mentionFixture.second,
  }));
  const input = page.getByRole("textbox", { name: "Message #General" });
  const mention = async (name) => {
    await page
      .getByRole("button", { name: "Mention a member", exact: true })
      .click();
    await page.getByRole("button", { name, exact: true }).click();
    await expect(input).toBeFocused();
  };
  await input.click();
  await mention(`Honey ${keys.first}`);
  await page.keyboard.type("say hello to ");
  await mention(`Honey (agent) ${keys.second}`);
  await expect(input).toHaveJSProperty("value", "say hello to ");
  return { input };
}

// Only browser paint can prove nested fills remain visible on the real composer.
test("composer code and recipient fills remain distinct in both themes", async ({
  page,
}) => {
  const { input } = await compose(page);
  await page
    .getByRole("button", { name: "Toggle formatting", exact: true })
    .click();
  await page.getByRole("button", { name: "Code", exact: true }).click();
  await page.keyboard.type("sample");
  await expect(input.locator("code")).toHaveText("sample");
  await page
    .getByRole("button", { name: "Close formatting", exact: true })
    .click();
  const composer = input.locator("xpath=ancestor::form");
  await expect(composer.locator("[data-recipients]")).toBeVisible();
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await settleComposer(page, composer);
    const points = await composer.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const code = el.querySelector("code").getBoundingClientRect();
      const pill = el
        .querySelector("[data-recipients]")
        .getBoundingClientRect();
      return {
        clip: {
          x: Math.floor(box.left),
          y: Math.floor(box.top),
          width: Math.ceil(box.right) - Math.floor(box.left),
          height: Math.ceil(box.bottom) - Math.floor(box.top),
        },
        surface: { x: box.right - 10, y: box.top + box.height / 2 },
        code: { x: code.left + 1, y: code.top + code.height / 2 },
        pill: { x: pill.left + 1, y: pill.top + pill.height / 2 },
      };
    });
    const colors = await samplePaint(page, points);
    expect.soft(colors.code, `${mode} inline code`).not.toEqual(colors.surface);
    expect
      .soft(colors.pill, `${mode} recipient pill`)
      .not.toEqual(colors.surface);
    await page
      .getByRole("button", { name: "Toggle formatting", exact: true })
      .click();
    const active = page.getByRole("button", { name: "Code", exact: true });
    await expect(active).toHaveAttribute("aria-pressed", "true");
    await page.mouse.move(0, 0);
    await settleComposer(page, composer);
    const surface = await composer.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await expect(active).not.toHaveCSS("background-color", surface);
    const resting = await active.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    await active.hover();
    await settleComposer(page, composer);
    await expect(active).not.toHaveCSS("background-color", resting);
    await page.mouse.move(0, 0);
    await settleComposer(page, composer);
    await expect(active).toHaveCSS("background-color", resting);
    await page
      .getByRole("button", { name: "Close formatting", exact: true })
      .click();
  }
});

async function settleComposer(page, composer) {
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect
    .poll(() =>
      composer.evaluate(
        (el) =>
          el
            .getAnimations({ subtree: true })
            .filter((a) => a.playState === "running" || a.pending).length,
      ),
    )
    .toBe(0);
}

async function samplePaint(page, points) {
  const png = await page.screenshot({ clip: points.clip, scale: "css" });
  return page.evaluate(
    async ({ base64, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const { clip, ...samples } = points;
      return Object.fromEntries(
        Object.entries(samples).map(([name, { x, y }]) => [
          name,
          [
            ...context.getImageData(
              Math.round(x - clip.x),
              Math.round(y - clip.y),
              1,
              1,
            ).data,
          ].slice(0, 3),
        ]),
      );
    },
    { base64: png.toString("base64"), points },
  );
}

// Real CSS inheritance and native selection paint are not observable in jsdom.
test("selection remains visible on outgoing bubbles and their neutral content", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/message-gallery.html");
  const own = page.getByRole("region", {
    name: "Your links and mentions",
    exact: true,
  });
  await own.getByRole("button", { name: "Reveal spoiler" }).click();
  const targets = [
    own.locator('[class*="messageBubble"] p').first(),
    own.locator('[data-revealed="true"]'),
    page
      .getByRole("region", { name: "Rich text", exact: true })
      .locator("code"),
    page
      .getByRole("region", { name: "Linked table content", exact: true })
      .locator("td")
      .first(),
    page
      .getByRole("region", { name: "Code diff preview", exact: true })
      .locator("[data-diff-only] p")
      .first(),
  ];
  for (const [mode, accent] of [
    ["light", "magenta"],
    ["dark", "mono"],
  ]) {
    await page.evaluate(
      ({ mode, accent }) => {
        Object.assign(document.documentElement.dataset, {
          colorMode: mode,
          accent,
          colorLevel: "high",
        });
      },
      { mode, accent },
    );
    for (const target of targets) {
      await expect(target).toBeVisible();
      const colors = await target.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        let parent = el;
        while (getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)")
          parent = parent.parentElement;
        const selection = getComputedStyle(el, "::selection");
        const hex = (rgb) =>
          "#" +
          rgb
            .match(/\d+/g)
            .slice(0, 3)
            .map((n) => Number(n).toString(16).padStart(2, "0"))
            .join("");
        return {
          surface: hex(getComputedStyle(parent).backgroundColor),
          fill: hex(selection.backgroundColor),
          text: hex(selection.color),
        };
      });
      expect(
        wcagRatio(colors.fill, colors.surface),
        `${mode}/${accent} selection on ${await target.textContent()}`,
      ).toBeGreaterThanOrEqual(3);
      expect(wcagRatio(colors.text, colors.fill)).toBeGreaterThanOrEqual(4.5);
    }
  }
});
