import { test, expect } from "./source-fixture.mjs";

// Serve eight seconds of generated PCM silence without committing a media asset.
test.beforeEach(async ({ page }) => {
  const samples = 8 * 8000 * 2;
  const wav = Buffer.alloc(44 + samples);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples, 40);
  await page.route("**/audio-sample.fixture", (route) =>
    route.fulfill({ contentType: "audio/wav", body: wav }),
  );
});

// Browser-only: this verifies the real CSS cascade and computed token colors;
// jsdom cannot compute the authored stylesheet or media-error presentation.
test("audio attachment errors keep the warning treatment in light and dark", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/fixtures/audio-attachment.html");
  await page
    .getByRole("button", { name: "Trigger audio error", exact: true })
    .click();
  const status = page.getByRole("status");
  await expect(status).toHaveText("Audio unavailable");

  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((element, theme) => {
      element.dataset.colorMode = theme;
    }, theme);
    const colors = await status.evaluate((element) => {
      const style = getComputedStyle(element);
      const rootStyle = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      probe.style.display = "none";
      document.body.append(probe);
      const readToken = (name) => {
        probe.style.color = rootStyle.getPropertyValue(name).trim();
        return getComputedStyle(probe).color;
      };
      const result = {
        background: style.backgroundColor,
        border: style.borderTopColor,
        color: style.color,
        expectedBackground: readToken("--affordance-warning"),
        expectedBorder: readToken("--border-warning"),
        expectedColor: readToken("--text-warning"),
      };
      probe.remove();
      return result;
    });
    expect(colors.background).toBe(colors.expectedBackground);
    expect(colors.border).toBe(colors.expectedBorder);
    expect(colors.color).toBe(colors.expectedColor);
    const screenshotPath = testInfo.outputPath(
      `audio-unavailable-${theme}.png`,
    );
    await status.screenshot({ path: screenshotPath, scale: "css" });
    await testInfo.attach(`audio-unavailable-${theme}`, {
      path: screenshotPath,
      contentType: "image/png",
    });
  }
});

// Browser-only: the real range hit area and intrinsic flex sizing must fit
// narrow message gutters; a DOM emulator cannot establish either geometry.
test("audio controls fit regular and narrow message widths", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/audio-attachment.html");
  const seek = page.getByRole("slider", { name: "Seek Sample", exact: true });
  await expect(seek).toBeEnabled();
  for (const width of ["regular", "narrow"]) {
    await page.locator("[data-audio-container]").evaluate((element, width) => {
      element.style.width = width === "narrow" ? "14rem" : "24rem";
    }, width);
    for (const theme of ["light", "dark"]) {
      await page.locator("html").evaluate((element, value) => {
        element.dataset.colorMode = value;
      }, theme);
      const colors = await page
        .getByRole("group", { name: "Sample", exact: true })
        .evaluate((card) => {
          const probe = document.createElement("span");
          probe.style.background = "var(--surface-inset)";
          probe.style.color = "var(--text-standard)";
          document.body.append(probe);
          const expected = getComputedStyle(probe);
          const actual = getComputedStyle(card);
          const result = {
            background: actual.backgroundColor,
            foreground: actual.color,
            expectedBackground: expected.backgroundColor,
            expectedForeground: expected.color,
          };
          probe.remove();
          return result;
        });
      expect(colors.background).toBe(colors.expectedBackground);
      expect(colors.foreground).toBe(colors.expectedForeground);
      const bounds = await seek.evaluate((element) => {
        const card = element.closest("div").parentElement;
        const slider = element.getBoundingClientRect();
        const button = card.querySelector("button").getBoundingClientRect();
        const box = card.getBoundingClientRect();
        const rem = parseFloat(
          getComputedStyle(document.documentElement).fontSize,
        );
        return {
          fits:
            card.scrollWidth <= card.clientWidth &&
            slider.right <= box.right &&
            button.right < slider.left,
          seekHeight: slider.height / rem,
          buttonWidth: button.width / rem,
        };
      });
      expect(bounds.fits).toBe(true);
      expect(bounds.seekHeight).toBeGreaterThanOrEqual(2);
      expect(bounds.buttonWidth).toBe(2);
      await seek.press("Home");
      const focus = await seek.evaluate((element) => {
        const style = getComputedStyle(element);
        const probe = document.createElement("span");
        probe.style.color = "var(--border-focus)";
        document.body.append(probe);
        const result = {
          style: style.outlineStyle,
          width: style.outlineWidth,
          color: style.outlineColor,
          expectedColor: getComputedStyle(probe).color,
        };
        probe.remove();
        return result;
      });
      expect(focus.style).toBe("solid");
      expect(focus.width).toBe("2px");
      expect(focus.color).toBe(focus.expectedColor);
    }
  }
});

// Browser-only: hover time and playhead position depend on the rendered native
// range geometry and real pointer events. Hover must never change playback time.
test("audio scrubber previews the hovered time without seeking", async ({
  page,
}) => {
  // The browser decodes the generated eight-second PCM response.
  await page.goto("/tests/fixtures/audio-attachment.html");
  const seek = page.getByRole("slider", { name: "Seek Sample", exact: true });
  await expect(seek).toBeEnabled();
  await expect(seek).toHaveAttribute("max", "8");
  const preview = page.locator("[data-seek-preview]");
  for (const theme of ["light", "dark"]) {
    await page.locator("html").evaluate((element, value) => {
      element.dataset.colorMode = value;
    }, theme);
    for (const width of ["regular", "narrow"]) {
      await page
        .locator("[data-audio-container]")
        .evaluate((element, width) => {
          element.style.width = width === "narrow" ? "14rem" : "24rem";
        }, width);
      const bounds = await seek.boundingBox();
      for (const [fraction, time] of [
        [0.3, "00:02"],
        [0.8, "00:06"],
      ]) {
        const x = 1 + (bounds.width - 2) * fraction;
        await seek.hover({ position: { x, y: bounds.height / 2 } });
        await expect(preview).toHaveText(time);
        const tick = await preview.boundingBox();
        expect(Math.abs(tick.x + tick.width / 2 - (bounds.x + x))).toBeLessThan(
          1,
        );
        await expect(seek).toHaveValue("0");
      }
      await page
        .getByRole("button", { name: "Trigger audio error", exact: true })
        .hover();
      await expect(preview).toHaveCount(0);
    }
  }
});
