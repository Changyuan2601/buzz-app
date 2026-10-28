import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import { test as base, expect } from "../fixture.mjs";
import { openPage } from "../navigation.mjs";
import { virtuaIdle } from "../timeline.mjs";
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
    loaf = [];
  const videos = [...document.querySelectorAll("video")];
  const mediaState = (video) => ({
    at: performance.now(),
    currentTime: video.currentTime,
    frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
    readyState: video.readyState,
    paused: video.paused,
    ended: video.ended,
    width: video.videoWidth,
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
    if (
      inputs.length - 1 === releaseOrdinal &&
      receipt.trusted &&
      receipt.target
    )
      void window.releaseEditorAgentLibrary({
        ordinal: releaseOrdinal,
        ...receipt,
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
    await page.route("**/api/relay/primary/media?**", (route) => {
      const video = decodeURIComponent(route.request().url()).includes(".mp4");
      return route.fulfill({
        path: video ? videoPath : imagePath,
        contentType: video ? "video/mp4" : "image/png",
      });
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
      await thread.locator("video").evaluateAll(async (videos) => {
        await Promise.all(
          videos.map(async (video) => {
            video.muted = true;
            video.loop = true;
            await video.play();
          }),
        );
      });
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
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
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
        completionInsideWindow: !sample.recording.boundaryError,
        canonicalComplete:
          settled.complete &&
          !settled.pending &&
          JSON.stringify(settled.identities.map((a) => a.pubkey).sort()) ===
            JSON.stringify(expectedKeys) &&
          JSON.stringify(settled.selectable.map((a) => a.pubkey).sort()) ===
            JSON.stringify(expectedKeys) &&
          JSON.stringify(
            settled.identities.filter((a) => a.managed).map((a) => a.pubkey),
          ) === JSON.stringify([nativeKey]),
        noAgentRuns:
          agentRuns.pending.length === 0 && agentRuns.stopped.length === 0,
      };
      sample.metrics.workflowCorrect = Number(
        Object.entries(sample.outcome).every(([key, value]) =>
          key === "unexpectedPublications" ? value === 0 : value,
        ),
      );
      sample.work = {
        scenario: "editor-busy-agent-choose",
        intervalMs,
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
      await testInfo.attach("perf-sample", {
        body: JSON.stringify(sample),
        contentType: "application/json",
      });
      expect(sample.work.backgroundUpdates).toBe(14);
      expect(sample.work.backgroundRowsObserved).toBe(14);
      expect(release.ordinal).toBe(releaseOrdinal);
      // Workflow failures/missing menu observations remain data, not zero latency.
    } finally {
      app.agentLibraryGate.release();
      if (observation) {
        await observation.evaluate((o) => o.stop());
        await observation.dispose();
      }
    }
  });
