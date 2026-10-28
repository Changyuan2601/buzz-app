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

const nativeKey =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const nativeSecret = new Uint8Array(32);
nativeSecret[31] = 1;
const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture dependencies.
  editorPeople: async ({}, use) => {
    await use(
      ["Aster", "Avery", "Axel", "Azure", "Local tester"].map((name) => {
        const key = generateSecretKey();
        return { name, key, pubkey: getPublicKey(key) };
      }),
    );
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture dependencies.
  editorAgents: async ({}, use) => {
    await use(
      ["Cedar helper", "Orchid helper"].map((name) => {
        const key = generateSecretKey();
        return { name, key, pubkey: getPublicKey(key) };
      }),
    );
  },
  sessionMembers: async ({ editorPeople, editorAgents }, use) => {
    await use({
      alpha: [...editorPeople, ...editorAgents]
        .map((p) => p.pubkey)
        .concat(nativeKey),
    });
  },
  legacyAgentRows: async ({ editorAgents }, use) => {
    await use([
      ...editorAgents.map(({ name, pubkey }) => ({ name, pubkey })),
      { name: "Local tester", pubkey: nativeKey },
    ]);
  },
});
test.use({
  productionBroker: true,
  readState: true,
  localAgentActivity: true,
  controlledAgentLibrary: true,
  historyCounts: { alpha: 120, beta: 1 },
  markdownMessages: true,
});

const imagePath = fileURLToPath(
  new URL("../../../public/shell-gradient.png", import.meta.url),
);
const videoPath = fileURLToPath(
  new URL("../../fixtures/message-gallery/assets/sample.mp4", import.meta.url),
);
const intervalMs = 40;
const releaseOrdinal = 34; // Zero-based trusted keydown: the 'c' in @Local.

function sequence(openLabels) {
  const actions = [];
  let text = "";
  const type = (value, phase) => {
    for (const key of value) {
      text += key;
      actions.push({ key, phase, text, selection: [text.length, text.length] });
    }
  };
  type("Checking the current draft now ", "typing");
  type("@", "open");
  actions.at(-1).options = openLabels;
  type("Local", "filter");
  actions.at(-1).phase = "suggestions";
  actions.at(-1).options = ["Local tester (agent)", "Local tester"];
  text = "Checking the current draft now @Local tester ";
  actions.push({ key: "Tab", phase: "accept", recipient: nativeKey });
  type("and keep typing", "continue");
  return {
    actions,
    expected: {
      text,
      selection: [text.length, text.length],
      recipient: nativeKey,
    },
  };
}

// Scenario-local read-only receipts supplement the frozen recorder's labels.
// Native media clocks are retained throughout input, not just ready bookends.
function observeAgentWork(element, releaseOrdinal) {
  const startAt = performance.now();
  const menus = [],
    inputs = [],
    loaf = [],
    mediaWitnesses = [];
  const videos = [...document.querySelectorAll("video")];
  const mediaState = (video) => ({
    at: performance.now(),
    currentTime: video.currentTime,
    src: video.currentSrc,
    connected: video.isConnected,
    frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
    readyState: video.readyState,
    paused: video.paused,
    ended: video.ended,
    width: video.videoWidth,
    height: video.videoHeight,
    loop: video.loop,
    muted: video.muted,
  });
  const media = videos.map((video) => ({
    src: video.currentSrc,
    before: mediaState(video),
    events: [],
  }));
  const stops = videos.map((video, i) => {
    const record = (event) =>
      media[i].events.push({ type: event.type, ...mediaState(video) });
    for (const name of [
      "timeupdate",
      "playing",
      "waiting",
      "stalled",
      "pause",
      "ended",
      "error",
    ])
      video.addEventListener(name, record);
    return () => {
      media[i].after = mediaState(video);
      for (const name of [
        "timeupdate",
        "playing",
        "waiting",
        "stalled",
        "pause",
        "ended",
        "error",
      ])
        video.removeEventListener(name, record);
    };
  });
  const keydown = (event) => {
    const receipt = {
      key: event.key,
      at: event.timeStamp,
      handlerAt: performance.now(),
      trusted: event.isTrusted,
      target: element.contains(event.target),
    };
    inputs.push(receipt);
    // Two declared native snapshots supplement sparse/coalesced media events.
    // They are synchronous reads at fixed keys, never a progress/input barrier.
    if (
      (inputs.length === 1 || inputs.length === 53) &&
      receipt.trusted &&
      receipt.target
    ) {
      const at = performance.now();
      videos.forEach((video, i) => {
        media[i].events.push({ type: "input-witness", ...mediaState(video) });
      });
      mediaWitnesses.push({
        ordinal: inputs.length - 1,
        at,
        durationMs: performance.now() - at,
      });
    }
    if (
      inputs.length - 1 === releaseOrdinal &&
      receipt.trusted &&
      receipt.target
    )
      void window
        .releaseEditorAgentLibrary({
          ordinal: releaseOrdinal,
          ...receipt,
          choicesAtCapture: window.localAgentFixture.choices(),
          draftAtCapture: element.value,
          selectionAtCapture: [element.selectionStart, element.selectionEnd],
          focusedAtCapture: document.activeElement === element,
        })
        .then(() => {
          receipt.releaseAcknowledgedAt = performance.now();
        });
  };
  document.addEventListener("keydown", keydown, true);
  let previous;
  const snapshot = () => {
    const list = document.getElementById(element.getAttribute("aria-controls"));
    const options = [...(list?.querySelectorAll('[role="option"]') ?? [])].map(
      (row) => ({
        key: row.querySelector("[data-recipient-key]")?.textContent ?? null,
        label:
          row.querySelector("[data-completion-label] > span")?.textContent ??
          "",
        text: row.textContent,
        selected: row.getAttribute("aria-selected"),
        shape:
          row.querySelector("[data-shape]")?.getAttribute("data-shape") ?? null,
      }),
    );
    const serialized = JSON.stringify(options);
    if (serialized !== previous) {
      menus.push({ at: performance.now(), options });
      previous = serialized;
    }
  };
  // These are DOM observations; the frozen recorder separately retains rAF
  // observations and misses. A transient DOM row does not prove a painted menu.
  const mutation = new MutationObserver(snapshot);
  mutation.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-controls", "aria-selected", "aria-label"],
  });
  snapshot();
  const loafSupported = PerformanceObserver.supportedEntryTypes.includes(
    "long-animation-frame",
  );
  const observer = loafSupported
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) loaf.push(entry.toJSON());
      })
    : undefined;
  observer?.observe({ type: "long-animation-frame" });
  return {
    stop() {
      mutation.disconnect();
      observer?.disconnect();
      document.removeEventListener("keydown", keydown, true);
      for (const stop of stops) stop();
      const recipients = [
        ...element.closest("form").querySelectorAll("[data-mention-recipient]"),
      ].map((row) => ({
        label: row.getAttribute("aria-label"),
        shape: row.getAttribute("data-avatar-shape"),
      }));
      return {
        startAt,
        endAt: performance.now(),
        menus,
        inputs,
        media,
        mediaWitnesses,
        loaf,
        loafSupported,
        recipients,
        chipText: [...element.querySelectorAll(".inline-chip")].map(
          (chip) => chip.textContent,
        ),
      };
    },
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

for (let i = 1; i <= Number(process.env.PERF_REPEAT ?? 1); i++)
  test(`editor-busy-agent-choose sample ${i}`, async ({
    page,
    app,
    editorPeople,
    editorAgents,
    browserName,
  }, testInfo) => {
    expect(Number(process.env.PERF_INTERVAL ?? 40)).toBe(intervalMs);
    const profileEvents = [];
    for (const person of editorPeople)
      profileEvents.push(app.serveProfile(person.key, { name: person.name }));
    for (const agent of [
      ...editorAgents,
      { key: nativeSecret, name: "Local tester" },
    ])
      profileEvents.push(app.serveOwnedAgentProfile(agent.key, agent.name));
    const roots = populateBusy(app, editorPeople);
    const pausedSeek = browserName === "webkit" && process.platform === "linux";
    await page.route("**/api/relay/primary/media?**", async (route) => {
      const video = decodeURIComponent(route.request().url()).includes(".mp4");
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
    await expect(timeline.locator("[data-message-id]").first()).toBeVisible();
    await virtuaIdle(page, timeline);
    for (const root of roots)
      app.threadSummary(
        root.id,
        editorPeople.map((p) => p.pubkey),
        48,
      );
    let input;
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
      input = thread.getByRole("textbox", {
        name: "Reply to thread",
        exact: true,
      });
    }
    const choices = () =>
      page.evaluate(() => window.localAgentFixture.choices());
    await expect
      .poll(
        async () =>
          (await choices())?.identities.find((a) => a.pubkey === nativeKey)
            ?.managed,
      )
      .toBe(true);
    const native = await page.evaluate(() =>
      window.localAgentFixture.identities(),
    );
    expect(native).toEqual([
      expect.objectContaining({
        pubkey: nativeKey,
        name: "Local tester",
        deleted: false,
        owner: profileEvents.at(-1).tags[0][1],
      }),
    ]);
    await expect.poll(async () => (await choices()).complete).toBe(true);
    const expectedKeys = [
      ...editorAgents.map((a) => a.pubkey),
      nativeKey,
    ].sort();
    expect((await choices()).identities.map((a) => a.pubkey).sort()).toEqual(
      expectedKeys,
    );
    await page.evaluate(() => window.localAgentFixture.observeChoices());
    const conversation = page.getByRole("article", { name: "Conversation" });
    await conversation
      .getByRole("button", { name: "Manage members", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    const refresh = dialog.getByRole("button", {
      name: "Refresh member data",
      exact: true,
    });
    await expect(refresh).toBeEnabled();
    const beforeReads = app.agentLibraryGate.requests.length;
    const beforePublications = app.report.publications.length;
    let observation;
    app.agentLibraryGate.hold();
    try {
      await refresh.click();
      await expect
        .poll(() => app.agentLibraryGate.requests.length)
        .toBe(beforeReads + 1);
      await expect
        .poll(async () => ({
          pending: (await choices()).pending,
          complete: (await choices()).complete,
        }))
        .toEqual({ pending: true, complete: false });
      const partial = await choices();
      expect(partial.identities).toEqual([
        expect.objectContaining({ pubkey: nativeKey, managed: true }),
      ]);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const videos = page.locator("video");
      if (pausedSeek)
        await expect
          .poll(() => videos.evaluateAll(mediaReadyForPausedSeek))
          .toBe(true);
      await videos.evaluateAll(playFixtureVideos, pausedSeek);
      await expect(input).toBeEditable();
      await input.focus();
      const scene = await page.evaluate(() => ({
        mountedRows: document.querySelectorAll("[data-message-id]").length,
        threadViews: document.querySelectorAll('[aria-label="Thread messages"]')
          .length,
        videos: document.querySelectorAll("video").length,
        playingVideos: [...document.querySelectorAll("video")].filter(
          (v) => !v.paused && v.readyState >= 2,
        ).length,
      }));
      expect(scene).toMatchObject({
        threadViews: 3,
        videos: 18,
        playingVideos: 18,
      });
      // All are members with ready owner-attested profiles, so the legacy rows
      // are already known people/agent facts while canonical library is pending.
      // Owned agents lead; native/person namesakes stay distinct. Release changes
      // source completeness/dedup, not this already-installed member order.
      const viewer = profileEvents.at(-1).tags[0][1];
      const openOrder = [
        editorAgents[0].pubkey,
        nativeKey,
        editorAgents[1].pubkey,
        ...editorPeople.slice(0, 4).map((p) => p.pubkey),
        viewer,
        editorPeople[4].pubkey,
      ];
      const openLabels = [
        "Cedar helper",
        "Local tester (agent)",
        "Orchid helper",
        "Aster",
        "Avery",
        "Axel",
        "Azure",
        "Fixture Reader",
        "Local tester",
      ];
      const { actions, expected } = sequence(openLabels);
      expect(actions).toHaveLength(53);
      let release;
      await page.exposeFunction("releaseEditorAgentLibrary", (receipt) => {
        release = {
          ...receipt,
          plannedMs: releaseOrdinal * intervalMs,
          nodeAt: performance.now(),
          requestBeforeRelease: { ...app.agentLibraryGate.requests.at(-1) },
        };
        app.agentLibraryGate.release();
      });
      observation = await input.evaluateHandle(
        observeAgentWork,
        releaseOrdinal,
      );
      const sample = await recordEditor({
        page,
        input,
        actions,
        expected,
        identities: [
          ...editorPeople,
          ...editorAgents,
          { pubkey: nativeKey },
        ].map(({ pubkey }) => ({ pubkey, name: pubkey })),
        intervalMs,
        afterInput: async () => {
          const ready = await page.waitForFunction(
            () => {
              const choices = window.localAgentFixture.choices();
              return choices.complete && !choices.pending;
            },
            undefined,
            { timeout: 5000 },
          );
          await ready.dispose();
        },
        browserName,
        cpu: Number(process.env.PERF_CPU ?? 4),
        background: (n) => {
          const event = app.append(
            "primary",
            "alpha",
            `Background update ${n}: **incoming** detail ${"working ".repeat(n + 1)}`,
            true,
            false,
            roots.at(-1).id,
          );
          return { id: event.id, index: n };
        },
      });
      const observed = await observation.evaluate((o) => o.stop());
      await observation.dispose();
      observation = undefined;
      const settled = await choices();
      const canonicalEvents = await page.evaluate(() =>
        window.localAgentFixture.choiceEvents(),
      );
      const agentRuns = await page.evaluate(() => ({
        pending: window.localAgentFixture.pending(),
        stopped: window.localAgentFixture.stopped(),
      }));
      const readMedia = () =>
        page.locator("video").evaluateAll((videos) => ({
          videos: videos.length,
          playingVideos: videos.filter((v) => !v.paused && v.readyState >= 2)
            .length,
        }));
      const mediaAfter = await readMedia();
      const final = sample.recording.final;
      const recipientKeys = observed.recipients.map(
        (r) => r.label?.match(/[0-9a-f]{64}$/)?.[0],
      );
      const sentMessages = app.report.publications
        .slice(beforePublications)
        .filter(({ event }) => event?.kind === 9)
        .map(({ event }) => ({ content: event.content, tags: event.tags }));
      sample.outcome = {
        correctText: final.text === expected.text,
        correctSelection: expected.selection.every(
          (n, j) => final.selection[j] === n,
        ),
        correctRecipient:
          JSON.stringify(recipientKeys) === JSON.stringify([nativeKey]) &&
          JSON.stringify(final.recipients) === JSON.stringify([nativeKey]) &&
          final.chips === 1,
        correctOptions: final.options.length === 0,
        focused: final.focused,
        inputDelivered:
          sample.recording.inputReceipt.ordered &&
          sample.recording.inputReceipt.trusted &&
          sample.recording.inputReceipt.misdirected === 0,
        unexpectedPublications: sentMessages.length,
        noAgentRuns:
          agentRuns.pending.length === 0 && agentRuns.stopped.length === 0,
      };
      sample.metrics.workflowCorrect = Number(
        Object.entries(sample.outcome).every(([key, value]) =>
          key === "unexpectedPublications" ? value === 0 : value,
        ),
      );
      const recordingStart = sample.recording.startAt;
      const recordingEnd = recordingStart + sample.recording.durationMs;
      const inside = (at) =>
        Number.isFinite(at) && at > recordingStart && at < recordingEnd;
      const at34 = observed.inputs[releaseOrdinal];
      const request = app.agentLibraryGate.requests.at(-1);
      const held = release?.requestBeforeRelease;
      const capture = release?.choicesAtCapture;
      const nativeOnly = (c) =>
        c?.status === "ready" &&
        c.pending === true &&
        c.complete === false &&
        c.identities.length === 1 &&
        c.identities[0].pubkey === nativeKey &&
        c.identities[0].managed === true &&
        c.selectable.length === 1 &&
        c.selectable[0].pubkey === nativeKey;
      const completeProjection = (c) =>
        c.status === "ready" &&
        c.complete &&
        !c.pending &&
        JSON.stringify(c.identities.map((a) => a.pubkey).sort()) ===
          JSON.stringify(expectedKeys) &&
        JSON.stringify(c.selectable.map((a) => a.pubkey).sort()) ===
          JSON.stringify(expectedKeys) &&
        JSON.stringify(
          c.identities.filter((a) => a.managed).map((a) => a.pubkey),
        ) === JSON.stringify([nativeKey]);
      const pendingAt = canonicalEvents
        .filter(({ choices: c }) => nativeOnly(c))
        .at(-1)?.at;
      const completed = canonicalEvents.filter(
        ({ at, choices: c }) =>
          at > pendingAt && c.complete && !c.pending && c.status === "ready",
      );
      // Interior native event pairs are discrete progress witnesses. Bookends
      // and out-of-window progress cannot substitute for missing interior work.
      const mediaProgress = observed.media.map((media) => {
        const states = media.events.filter(
          (state) =>
            inside(state.at) &&
            !state.paused &&
            !state.ended &&
            state.connected &&
            state.src === media.src &&
            state.width > 0 &&
            state.height > 0 &&
            state.loop &&
            state.muted &&
            Number.isFinite(state.frames) &&
            Number.isFinite(state.currentTime),
        );
        const pair =
          states.flatMap((before, i) => {
            const after = states
              .slice(i + 1)
              .find(
                (s) =>
                  s.at > before.at &&
                  s.frames > before.frames &&
                  s.currentTime !== before.currentTime,
              );
            return after ? [[before, after]] : [];
          })[0] ?? null;
        return {
          src: media.src,
          retainedPlayer:
            [media.before, media.after].every(
              (s) =>
                s.connected &&
                s.src === media.src &&
                !s.paused &&
                !s.ended &&
                s.width > 0 &&
                s.height > 0 &&
                s.loop &&
                s.muted,
            ) &&
            media.events
              .filter((s) => inside(s.at))
              .every(
                (s) =>
                  s.connected &&
                  s.src === media.src &&
                  !s.paused &&
                  !s.ended &&
                  s.type !== "error",
              ),
          interiorSamples: states.length,
          pair,
        };
      });
      sample.eligibility = {
        heldThroughCapture:
          nativeOnly(partial) &&
          nativeOnly(capture) &&
          beforeReads === 1 &&
          app.agentLibraryGate.requests[0].held === false &&
          Number.isFinite(app.agentLibraryGate.requests[0].responseAt) &&
          app.agentLibraryGate.requests[0].responseAt < held?.startedAt &&
          held?.held === true &&
          held.releasedAt === undefined &&
          held.responseAt === undefined &&
          held.abortedAt === undefined &&
          held.startedAt < release.nodeAt &&
          request === app.agentLibraryGate.requests[beforeReads] &&
          app.agentLibraryGate.requests.length === beforeReads + 1 &&
          app.agentLibraryGate.requests.filter((r) => r.held).length === 1,
        releaseInsideWindow:
          release?.ordinal === releaseOrdinal &&
          release.key === "c" &&
          release.trusted === true &&
          release.target === true &&
          release.handlerAt === at34?.handlerAt &&
          release.at === at34?.at &&
          observed.inputs[31]?.key === "@" &&
          release.handlerAt > observed.inputs[31].handlerAt &&
          release.draftAtCapture === "Checking the current draft now @Lo" &&
          JSON.stringify(release.selectionAtCapture) ===
            JSON.stringify([34, 34]) &&
          release.focusedAtCapture === true &&
          inside(release.handlerAt) &&
          inside(at34?.releaseAcknowledgedAt) &&
          request?.releasedAt >= release.nodeAt &&
          request.responseAt >= request.releasedAt &&
          request.abortedAt === undefined,
        completionInsideWindow:
          !sample.recording.boundaryError &&
          completed.length > 0 &&
          completed.every(
            ({ at, choices: c }) =>
              inside(at) && at > release?.handlerAt && completeProjection(c),
          ),
        canonicalComplete: completeProjection(settled),
        allArrivals:
          sample.dispatch.backgroundReceipts.length === 14 &&
          new Set(sample.dispatch.backgroundReceipts.map((r) => r.id)).size ===
            14 &&
          sample.dispatch.backgroundReceipts.every(({ id }) =>
            sample.recording.backgroundRows.some(
              (r) =>
                r.id === id &&
                Number.isFinite(r.domMs) &&
                r.domMs >= 0 &&
                Number.isFinite(r.frameMs) &&
                r.frameMs >= r.domMs &&
                r.frameMs < sample.recording.durationMs,
            ),
          ),
        nativeInteriorProgress:
          scene.threadViews === 3 &&
          scene.videos === 18 &&
          scene.playingVideos === 18 &&
          mediaProgress.length === 18 &&
          new Set(mediaProgress.map((m) => m.src)).size === 18 &&
          mediaProgress.every((m) => m.retainedPlayer && m.pair !== null),
      };
      sample.metrics.workloadEligible = Number(
        Object.values(sample.eligibility).every((value) => value === true),
      );
      sample.work = {
        scenario: "editor-busy-agent-choose",
        intervalMs,
        apparatus: "agent-v3-eligibility-v1",
        mediaInitialization: pausedSeek ? "paused-seek-before-play" : "play",
        mediaProgress,
        mediaAfter,
        recorderWindow: [recordingStart, recordingEnd],
        browserVersion: page.context().browser().version(),
        ...scene,
        expected,
        native,
        profileEvents,
        partial,
        settled,
        canonicalEvents,
        sourceRequests: app.agentLibraryGate.requests,
        sourceEvents: app.report.agentLibraryEvents,
        agentRuns,
        release,
        normative: {
          partialOpenKeys: openOrder,
          settledOpenKeys: openOrder,
          partialFilterKeys: [nativeKey, editorPeople[4].pubkey],
          settledFilterKeys: [nativeKey, editorPeople[4].pubkey],
          openLabels,
        },
        observed,
        backgroundUpdates: sample.dispatch.backgroundReceipts.length,
        backgroundRowsObserved: sample.recording.backgroundRows.filter(
          ({ id, frameMs }) =>
            Number.isFinite(frameMs) &&
            sample.dispatch.backgroundReceipts.some((r) => r.id === id),
        ).length,
        sentMessages,
      };
      sample.state = app.report.state;
      app.report.measurements.push(sample);
      try {
        // Same post-recording loop-transition bookend as the approved v3 case.
        // This cannot replace absent interior progress witnesses.
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
      expect(sample.eligibility).toEqual({
        heldThroughCapture: true,
        releaseInsideWindow: true,
        completionInsideWindow: true,
        canonicalComplete: true,
        allArrivals: true,
        nativeInteriorProgress: true,
      });
      // Workflow failures/missing menu observations remain data, not zero latency.
    } finally {
      app.agentLibraryGate.release();
      if (observation) {
        await observation.evaluate((o) => o.stop());
        await observation.dispose();
      }
    }
  });
