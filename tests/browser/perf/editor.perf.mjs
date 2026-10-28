import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import { test as base, expect } from "../fixture.mjs";
import { openPage } from "../navigation.mjs";
import { virtuaIdle } from "../timeline.mjs";
import {
  mediaResponse,
  mediaReadyForPausedSeek,
  playFixtureVideos,
} from "../fixture-media.mjs";
import { recordEditor } from "./editor-recorder.mjs";

// Real contenteditable, completion portals, native selection and concurrent
// browser rendering cannot be measured by jsdom or a candidate-ranking microbench.
const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture dependencies.
  editorPeople: async ({}, use) => {
    await use(
      [
        "Aster",
        "Avery",
        "Axel",
        "Azure",
        "QuillUnique",
        "Directory Person",
      ].map((name) => {
        const key = generateSecretKey();
        return { name, key, pubkey: getPublicKey(key) };
      }),
    );
  },
  sessionMembers: async ({ editorPeople }, use) => {
    await use({ alpha: editorPeople.slice(0, 5).map(({ pubkey }) => pubkey) });
  },
});
const repeats = Number(process.env.PERF_REPEAT ?? 1);
const intervalMs = Number(process.env.PERF_INTERVAL ?? 40);
const imagePath = fileURLToPath(
  new URL("../../../public/shell-gradient.png", import.meta.url),
);
const videoPath = fileURLToPath(
  new URL("../../fixtures/message-gallery/assets/sample.mp4", import.meta.url),
);

function sequence(flow) {
  const actions = [];
  let text = "";
  let cursor = 0;
  const type = (value, phase) => {
    for (const key of value) {
      text = text.slice(0, cursor) + key + text.slice(cursor);
      cursor++;
      actions.push({ key, phase, text, selection: [cursor, cursor] });
    }
  };
  type("Checking the draft ", "typing");
  if (flow === "editing") {
    type("under pressure", "typing");
    for (let i = 0; i < 5; i++) {
      text = text.slice(0, cursor - 1) + text.slice(cursor);
      cursor--;
      actions.push({
        key: "Backspace",
        phase: "backspace",
        text,
        selection: [cursor, cursor],
      });
    }
    for (let i = 0; i < 4; i++) {
      cursor--;
      actions.push({
        key: "ArrowLeft",
        phase: "caret",
        text,
        selection: [cursor, cursor],
      });
    }
    const end = cursor;
    for (let i = 0; i < 3; i++) {
      cursor--;
      actions.push({
        key: "ArrowLeft",
        shift: true,
        phase: "selection",
        text,
        selection: [cursor, end],
      });
    }
    text = text.slice(0, cursor) + text.slice(end);
    actions.push({
      key: "Backspace",
      phase: "backspace",
      text,
      selection: [cursor, cursor],
    });
    type("better", "continue");
    return {
      actions,
      expected: { text, selection: [cursor, cursor], recipient: null },
    };
  }
  type("@", "open");
  actions.at(-1).options = [
    "Aster",
    "Avery",
    "Axel",
    "Azure",
    "Fixture Reader",
    "QuillUnique",
  ];
  if (flow === "open")
    return {
      actions,
      expected: {
        text,
        selection: [cursor, cursor],
        options: actions.at(-1).options,
        recipient: null,
      },
    };
  const query =
    flow === "unique" ? "Quill" : flow === "choose" ? "A" : "Directory P";
  type(query, "filter");
  const recipient =
    flow === "unique"
      ? "QuillUnique"
      : flow === "choose"
        ? "Axel"
        : "Directory Person";
  actions.at(-1).options =
    flow === "choose" ? ["Aster", "Avery", "Axel", "Azure"] : [recipient];
  actions.at(-1).phase = "suggestions";
  if (flow === "directory")
    return {
      actions,
      expected: {
        text,
        selection: [cursor, cursor],
        options: [recipient],
        recipient: null,
      },
    };
  if (flow === "choose") {
    for (const selected of ["Avery", "Axel"])
      actions.push({ key: "ArrowDown", phase: "navigate", text, selected });
  }
  text = `Checking the draft @${recipient} `;
  cursor = text.length;
  actions.push({
    key: flow === "unique" ? "Enter" : "Tab",
    phase: "accept",
    recipient,
  });
  type("and keep typing", "continue");
  return {
    actions,
    expected: { text, selection: [cursor, cursor], recipient },
  };
}

function populateBusy(app, people) {
  const roots = [];
  const history = app.histories.get("primary/alpha");
  for (let thread = 0; thread < 3; thread++) {
    const root = finalizeEvent(
      {
        kind: 9,
        created_at: 1700000300 + thread,
        content: `Editor workload thread ${thread}`,
        tags: [["h", "alpha"]],
      },
      people[thread].key,
    );
    history.push(root);
    roots.push(root);
    const replies = [];
    app.threadReplies.set(root.id, replies);
    for (let i = 0; i < 48; i++) {
      const media =
        i % 8 === 6
          ? ["png", "image/png"]
          : i % 8 === 7
            ? ["mp4", "video/mp4"]
            : null;
      const body = [
        "A short status message.",
        "**Review** the _proposed_ change and `result.value`.",
        "Tasks:\n- check the draft\n- inspect the menu\n- preserve the recipient",
        "```typescript\nconst choices = await directory.search(query);\nreturn choices.slice(0, 50);\n```",
        "> Background conversation\n\nMore details follow here.",
        "[Review notes](https://example.com/notes) and https://example.com/change",
        "An image attachment.",
        "A video attachment.",
      ][i % 8];
      replies.push(
        finalizeEvent(
          {
            kind: 9,
            created_at: root.created_at + i + 1,
            content: `Workload reply ${thread}/${i}\n${body}`,
            tags: [
              ["h", "alpha"],
              ["e", root.id, "", "reply"],
              ...(media
                ? [
                    [
                      "imeta",
                      `url https://primary.example/media/editor-${thread}-${i}.${media[0]}`,
                      `m ${media[1]}`,
                    ],
                  ]
                : []),
            ],
          },
          people[i % 5].key,
        ),
      );
    }
  }
  return roots;
}

for (const scene of ["sparse", "busy"])
  test.describe(`editor-${scene}`, () => {
    test.use({
      productionBroker: true,
      readState: true,
      historyCounts: { alpha: scene === "busy" ? 120 : 3, beta: 1 },
      markdownMessages: scene === "busy",
    });
    for (const flow of ["editing", "open", "unique", "choose", "directory"])
      for (let i = 1; i <= repeats; i++)
        test(`editor-${scene}-${flow} sample ${i}`, async ({
          page,
          app,
          editorPeople,
          browserName,
        }, testInfo) => {
          for (const person of editorPeople)
            app.serveProfile(person.key, { name: person.name });
          const roots = scene === "busy" ? populateBusy(app, editorPeople) : [];
          const pausedSeek =
            browserName === "webkit" && process.platform === "linux";
          await page.route("**/api/relay/primary/media?**", async (route) => {
            const video = decodeURIComponent(route.request().url()).includes(
              ".mp4",
            );
            return route.fulfill(
              await mediaResponse(
                video ? videoPath : imagePath,
                video ? "video/mp4" : "image/png",
                route.request().headers().range,
              ),
            );
          });
          await page.goto(app.origin);
          await openPage(page, "Messages");
          await page.locator('button[data-channel-id="alpha"]').click();
          await page.evaluate(async () => {
            await Promise.all([...document.fonts].map((font) => font.load()));
          });
          const timeline = page.locator('[data-channel-timeline="alpha"]');
          await expect(
            timeline.locator("[data-message-id]").first(),
          ).toBeVisible();
          await virtuaIdle(page, timeline);
          let input = page.getByRole("textbox", {
            name: "Message #Alpha",
            exact: true,
          });
          if (scene === "busy") {
            for (const root of roots)
              app.threadSummary(
                root.id,
                editorPeople.slice(0, 5).map(({ pubkey }) => pubkey),
                48,
              );
            for (const root of roots) {
              await timeline
                .locator(`[data-message-id="${root.id}"]`)
                .getByRole("button", { name: /^View thread:/ })
                .click();
              const thread = page.getByRole("complementary", {
                name: "Thread",
                exact: true,
              });
              await expect(
                thread.getByText(`Workload reply ${roots.indexOf(root)}/47`, {
                  exact: false,
                }),
              ).toBeVisible();
              await expect(thread.locator("video").first()).toBeAttached();
              if (pausedSeek)
                await expect
                  .poll(() =>
                    thread
                      .locator("video")
                      .evaluateAll(mediaReadyForPausedSeek),
                  )
                  .toBe(true);
              await thread
                .locator("video")
                .evaluateAll(playFixtureVideos, pausedSeek);
              input = thread.getByRole("textbox", {
                name: "Reply to thread",
                exact: true,
              });
            }
          }
          await expect(input).toBeEditable();
          await input.focus();
          const sceneReceipt = await page.evaluate(() => ({
            mountedRows: document.querySelectorAll("[data-message-id]").length,
            threadViews: document.querySelectorAll(
              '[aria-label="Thread messages"]',
            ).length,
            videos: document.querySelectorAll("video").length,
            playingVideos: [...document.querySelectorAll("video")].filter(
              (v) => !v.paused && v.readyState >= 2,
            ).length,
          }));
          if (scene === "busy") {
            expect(sceneReceipt.threadViews).toBe(3);
            expect(sceneReceipt.videos).toBe(18);
            expect(sceneReceipt.playingVideos).toBeGreaterThan(0);
            expect(sceneReceipt.playingVideos).toBe(18);
          }
          const { actions, expected } = sequence(flow);
          const beforeSearch = app.report.profileSearches.length;
          const beforePublications = app.report.publications.length;
          const sample = await recordEditor({
            page,
            input,
            actions,
            expected,
            identities: editorPeople.map(({ name, pubkey }) => ({
              name,
              pubkey,
            })),
            intervalMs,
            browserName,
            cpu: Number(process.env.PERF_CPU ?? 4),
            background:
              scene === "busy"
                ? (n) => {
                    const event = app.append(
                      "primary",
                      "alpha",
                      `Background update ${n}: **incoming** detail ${"working ".repeat(n + 1)}`,
                      true,
                      false,
                      roots.at(-1).id,
                    );
                    return { id: event.id, index: n };
                  }
                : undefined,
          });
          const final = sample.recording.final;
          const readMedia = () =>
            page.locator("video").evaluateAll((videos) => ({
              videos: videos.length,
              playingVideos: videos.filter(
                (v) => !v.paused && v.readyState >= 2,
              ).length,
            }));
          const mediaAfter = await readMedia();
          sample.outcome = {
            correctText: final.text === expected.text,
            correctSelection: expected.selection.every(
              (n, index) => final.selection[index] === n,
            ),
            correctRecipient: expected.recipient
              ? final.recipients.includes(expected.recipient) && final.chips > 0
              : final.recipients.length === 0,
            correctOptions: expected.options
              ? JSON.stringify(final.options) ===
                JSON.stringify(expected.options)
              : final.options.length === 0,
            focused: final.focused,
            inputDelivered:
              sample.recording.inputReceipt.ordered &&
              sample.recording.inputReceipt.trusted &&
              sample.recording.inputReceipt.misdirected === 0,
            unexpectedPublications: app.report.publications
              .slice(beforePublications)
              .filter(({ event }) => event?.kind === 9).length,
          };
          sample.metrics.workflowCorrect = Number(
            Object.entries(sample.outcome).every(([key, value]) =>
              key === "unexpectedPublications" ? value === 0 : value,
            ),
          );
          sample.work = {
            scene,
            flow,
            browserVersion: page.context().browser().version(),
            intervalMs,
            mediaInitialization:
              scene === "sparse"
                ? "none"
                : pausedSeek
                  ? "paused-seek-before-play"
                  : "play",
            ...sceneReceipt,
            mediaAfter,
            expected,
            directorySearches: app.report.profileSearches.slice(beforeSearch),
            backgroundUpdates: sample.dispatch.backgroundReceipts.length,
            backgroundRowsObserved: sample.recording.backgroundRows.filter(
              ({ id, frameMs }) =>
                Number.isFinite(frameMs) &&
                sample.dispatch.backgroundReceipts.some(
                  (receipt) => receipt.id === id,
                ),
            ).length,
            sentMessages: app.report.publications
              .slice(beforePublications)
              .filter(({ event }) => event?.kind === 9)
              .map(({ event }) => ({
                content: event.content,
                tags: event.tags,
              })),
          };
          sample.state = app.report.state;
          app.report.measurements.push(sample);
          try {
            if (scene === "busy")
              // A healthy loop briefly seeks with readyState=1. Observe the
              // same eighteen-player condition after that transition, outside
              // recording; retain both snapshots and any failure's raw sample.
              await expect
                .poll(async () => {
                  sample.work.mediaCompletion = await readMedia();
                  return sample.work.mediaCompletion;
                })
                .toEqual({ videos: 18, playingVideos: 18 });
          } finally {
            await testInfo.attach("perf-sample", {
              body: JSON.stringify(sample),
              contentType: "application/json",
            });
          }
          // Outcomes are data during exploration. Only missing workload or broken
          // instrumentation fails the run; no latency or frame budget is enforced.
          if (flow === "directory")
            expect(
              sample.work.directorySearches.some(
                ({ query }) => query === "Directory P",
              ),
            ).toBe(true);
          if (scene === "busy")
            expect(sample.work.backgroundUpdates).toBeGreaterThan(0);
          if (scene === "busy")
            expect(
              sample.work.backgroundRowsObserved,
              "incoming replies reached DOM and a rendering opportunity inside recording",
            ).toBeGreaterThan(0);
        });
  });
