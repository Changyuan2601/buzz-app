import { fileURLToPath } from "node:url";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { test, expect } from "../fixture.mjs";
import { observe } from "./runner.mjs";
import { loafBlocking } from "./blocking.mjs";
import { openPage } from "../navigation.mjs";
import { anchor, expectAnchor, settle, virtuaIdle } from "../timeline.mjs";

const channelId = "83000000-0000-4000-8000-000000000030";
const replyCount = 303;
const draft = "Keep this channel draft while opening the strict thread.";
const imagePath = fileURLToPath(
  new URL("../../../public/shell-gradient.png", import.meta.url),
);
const videoPath = fileURLToPath(
  new URL("../../fixtures/message-gallery/assets/sample.mp4", import.meta.url),
);
test.use({
  productionBroker: true,
  recordQueryResponses: true,
  strictThreadHistory: true,
  firstSeenHistory: true,
  readState: true,
  inboxThreadWindow: true,
  channelIds: [channelId, "beta"],
  channelNames: { [channelId]: "Review" },
  historyCounts: { [channelId]: 40, beta: 1 },
});

function populate(app) {
  const { root, replies } = app.inboxWindow;
  const authors = Array.from({ length: 12 }, (_, i) => {
    const key = generateSecretKey();
    app.serveProfile(key, { name: `Strict reviewer ${i}` });
    return key;
  });
  const variants = [
    "The deployment review is ready for another pass.",
    "**Release notes** with _emphasis_ and `inlineCode()`.",
    "Review checklist:\n- [x] inspect the plan\n- [ ] confirm rollout\n\n| Build | Result |\n| --- | --- |\n| current | ready |",
    "```typescript\nconst page = await reader.read(filters);\nconsole.log(page.length);\n```",
    "> Keep the discussion attached to its original decision.\n\nFollow-up context.",
    "[Design notes](https://example.com/design) and https://example.com/review",
    "Image from the review.",
    "Video from the review.",
    "Video from the review.",
    "A second image from the review.",
  ];
  replies.length = 0;
  for (let i = 0; i < replyCount; i++) {
    const variant = (i + 7) % 10;
    const media =
      variant === 7 || variant === 8
        ? ["mp4", "video/mp4"]
        : variant === 6 || variant === 9
          ? ["png", "image/png"]
          : null;
    replies.push(
      finalizeEvent(
        {
          kind: 9,
          created_at: root.created_at + 20 + i,
          content: `Strict reply ${i}\n${variants[variant]}`,
          tags: [
            ["h", channelId],
            ["e", root.id, "", "reply"],
            ...(media
              ? [
                  [
                    "imeta",
                    `url https://primary.example/media/strict-${i}.${media[0]}`,
                    `m ${media[1]}`,
                  ],
                ]
              : []),
          ],
        },
        authors[i % authors.length],
      ),
    );
  }
  // Replies live in the upstream thread store, excluded from top-level head
  // responses but included in ordinary unread queries. The fixture's 500 newer
  // busy-channel messages fill that read. Nothing seeds the app's IndexedDB.
  app.histories.set(`primary/${channelId}`, [
    ...Array.from({ length: 40 }, (_, i) =>
      app.sign({
        kind: 9,
        created_at: root.created_at - 40 + i,
        tags: [["h", channelId]],
        content: `Review channel context ${i}`,
      }),
    ),
    root,
  ]);
  return { root, replies, participants: authors.map(getPublicKey) };
}

const counters = {
  scriptMs: "ScriptDuration",
  layoutMs: "LayoutDuration",
  styleMs: "RecalcStyleDuration",
  taskMs: "TaskDuration",
};
for (let i = 1; i <= Number(process.env.PERF_REPEAT ?? 1); i++)
  test(`thread-open-strict-window sample ${i}`, async ({
    page,
    app,
    browserName,
  }, testInfo) => {
    const { root, replies, participants } = populate(app);
    await page.route("**/api/relay/primary/media?**", (route) => {
      const video = decodeURIComponent(route.request().url()).includes(".mp4");
      return route.fulfill({
        path: video ? videoPath : imagePath,
        contentType: video ? "video/mp4" : "image/png",
      });
    });
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page.evaluate(async () =>
      Promise.all([...document.fonts].map((font) => font.load())),
    );
    await page.locator(`button[data-channel-id="${channelId}"]`).click();
    const channel = page.locator(
      `section[data-channel-timeline="${channelId}"]`,
    );
    const row = channel.locator(`[data-message-id="${root.id}"]`);
    await expect(row).toBeVisible();
    app.relay.publish(
      "primary",
      app.signRelay({
        kind: 39005,
        created_at: Math.floor(Date.now() / 1000) + 1,
        tags: [
          ["h", channelId],
          ["e", root.id],
          ["d", root.id],
        ],
        content: JSON.stringify({ reply_count: replyCount, participants }),
      }),
    );
    const trigger = row.getByRole("button", {
      name: /^View thread: 303 replies/,
    });
    await expect(trigger).toBeVisible();
    const input = page.getByRole("textbox", {
      name: "Message #Review",
      exact: true,
    });
    await input.fill(draft);
    await trigger.scrollIntoViewIfNeeded();
    await virtuaIdle(page, channel);
    const reading = await anchor(page);
    const beforeResponses = app.report.queryResponses.length;
    expect(
      app.report.queryResponses.filter(
        ({ filter }) => filter.depth_limit && filter["#e"]?.includes(root.id),
      ),
    ).toHaveLength(0);
    const servedBefore = replies
      .filter((event) => app.served.has(event.id))
      .map((event) => event.id);
    expect(
      servedBefore,
      "no reply history pre-served on any modeled upstream response",
    ).toEqual([]);
    const thread = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = thread.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    const expectedImages = [299, 302].map((index) => {
      const source = `https://primary.example/media/strict-${index}.png`;
      return {
        rowId: replies[index].id,
        source,
        href: new URL(
          `/api/relay/primary/media?url=${encodeURIComponent(source)}`,
          app.origin,
        ).href,
        newest: index === 302,
      };
    });
    const imageWitness = () =>
      history.evaluate((element, expected) => {
        const bounds = element.getBoundingClientRect();
        const intersection = (rect) =>
          rect
            ? [
                Math.min(rect.right, bounds.right, innerWidth) -
                  Math.max(rect.left, bounds.left, 0),
                Math.min(rect.bottom, bounds.bottom, innerHeight) -
                  Math.max(rect.top, bounds.top, 0),
              ]
            : [0, 0];
        return expected.map(({ rowId, source, href, newest }) => {
          const row = element.querySelector(`[data-message-id="${rowId}"]`);
          const links = [
            ...(row?.querySelectorAll(
              'a[aria-label="Open image attachment"]',
            ) ?? []),
          ].filter((link) => link.href === href);
          const link = links.length === 1 ? links[0] : undefined;
          const originals = link?.querySelectorAll("img") ?? [];
          const image = originals.length === 1 ? originals[0] : undefined;
          const rect = image?.getBoundingClientRect();
          const pixels = intersection(rect);
          const required =
            newest ||
            intersection(link?.getBoundingClientRect()).every(
              (size) => size > 0,
            );
          const identity =
            !!image &&
            image.src === href &&
            (!image.currentSrc || image.currentSrc === href) &&
            image.loading === "lazy";
          const decoded =
            link?.dataset.imageReady === "true" &&
            image?.complete &&
            image.naturalWidth > 0 &&
            image.naturalHeight > 0;
          const revealed =
            image?.checkVisibility({
              opacityProperty: true,
              visibilityProperty: true,
            }) ?? false;
          return {
            rowId,
            source,
            links: links.length,
            originals: originals.length,
            identity,
            decoded: !!decoded,
            revealed,
            required,
            rect: rect ? [rect.x, rect.y, rect.width, rect.height] : null,
            intersection: pixels,
            passes:
              identity &&
              (!required ||
                (decoded &&
                  revealed &&
                  rect.width > 0 &&
                  rect.height > 0 &&
                  pixels.every((size) => size > 0))),
          };
        });
      }, expectedImages);
    const selector = '[aria-label="Thread messages"]';
    const click = `[data-channel-timeline="${channelId}"] [data-message-id="${root.id}"] button[aria-label^="View thread:"]`;
    const cdp =
      browserName === "chromium"
        ? await page.context().newCDPSession(page)
        : null;
    const read = async () => {
      if (!cdp) return {};
      const { metrics } = await cdp.send("Performance.getMetrics");
      return Object.fromEntries(
        Object.entries(counters).map(([key, name]) => {
          const value = metrics.find((entry) => entry.name === name)?.value;
          if (!Number.isFinite(value))
            throw new Error(`Missing browser counter ${name}`);
          return [key, value * 1000];
        }),
      );
    };
    const sample = {
      state: app.report.state,
      work: {
        channelId,
        rootId: root.id,
        replyCount,
        participants: 12,
        initialReplies: 10,
        images: 2,
        expectedImages,
        videos: 2,
        setupResponses: app.report.queryResponses.slice(0, beforeResponses),
        expectedRows: [root.id, ...replies.slice(-10).map((e) => e.id)],
        servedBefore,
        reading,
        unsupportedMetrics: cdp
          ? []
          : [...Object.keys(counters), "loafBlockingMs"],
      },
      metrics: {},
    };
    let observer;
    try {
      if (cdp) {
        await cdp.send("Performance.enable");
        await cdp.send("Emulation.setCPUThrottlingRate", {
          rate: Number(process.env.PERF_CPU),
        });
      }
      observer = await page.evaluateHandle(observe, {
        selector,
        ids: sample.work.expectedRows,
        click,
        timeoutMs: 30_000,
        captureLongFrames: !!cdp,
      });
      const before = await read();
      await observer.evaluate((o) => o.start());
      await trigger.click();
      await expect(history.locator("[data-message-id]")).toHaveCount(11);
      await expect(history).not.toHaveAttribute("data-positioning");
      await expect(
        history.getByText("Strict reply 302", { exact: false }),
      ).toBeInViewport();
      await expect(
        thread.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toBeEditable();
      await expect(
        history.getByRole("link", {
          name: "Open image attachment",
          exact: true,
        }),
      ).toHaveCount(2);
      await expect
        .poll(async () => (await imageWitness()).map(({ passes }) => passes), {
          message:
            "Expected attachment originals and decoded visible newest pixels",
        })
        .toEqual([true, true]);
      await expect
        .poll(() =>
          history
            .locator("video")
            .evaluateAll(
              (videos) =>
                videos.length === 2 &&
                videos.every(
                  (video) => video.readyState >= 2 && video.videoWidth > 0,
                ),
            ),
        )
        .toBe(true);
      await page
        .locator("[data-channel-workspace] > [data-panel-dock]")
        .evaluate(async (element) =>
          Promise.allSettled(
            [
              ...element.getAnimations(),
              ...element.parentElement.getAnimations(),
            ].map((animation) => animation.finished),
          ),
        );
      await virtuaIdle(page, channel);
      await expectAnchor(page, reading);
      await settle(page, history);
      sample.work.imageWitness = await imageWitness();
      expect(sample.work.imageWitness.map(({ passes }) => passes)).toEqual([
        true,
        true,
      ]);
      await observer.evaluate((o) => o.done());
      sample.recording = await observer.evaluate((o) => o.result());
      const after = await read();
      for (const key of Object.keys(before))
        sample.metrics[key] = after[key] - before[key];
      sample.metrics.durationMs = sample.recording.durationMs;
      sample.metrics.firstRowsMs = sample.recording.firstRowsMs;
      if (cdp) {
        sample.recording.longAnimationFrames = await observer.evaluate((o) =>
          o.longFrames(),
        );
        sample.metrics.loafBlockingMs = loafBlocking(sample.recording);
      }
      expect(sample.recording.error).toBeUndefined();
      sample.work.responses = app.report.queryResponses.slice(beforeResponses);
      const windows = sample.work.responses.filter(
        ({ filter }) => filter.thread_window,
      );
      expect(windows).toHaveLength(1);
      expect(windows[0].filter).toMatchObject({
        "#h": [channelId],
        "#e": [root.id],
        kinds: [40002, 9],
        limit: 10,
        depth_limit: 100,
        include_aux: true,
        thread_window: true,
      });
      expect(windows[0].filter.until).toBeUndefined();
      expect(windows[0].eventIds).toEqual(
        expect.arrayContaining(replies.slice(-10).map((event) => event.id)),
      );
      expect(windows[0].eventIds).toHaveLength(11); // ten replies + signed bounds
      expect(JSON.parse(windows[0].threadBounds[0].content)).toEqual({
        version: 1,
        direction: "older",
        has_more: true,
        next_cursor: {
          created_at: replies.at(-10).created_at,
          id: replies.at(-10).id,
        },
      });
      expect(
        sample.work.responses.some(
          ({ filter }) => filter.thread_cursor !== undefined,
        ),
      ).toBe(false);
      sample.work.mountedIds = await history
        .locator("[data-message-id]")
        .evaluateAll((rows) => rows.map((r) => r.dataset.messageId));
      expect(sample.work.mountedIds).toEqual(sample.work.expectedRows);
      sample.work.servedReplyIds = replies
        .filter((event) => app.served.has(event.id))
        .map((event) => event.id);
      expect(sample.work.servedReplyIds).toEqual(
        replies.slice(-10).map((event) => event.id),
      );
      await expect(input).toHaveText(draft);
      await expect(history.getByRole("alert")).toHaveCount(0);
    } finally {
      if (observer) {
        await observer.evaluate((o) => o.stop());
        sample.recording ??= await observer.evaluate((o) => o.result());
        await observer.dispose();
      }
      if (cdp) {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        await cdp.detach();
      }
      app.report.measurements.push(sample);
    }
    // Untimed protocol control on the same app: the frozen opening endpoint
    // leaves the authentic continuation available, rather than exhausting it.
    await history.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await history.hover();
    await page.mouse.wheel(0, -300);
    await expect
      .poll(
        () => app.pending.filter(({ filter }) => filter.thread_window).length,
      )
      .toBe(1);
    const continuation = app.pending.find(({ filter }) => filter.thread_window);
    expect(continuation.filter).toMatchObject({
      thread_window: true,
      limit: 50,
      until: replies.at(-10).created_at,
      before_id: replies.at(-10).id,
    });
    continuation.release();
    await expect(history.locator("[data-message-id]")).toHaveCount(61);
    expect(
      await history
        .locator("[data-message-id]")
        .evaluateAll((rows) => rows.map((row) => row.dataset.messageId)),
    ).toEqual([root.id, ...replies.slice(-60).map((event) => event.id)]);
    await expect(input).toHaveText(draft);
    sample.work.continuationControl = {
      filter: continuation.filter,
      mountedRows: 61,
    };
    await testInfo.attach("perf-sample", {
      body: JSON.stringify(sample),
      contentType: "application/json",
    });
  });
