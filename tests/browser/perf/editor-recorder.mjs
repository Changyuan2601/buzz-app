import { setTimeout as delay } from "node:timers/promises";

// Runs in the page. One bounded recorder owns all listeners and frame samples.
// A snapshot is DOM state before rendering, NOT a compositor presentation time.
export function observeEditor(element, { actions, identities, expected }) {
  const start = performance.now();
  const events = [];
  const frames = [];
  const eventTiming = [];
  const backgroundRows = new Map();
  const mutations = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) {
        const element = node instanceof Element ? node : node.parentElement;
        const rows = [
          element?.closest("[data-message-id]"),
          ...(element?.querySelectorAll?.("[data-message-id]") ?? []),
        ];
        for (const row of rows)
          if (
            row?.textContent.includes("Background update ") &&
            !backgroundRows.has(row.dataset.messageId)
          )
            backgroundRows.set(row.dataset.messageId, {
              id: row.dataset.messageId,
              domMs: performance.now() - start,
            });
      }
  });
  mutations.observe(document.body, { childList: true, subtree: true });
  let raf;
  let stopped = false;
  let ended = false;
  let matchedFrames = 0;
  let endpoint = "deadline";
  let resolve;
  const complete = new Promise((r) => {
    resolve = r;
  });
  const keydown = (event) => {
    events.push({
      key: event.key,
      trusted: event.isTrusted,
      target: element.contains(event.target),
      eventMs: event.timeStamp - start,
      handlerMs: performance.now() - start,
    });
  };
  document.addEventListener("keydown", keydown, true);
  const supported = PerformanceObserver.supportedEntryTypes.includes("event");
  const observer = supported
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (entry.startTime >= start)
            eventTiming.push({
              name: entry.name,
              startMs: entry.startTime - start,
              durationMs: entry.duration,
              inputDelayMs: entry.processingStart - entry.startTime,
              processingMs: entry.processingEnd - entry.processingStart,
              interactionId: entry.interactionId,
            });
      })
    : undefined;
  observer?.observe({ type: "event", durationThreshold: 16 });
  function snapshot() {
    const list = document.getElementById(element.getAttribute("aria-controls"));
    const options = [...(list?.querySelectorAll('[role="option"]') ?? [])];
    const identify = (text) =>
      identities.find(({ pubkey }) => text.includes(pubkey))?.name ?? text;
    const label = (option) =>
      option?.querySelector("[data-completion-label] > span")?.textContent ??
      "";
    return {
      text: element.value,
      selection: [element.selectionStart, element.selectionEnd],
      options: options.map(label),
      selected: label(
        options.find(
          (option) => option.getAttribute("aria-selected") === "true",
        ),
      ),
      recipients: [
        ...element.closest("form").querySelectorAll("[data-mention-recipient]"),
      ].map((recipient) =>
        identify(recipient.getAttribute("aria-label") ?? ""),
      ),
      chips: element.querySelectorAll(".inline-chip").length,
      focused: document.activeElement === element,
    };
  }
  function frame() {
    if (stopped) return;
    const before = performance.now();
    for (const row of backgroundRows.values()) row.frameMs ??= before - start;
    const state = snapshot();
    frames.push({
      t: before - start,
      ...state,
      probeMs: performance.now() - before,
    });
    const matches =
      state.text === expected.text &&
      (!expected.selection ||
        expected.selection.every((n, i) => state.selection[i] === n)) &&
      (expected.options
        ? JSON.stringify(state.options) === JSON.stringify(expected.options)
        : !state.options.length) &&
      (expected.recipient
        ? state.recipients.includes(expected.recipient) && state.chips > 0
        : !state.recipients.length);
    matchedFrames = ended && matches ? matchedFrames + 1 : 0;
    // A pending directory read is not completion. Preserve misses at the explicit
    // deadline; two frames provide a rendering opportunity, not a paint receipt.
    if (matchedFrames >= 2) {
      endpoint = "observed";
      resolve();
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return {
    end() {
      ended = true;
    },
    async result() {
      let timer;
      await Promise.race([
        complete,
        new Promise((r) => {
          timer = setTimeout(r, 5000);
        }),
      ]);
      clearTimeout(timer);
      return {
        actions,
        events,
        frames,
        eventTiming,
        eventTimingSupported: supported,
        endpoint,
        backgroundRows: [...backgroundRows.values()],
        durationMs: performance.now() - start,
        final: snapshot(),
      };
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", keydown, true);
      observer?.disconnect();
      mutations.disconnect();
    },
  };
}

// Dispatch is driven by a real Node clock, never by a page timer or UI success.
// Both down/up messages are enqueued without awaiting the renderer's reply.
export async function dispatchKeys(page, actions, intervalMs, background) {
  const start = performance.now();
  const receipts = [];
  const pending = [];
  const backgroundReceipts = [];
  let nextBackground = 0;
  for (const [index, action] of actions.entries()) {
    const plannedMs = index * intervalMs;
    await delay(Math.max(0, start + plannedMs - performance.now()));
    if (background && plannedMs >= nextBackground) {
      backgroundReceipts.push(background(backgroundReceipts.length));
      nextBackground += 150;
    }
    const receipt = {
      plannedMs,
      sentMs: performance.now() - start,
      key: action.key,
    };
    receipts.push(receipt);
    // Playwright's down/up calls enqueue protocol messages synchronously. Using
    // press() here would await keydown before it sends keyup and alter ordering.
    const commands = [];
    if (action.shift) commands.push(page.keyboard.down("Shift"));
    commands.push(page.keyboard.down(action.key), page.keyboard.up(action.key));
    if (action.shift) commands.push(page.keyboard.up("Shift"));
    pending.push(
      Promise.all(commands).then(() => {
        receipt.ackMs = performance.now() - start;
      }),
    );
  }
  await Promise.all(pending);
  return { receipts, backgroundReceipts };
}

const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
export function editorMetrics(recording, dispatch) {
  const { frames, actions } = recording;
  // Shift is an explicit modifier event; it does not correspond to a scenario action.
  const events = recording.events.filter(({ key }) => key !== "Shift");
  recording.inputReceipt = {
    expected: actions.length,
    observed: events.length,
    ordered:
      events.length === actions.length &&
      events.every((event, i) => event.key === actions[i].key),
    trusted: events.every((event) => event.trusted),
    misdirected: events.filter((event) => !event.target).length,
  };
  const keys = events.map((event, index) => {
    const action = actions[index];
    if (
      !action ||
      !recording.inputReceipt.ordered ||
      !recording.inputReceipt.trusted
    )
      return {
        ...event,
        phase: "unattributed",
        nextFrameMs: null,
        stateObservedMs: null,
      };
    const next = events[index + 1]?.eventMs ?? Infinity;
    // Text, selection and highlight states are superseded by the next handler.
    // A later backspace must not recreate and retroactively credit a typed state.
    // Query results and accepted recipients remain meaningful during later input.
    const stateEnd =
      !action.options && !action.recipient
        ? (events[index + 1]?.handlerMs ?? Infinity)
        : Infinity;
    const nextFrame = frames.find(({ t }) => t >= event.handlerMs);
    const matched = frames.find(
      (frame) =>
        event.target &&
        frame.t >= event.handlerMs &&
        frame.t < stateEnd &&
        (action.text === undefined || frame.text === action.text) &&
        (!action.selection ||
          action.selection.every((n, i) => frame.selection[i] === n)) &&
        (!action.options ||
          JSON.stringify(frame.options) === JSON.stringify(action.options)) &&
        (!action.selected || frame.selected === action.selected) &&
        (!action.recipient ||
          (frame.recipients.includes(action.recipient) &&
            frame.chips > 0 &&
            !frame.options.length)),
    );
    return {
      ...event,
      phase: action.phase,
      nextFrameMs: nextFrame ? nextFrame.t - event.eventMs : null,
      stateObservedMs: matched ? matched.t - event.eventMs : null,
      observedBeforeNextInput: !!matched && matched.t < next,
    };
  });
  const metrics = {};
  function distribution(name, values) {
    if (!values.length) return;
    metrics[`${name}P50Ms`] = percentile(values, 0.5);
    metrics[`${name}P95Ms`] = percentile(values, 0.95);
    metrics[`${name}MaxMs`] = Math.max(...values);
  }
  const first = events[0]?.eventMs ?? 0;
  const lastHandler = events.at(-1)?.handlerMs ?? 0;
  const last =
    frames.find(({ t }) => t > lastHandler)?.t ?? frames.at(-1)?.t ?? first;
  const times = [
    first,
    ...frames.filter(({ t }) => t > first && t < last).map(({ t }) => t),
    last,
  ];
  distribution(
    "activeRafGap",
    times.slice(1).map((t, i) => t - times[i]),
  );
  distribution(
    "probe",
    frames.map(({ probeMs }) => probeMs),
  );
  distribution(
    "dispatchLateness",
    dispatch.receipts.map(({ sentMs, plannedMs }) => sentMs - plannedMs),
  );
  distribution(
    "dispatchAck",
    dispatch.receipts.map(({ ackMs, sentMs }) => ackMs - sentMs),
  );
  for (const phase of recording.inputReceipt.ordered &&
  recording.inputReceipt.trusted
    ? new Set(actions.map(({ phase }) => phase))
    : []) {
    const group = keys.filter((key) => key.phase === phase);
    distribution(
      `${phase}NextFrame`,
      group.map(({ nextFrameMs }) => nextFrameMs).filter(Number.isFinite),
    );
    distribution(
      `${phase}State`,
      group
        .map(({ stateObservedMs }) => stateObservedMs)
        .filter(Number.isFinite),
    );
    metrics[`${phase}Inputs`] = group.length;
    metrics[`${phase}UnobservedStates`] = group.filter(
      ({ stateObservedMs }) => stateObservedMs === null,
    ).length;
    metrics[`${phase}ObservedBeforeNextInput`] = group.filter(
      ({ observedBeforeNextInput }) => observedBeforeNextInput,
    ).length;
  }
  distribution(
    "inputQueue",
    events.map(({ handlerMs, eventMs }) => handlerMs - eventMs),
  );
  recording.keys = keys;
  return metrics;
}

export async function recordEditor({
  page,
  input,
  actions,
  identities,
  expected,
  intervalMs,
  background,
  browserName,
  cpu,
}) {
  const cdp =
    browserName === "chromium"
      ? await page.context().newCDPSession(page)
      : undefined;
  let observer;
  try {
    if (cdp) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    observer = await input.evaluateHandle(observeEditor, {
      actions,
      identities,
      expected,
    });
    const dispatch = await dispatchKeys(page, actions, intervalMs, background);
    await observer.evaluate((o) => o.end());
    const recording = await observer.evaluate((o) => o.result());
    return { metrics: editorMetrics(recording, dispatch), recording, dispatch };
  } finally {
    if (observer) {
      await observer.evaluate((o) => o.stop());
      await observer.dispose();
    }
    if (cdp) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await cdp.detach();
    }
  }
}
