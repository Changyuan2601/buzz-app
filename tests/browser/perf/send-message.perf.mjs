import { test, expect, repeats, timeline } from "./runner.mjs";
import { virtuaIdle } from "../timeline.mjs";

// The production broker accepts the real publish and echoes it live, so the
// window covers the optimistic row, relay receipt and echo reconciliation.
test.use({
  productionBroker: true,
  historyCounts: { alpha: 120, beta: 1 },
});

const drafts = {
  "send-message-plain": (token) => `Sounds good, shipping it now ${token}`,
  "send-message-markdown": (token) =>
    [
      `**Release ${token}** is _ready_: see [notes](https://example.com/notes) and \`deploy()\`.`,
      "- [x] build",
      "- [ ] rollout to ~~staging~~ production",
      "```ts",
      "await deploy({ region: 'us' });",
      "```",
      "> Ping me if the canary looks off.",
    ].join("\n"),
};
// Elements the rendered Markdown row must contain, proving it was parsed.
const markup = {
  "send-message-plain": [],
  "send-message-markdown": [
    "strong",
    "em",
    "a",
    "code",
    "pre",
    "li",
    "del",
    "blockquote",
  ],
};

// Browser clock: Enter keydown on the composer until the sent row is visible
// in two successive rendering updates (as firstRowsMs) and the composer is empty.
function watchSend({ selector, composer, token }) {
  let keyAt, rowAt, clearedAt, seen, firstSeenId, raf, timer, resolve, reject;
  let keyDowns = 0;
  const key = (event) => {
    if (event.key !== "Enter" || !event.target.closest?.(composer)) return;
    keyDowns++;
    keyAt ??= performance.now();
  };
  document.addEventListener("keydown", key, true);
  const result = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  function stop() {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    document.removeEventListener("keydown", key, true);
  }
  function sample() {
    const now = performance.now();
    if (keyAt !== undefined) {
      const scroller = document.querySelector(selector);
      const bounds = scroller.getBoundingClientRect();
      const row = [...scroller.querySelectorAll("[data-message-id]")].find(
        (element) => element.textContent.includes(token),
      );
      const box = row?.getBoundingClientRect();
      const visible =
        box &&
        row.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        }) &&
        box.top < bounds.bottom &&
        box.bottom > bounds.top;
      if (visible && seen && rowAt === undefined) rowAt = now;
      if (visible) firstSeenId ??= row.dataset.messageId;
      seen = visible;
      if (
        clearedAt === undefined &&
        !document.querySelector(composer).textContent.trim()
      )
        clearedAt = now;
      if (rowAt !== undefined && clearedAt !== undefined) {
        stop();
        return resolve({
          keyDowns,
          sentRowMs: rowAt - keyAt,
          composerClearedMs: clearedAt - keyAt,
          firstSeenId,
        });
      }
    }
    raf = requestAnimationFrame(sample);
  }
  raf = requestAnimationFrame(sample);
  timer = setTimeout(() => {
    stop();
    reject(new Error("Sent row or cleared composer not observed within 10s"));
  }, 10_000);
  return { result: () => result };
}

for (const [name, draft] of Object.entries(drafts))
  for (let i = 1; i <= repeats; i++)
    test(`${name} sample ${i}`, async ({ page, app, perf }) => {
      await perf.setup("alpha");
      const channel = page.locator(timeline("alpha"));
      const input = page.getByRole("textbox", {
        name: "Message #Alpha",
        exact: true,
      });
      // Distinct per sample so the row and publication are unambiguous.
      const token = `send-probe-${i}`;
      const text = draft(token);
      await input.click();
      await input.fill(text);
      await expect(input).toBeFocused();
      await expect(input).toContainText(token);
      const newest = app.histories.get("primary/alpha").at(-1).id;
      await expect(
        channel.locator(`[data-message-id="${newest}"]`),
      ).toBeInViewport();
      await virtuaIdle(page, channel);
      // Kind 9 receipts only; typing indicators are recorded separately.
      const publishedBefore = app.report.publications.length;
      const sent = channel
        .locator("[data-message-id]")
        .filter({ hasText: token });
      const geometry = () =>
        channel.evaluate((element, token) => {
          const row = [...element.querySelectorAll("[data-message-id]")].find(
            (row) => row.textContent.includes(token),
          );
          return {
            top: element.scrollTop,
            height: element.scrollHeight,
            gap:
              element.scrollHeight - element.scrollTop - element.clientHeight,
            row: row && [row.getBoundingClientRect().y, row.offsetHeight],
          };
        }, token);
      const probe = await page.evaluateHandle(watchSend, {
        selector: timeline("alpha"),
        composer: '[role="textbox"][aria-label="Message #Alpha"]',
        token,
      });
      const accepted = () => app.report.publications.length - publishedBefore;
      let observed, acceptedAtRow;
      const sample = await perf.measure("alpha", {
        act: async () => {
          for (const type of ["keyDown", "keyUp"])
            await perf.cdp.send("Input.dispatchKeyEvent", {
              type,
              key: "Enter",
              code: "Enter",
              windowsVirtualKeyCode: 13,
              ...(type === "keyDown" ? { text: "\r" } : {}),
            });
          observed = await probe.evaluate((p) => p.result());
          acceptedAtRow = accepted();
          // Node-side receipt, no page work: the settle window then always
          // covers delivery acknowledgement and the live echo.
          await expect.poll(accepted, { intervals: [5] }).toBe(1);
        },
        work: { draft: name, draftLength: text.length, publishedBefore },
      });
      sample.work.atEnd = await geometry();
      const frames = app.report.wireFrames;
      await probe.dispose();
      Object.assign(sample.work, observed);
      sample.metrics.sentRowMs = sample.work.sentRowMs;
      sample.metrics.composerClearedMs = sample.work.composerClearedMs;
      // Receipts: exactly one real publish of this draft to the channel.
      expect(accepted()).toBe(1);
      const { community, event } = app.report.publications.at(-1);
      sample.work.publication = {
        community,
        kind: event.kind,
        id: event.id,
        channel: event.tags.find(([key]) => key === "h")?.[1],
        content: event.content,
        // Fixture acceptances once the probe reported the row, after a
        // protocol round trip: 0 means the optimistic row came first.
        acceptedAtRow,
        // Relay frames to the broker by the end of the window: its OK and
        // the live echo of the event to the channel subscription.
        okFrames: frames.filter(
          ([type, id, ok]) => type === "OK" && id === event.id && ok,
        ).length,
        echoFrames: frames.filter(
          ([type, , echoed]) => type === "EVENT" && echoed?.id === event.id,
        ).length,
      };
      expect(sample.work.publication).toMatchObject({
        community: "primary",
        kind: 9,
        channel: "alpha",
        content: text,
        okFrames: 1,
        echoFrames: expect.any(Number),
      });
      expect(sample.work.publication.echoFrames).toBeGreaterThan(0);
      expect(
        sample.work.keyDowns,
        "one Enter keydown reached the composer",
      ).toBe(1);
      expect(sample.work.firstSeenId).toBe(event.id);
      await expect(sent).toHaveCount(1);
      await expect(input).toBeFocused();
      await expect(input).toHaveText("");
      sample.work.renderedMarkup = await sent.evaluate(
        (row, tags) => tags.filter((tag) => row.querySelector(tag)),
        markup[name],
      );
      expect(sample.work.renderedMarkup).toEqual(markup[name]);
      await virtuaIdle(page, channel);
      sample.work.afterCheck = await geometry();
      expect(
        sample.work.atEnd.gap,
        "timeline follows the sent row to the end",
      ).toBeLessThanOrEqual(1);
      expect(
        sample.work.afterCheck,
        "no timeline reflow after the measurement window",
      ).toEqual(sample.work.atEnd);
      await perf.save(sample);
    });
