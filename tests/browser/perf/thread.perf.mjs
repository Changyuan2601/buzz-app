import { fileURLToPath } from "node:url";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { test, expect, repeats, timeline } from "./runner.mjs";
import { anchor, expectAnchor, settle, virtuaIdle } from "../timeline.mjs";

// Browser-only: rich content reflows while the real dock animates. The existing
// correctness journeys do not measure that style/layout work at this scale.
test.use({
  productionBroker: true,
  readState: true,
  threadUnread: true,
  presenceThreadAuthors: 1,
  historyCounts: { alpha: 40, beta: 1 },
});

const replyCount = 120;
const channelDraft = "Keep this channel draft while reviewing the rich thread.";
const threadDraft = "Keep this rich thread reply draft after closing.";
const imagePath = fileURLToPath(
  new URL("../../../public/shell-gradient.png", import.meta.url),
);
const videoPath = fileURLToPath(
  new URL("../../fixtures/message-gallery/assets/sample.mp4", import.meta.url),
);

function populate(app) {
  const authors = Array.from({ length: 12 }, (_, i) => {
    const key = generateSecretKey();
    app.serveProfile(key, {
      name: `Perf ${i < 8 ? "Agent" : "Reader"} ${i}`,
      ...(i < 8 ? { is_agent: true } : {}),
    });
    return key;
  });
  const { root, replies } = app.presenceThread;
  replies.length = 0;
  for (let i = 0; i < replyCount; i++) {
    const variants = [
      "Plain text from the review conversation.",
      "**Release notes** with _emphasis_, ~~removed text~~ and `inlineCode()`.",
      "Follow-ups:\n- [x] check the image\n- [ ] review the clip\n\n| Build | Style | Result |\n| --- | ---: | --- |\n| before | 120 ms | ready |\n| after | 80 ms | ready |",
      "```typescript\nconst results = await loadMessages({ limit: 80 });\nconsole.log(results.length);\n```",
      "> Review feedback\n\nA second paragraph explains the decision.",
      "@Perf Agent 0: [Design notes](https://example.com/design) and https://example.com/review",
      "Image attachment from the review.",
      "Video attachment from the review.",
    ];
    const media =
      i % 8 === 6
        ? ["png", "image/png"]
        : i % 8 === 7
          ? ["mp4", "video/mp4"]
          : null;
    const nested = i % 6 === 3;
    replies.push(
      finalizeEvent(
        {
          kind: 9,
          created_at: root.created_at + i + 20,
          content: `Rich reply ${i}\n${variants[i % variants.length]}`,
          tags: [
            ["h", "alpha"],
            ...(i % 8 === 5 ? [["p", getPublicKey(authors[0])]] : []),
            ...(nested
              ? [
                  ["e", root.id, "", "root"],
                  ["e", replies.at(-1).id, "", "reply"],
                ]
              : [["e", root.id, "", "reply"]]),
            ...(media
              ? [
                  [
                    "imeta",
                    `url https://primary.example/media/perf-${i}.${media[0]}`,
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
  const participants = authors.map(getPublicKey);
  const summaries = [[root.id, participants, replies.length]];
  for (let i = 0; i < 8; i++) {
    const event = finalizeEvent(
      {
        kind: 9,
        created_at: root.created_at - 1,
        content: `Agent review thread ${i}: **status** and discussion`,
        // Group roots before the target; fresh signing IDs cannot reorder them.
        tags: [
          ["h", "alpha"],
          ["ms", String(500 + i)],
        ],
      },
      authors[i],
    );
    app.histories.get("primary/alpha").push(event);
    summaries.push([event.id, participants.slice(0, 4), 4]);
  }
  return { root, summaries };
}

async function transitions(dock) {
  await dock.evaluate(async (element) => {
    await Promise.allSettled(
      [
        ...element.getAnimations(),
        ...element.parentElement.getAnimations(),
      ].map((animation) => animation.finished),
    );
  });
}

for (const phase of ["open", "close", "reopen"])
  for (let i = 1; i <= repeats; i++)
    test(`thread-${phase}-rich sample ${i}`, async ({ page, app, perf }) => {
      const { root, summaries } = populate(app);
      const expectedImages = app.presenceThread.replies.flatMap(
        (reply, index) => {
          const source = reply.tags
            .find((tag) => tag[0] === "imeta" && tag.includes("m image/png"))
            ?.find((field) => field.startsWith("url "))
            ?.slice(4);
          return source
            ? [
                {
                  rowId: reply.id,
                  source,
                  href: new URL(
                    `/api/relay/primary/media?url=${encodeURIComponent(source)}`,
                    app.origin,
                  ).href,
                  newest: index === replyCount - 2,
                },
              ]
            : [];
        },
      );
      expect(expectedImages).toHaveLength(15);
      expect(expectedImages.filter((image) => image.newest)).toHaveLength(1);
      const imageChecks = [];
      // The same receipts survive prerequisite failures and measured failures.
      app.report.richThreadImages = imageChecks;

      await page.route("**/api/relay/primary/media?**", (route) => {
        const video = decodeURIComponent(route.request().url()).includes(
          ".mp4",
        );
        return route.fulfill({
          path: video ? videoPath : imagePath,
          contentType: video ? "video/mp4" : "image/png",
        });
      });
      await perf.setup("alpha");
      for (const args of summaries) app.threadSummary(...args);
      const channel = page.locator(timeline("alpha"));
      for (const [id, , count] of summaries)
        await expect(
          channel.locator(`[data-message-id="${id}"]`).getByRole("button", {
            name: new RegExp(`^View thread: ${count} replies`),
          }),
        ).toBeAttached();
      const channelInput = page.getByRole("textbox", {
        name: "Message #Alpha",
        exact: true,
      });
      await channelInput.fill(channelDraft);
      const trigger = channel
        .locator(`[data-message-id="${root.id}"]`)
        .getByRole("button", { name: /^View thread:/ });
      await trigger.scrollIntoViewIfNeeded();
      await virtuaIdle(page, channel);
      await expect(
        channel.locator("[data-message-id]").filter({
          hasText: /Agent review thread \d:/,
        }),
        "all eight auxiliary thread roots are mounted before measurement",
      ).toHaveCount(8);
      const channelRowsAtSetup = await channel
        .locator("[data-message-id]")
        .evaluateAll((rows) => rows.map((row) => row.dataset.messageId));
      const reading = await anchor(page);
      const closedWidth = await channel.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      const channelGeometry = () =>
        channel.evaluate((element) => ({
          width: element.getBoundingClientRect().width,
          viewport: element.clientHeight,
          height: element.scrollHeight,
          top: element.scrollTop,
          rows: [...element.querySelectorAll("[data-message-id]")].map(
            (row) => [
              row.dataset.messageId,
              row.getBoundingClientRect().y,
              row.getBoundingClientRect().height,
            ],
          ),
        }));
      const thread = page.getByRole("complementary", {
        name: "Thread",
        exact: true,
      });
      const history = thread.getByRole("region", {
        name: "Thread messages",
        exact: true,
      });
      const dock = page.locator("[data-channel-workspace] > [data-panel-dock]");
      const replyInput = thread.getByRole("textbox", {
        name: "Reply to thread",
        exact: true,
      });
      const imageWitness = () =>
        history.evaluate((element, expected) => {
          const outer = element.getBoundingClientRect();
          const left = Math.max(0, outer.left + element.clientLeft);
          const top = Math.max(0, outer.top + element.clientTop);
          const right = Math.min(
            innerWidth,
            outer.left + element.clientLeft + element.clientWidth,
          );
          const bottom = Math.min(
            innerHeight,
            outer.top + element.clientTop + element.clientHeight,
          );
          const intersection = (rect) =>
            rect
              ? [
                  Math.max(
                    0,
                    Math.min(rect.right, right) - Math.max(rect.left, left),
                  ),
                  Math.max(
                    0,
                    Math.min(rect.bottom, bottom) - Math.max(rect.top, top),
                  ),
                ]
              : [0, 0];
          const rectangle = (rect) =>
            rect ? [rect.x, rect.y, rect.width, rect.height] : null;
          const visible = (node) =>
            !!node?.checkVisibility({
              opacityProperty: true,
              visibilityProperty: true,
            });
          return {
            bounds: [left, top, right, bottom],
            images: expected.map(({ rowId, source, href, newest }) => {
              const row = element.querySelector(`[data-message-id="${rowId}"]`);
              const links = [
                ...(row?.querySelectorAll(
                  'a[aria-label="Open image attachment"]',
                ) ?? []),
              ].filter((link) => link.href === href);
              const link = links.length === 1 ? links[0] : undefined;
              const originals = link?.querySelectorAll("img") ?? [];
              const image = originals.length === 1 ? originals[0] : undefined;
              const linkRect = link?.getBoundingClientRect();
              const imageRect = image?.getBoundingClientRect();
              const linkPixels = intersection(linkRect);
              const pixels = intersection(imageRect);
              const required = newest || linkPixels.every((size) => size > 0);
              const linkVisible = visible(link);
              const imageVisible = visible(image);
              const identity =
                !!image &&
                image.loading === "lazy" &&
                image.src === href &&
                (!image.currentSrc || image.currentSrc === href);
              const ready =
                link?.dataset.imageReady === "true" &&
                image?.complete &&
                image.naturalWidth > 0 &&
                image.naturalHeight > 0 &&
                image.currentSrc === href &&
                linkVisible &&
                imageVisible &&
                linkPixels.every((size) => size > 0) &&
                pixels.every((size) => size > 0);
              return {
                rowId,
                source,
                href,
                newest,
                required,
                linkCount: links.length,
                originalCount: originals.length,
                src: image?.src ?? null,
                currentSrc: image?.currentSrc ?? null,
                loading: image?.loading ?? null,
                decoded: link?.dataset.imageReady === "true",
                complete: image?.complete ?? false,
                naturalSize: [
                  image?.naturalWidth ?? 0,
                  image?.naturalHeight ?? 0,
                ],
                linkVisible,
                visible: imageVisible,
                linkRect: rectangle(linkRect),
                rect: rectangle(imageRect),
                linkPixels,
                pixels,
                pass: identity && (!required || !!ready),
              };
            }),
          };
        }, expectedImages);
      async function checkImages(receipt, stage) {
        await expect
          .poll(
            async () => {
              receipt[stage] = await imageWitness();
              return receipt[stage].images.map((image) => image.pass);
            },
            {
              message:
                "expected original image identities and revealed visible pixels",
            },
          )
          .toEqual(expectedImages.map(() => true));
      }
      async function open() {
        const imageCheck = { phase, opening: imageChecks.length + 1 };
        imageChecks.push(imageCheck);
        await trigger.click();
        await expect(history).not.toHaveAttribute("data-positioning");
        await expect(history.locator("[data-message-id]")).toHaveCount(101);
        await expect(
          history.getByRole("link", {
            name: "Open image attachment",
            exact: true,
          }),
        ).toHaveCount(15);
        await expect(
          history.getByRole("button", { name: /^View 1 reply/ }),
        ).toHaveCount(20);
        await expect(
          history.getByText(`Rich reply ${replyCount - 1}`, { exact: false }),
        ).toBeInViewport();
        await checkImages(imageCheck, "mounted");
        await expect
          .poll(() =>
            history.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              return [...element.querySelectorAll("img")].every((image) => {
                const box = image.getBoundingClientRect();
                return (
                  box.bottom <= bounds.top ||
                  box.top >= bounds.bottom ||
                  (image.complete && image.naturalWidth > 0)
                );
              });
            }),
          )
          .toBe(true);
        await expect
          .poll(() =>
            history
              .locator("video")
              .evaluateAll(
                (videos) =>
                  videos.length === 10 &&
                  videos.every(
                    (video) => video.readyState >= 2 && video.videoWidth > 0,
                  ),
              ),
          )
          .toBe(true);
        await transitions(dock);
        await settle(page, history);
        await checkImages(imageCheck, "settled");
      }
      async function close() {
        await page
          .locator(
            '.buzz-tabs-item:has([data-tab-value^="thread:"][aria-selected="true"]) > button:not([role="tab"]), button[aria-label="Close thread"]',
          )
          .click();
        // PanelDock detaches only after its own and the grid's transitions;
        // immediate closes can already have removed the dock after the click.
        await expect(
          page.locator(
            '[data-channel-workspace] [aria-label="Thread messages"]',
          ),
        ).toHaveCount(0);
        await page.waitForFunction(
          (width) => {
            const element = document.querySelector(
              '[data-channel-timeline="alpha"]',
            );
            return (
              !document.querySelector(
                '[data-channel-workspace] [aria-label="Thread messages"]',
              ) &&
              element &&
              Math.abs(element.getBoundingClientRect().width - width) < 1
            );
          },
          closedWidth,
          { polling: "raf" },
        );
        await virtuaIdle(page, channel);
        await expectAnchor(page, reading);
      }
      if (phase !== "open") {
        await open();
        await replyInput.fill(threadDraft);
        await settle(page, history);
        await virtuaIdle(page, channel);
        if (phase === "reopen") await close();
      }
      const channelBefore = await channelGeometry();
      const auxiliaryRootIds = summaries.slice(1).map(([id]) => id);
      expect(channelBefore.rows.map(([id]) => id)).toEqual(
        expect.arrayContaining(auxiliaryRootIds),
      );
      const sample = await perf.measure("alpha", {
        timeoutMs: 30_000,
        act: phase === "close" ? close : open,
        work: {
          phase,
          replyCount,
          mountedRows: 101,
          participants: 12,
          agentParticipants: 8,
          collapsedNestedReplies: 20,
          images: 15,
          imageChecks,
          videos: 10,
          auxiliaryThreads: 8,
          mainRootId: root.id,
          auxiliaryRootIds,
          channelRowsAtSetup,
          channelBefore,
        },
      });
      if (phase === "close") {
        sample.work.channelAtEnd = await channelGeometry();
        await virtuaIdle(page, channel);
        sample.work.channelAfterCheck = await channelGeometry();
      }
      await perf.save(sample);
      await expect(channelInput).toHaveText(channelDraft);
      if (phase === "close")
        expect(
          sample.work.channelAfterCheck,
          "no channel reflow after the measurement window",
        ).toEqual(sample.work.channelAtEnd);
      if (phase === "reopen") await expect(replyInput).toHaveText(threadDraft);
    });
