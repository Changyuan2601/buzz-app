// In-page recorder, installed before the app with addInitScript; it must stay
// silent (the fixture fails tests on console output or errors). Each frame,
// rAF posts a user-blocking task that runs after paint, when layout is clean,
// so reading geometry forces no layout. It records every mounted row of the
// timeline and the thread panel; metrics.mjs computes the definitions offline.
// Its only logic is the settle barrier.
export function installRecorder() {
  if (window.__perf) return;
  const now = () => performance.now();
  const SCROLLER = "[data-message-scroller]";
  const SURFACES = {
    timeline: {
      // Scroll writes are attributed by [data-message-scroller]; require it here
      // too, so losing it fails closed rather than reading zero corrections.
      section: "section[data-message-scroller][data-channel-timeline]",
      list: ":scope > ol",
      rows: ":scope > ol > li",
    },
    thread: {
      section: 'section[data-message-scroller][aria-label="Thread messages"]',
      list: "[data-thread-rows]",
      rows: "[data-thread-rows] [data-message-id]",
    },
  };
  let session = null;
  let inflight = 0;
  let lastChange = now(); // settle: last DOM, scroll, read or long-task activity
  let inputUntil = -Infinity;
  let lastScroll = -Infinity;
  let chain = false;
  const changed = (t = now()) => (lastChange = Math.max(lastChange, t));

  // Relay reads: [start, end, older page]; one in flight holds the barrier.
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (!url.includes("/api/relay/") || url.endsWith("/stream"))
      return originalFetch(input, init);
    const body = String(init?.body ?? "");
    const older = body.includes('"#h"') && body.includes('"until"') ? 1 : 0;
    const read = [now(), null, older];
    session?.fetches.push(read);
    inflight++;
    const done = () => {
      if (read[1] === null) [read[1], inflight] = [now(), inflight - 1];
      changed();
    };
    return originalFetch(input, init).then(
      (response) => {
        response.clone().arrayBuffer().then(done, done);
        return response;
      },
      (error) => {
        done();
        throw error;
      },
    );
  };

  // Programmatic scroll writes per scroller (applied px and count), through
  // all four paths: Virtua corrects with scrollBy, the app also uses
  // scrollTo, scrollIntoView and the scrollTop setter.
  const writes = new Map();
  const noteWrite = (scroller, before) => {
    const write = writes.get(scroller) ?? { px: 0, n: 0 };
    writes.set(scroller, {
      px: write.px + scroller.scrollTop - before,
      n: write.n + 1,
    });
    changed();
  };
  const own = (element) => (element.matches?.(SCROLLER) ? element : null);
  for (const [name, scrollerOf] of [
    ["scrollTo", own],
    ["scrollBy", own],
    ["scrollIntoView", (element) => element.closest?.(SCROLLER)],
  ]) {
    const original = Element.prototype[name];
    Element.prototype[name] = function (...args) {
      const scroller = scrollerOf(this);
      const before = scroller?.scrollTop;
      const result = original.apply(this, args);
      if (scroller) noteWrite(scroller, before);
      return result;
    };
  }
  const scrollTop = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "scrollTop",
  );
  Object.defineProperty(Element.prototype, "scrollTop", {
    ...scrollTop,
    set(value) {
      const before = own(this) && scrollTop.get.call(this);
      scrollTop.set.call(this, value);
      if (own(this)) noteWrite(this, before);
    },
  });

  // Wheel input is active for 150ms and through the scroll it started.
  const listen = (type, handler) =>
    addEventListener(type, handler, { capture: true, passive: true });
  listen("wheel", () => {
    [inputUntil, chain] = [now() + 150, true];
    session?.wheels.push(now());
  });
  listen("scroll", (event) => {
    if (own(event.target)) lastScroll = now();
  });
  listen("scrollend", (event) => {
    if (own(event.target)) chain = false;
  });
  new PerformanceObserver((list) => {
    for (const task of list.getEntries())
      changed(task.startTime + task.duration);
  }).observe({ type: "longtask" });

  // Per scroller: rows mounted into the list, and content changes inside rows
  // that were in view (a list change or a visible row's change is not quiet).
  const watched = new WeakMap();
  const watch = (scroller, def) => {
    if (watched.has(scroller)) return watched.get(scroller);
    const state = { added: 0, visible: new Set() };
    new MutationObserver((records) => {
      const list = scroller.querySelector(def.list);
      for (const record of records) {
        if (record.target === list) {
          if (record.type === "childList")
            state.added += record.addedNodes.length;
          changed();
          continue;
        }
        for (let node = record.target; node && node !== scroller; )
          if (state.visible.has(node)) {
            changed();
            break;
          } else node = node.parentNode;
      }
    }).observe(scroller, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "src", "data-revealed"],
    });
    watched.set(scroller, state);
    return state;
  };

  const opacity = (element) => {
    let value = 1;
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none") return 0;
      value *= Number(style.opacity);
    }
    return value;
  };
  const round = (value) => Math.round(value * 10) / 10;
  /** One surface in content coordinates: every mounted row [id, top, bottom, hidden]. */
  const measure = (name, def, scroller) => {
    const state = watch(scroller, def);
    const st = scroller.scrollTop;
    const ch = scroller.clientHeight;
    const origin =
      scroller.getBoundingClientRect().top + scroller.clientTop - st;
    const list = scroller.querySelector(def.list);
    const box = list?.getBoundingClientRect();
    const hp = name === "thread" && opacity(list ?? scroller) < 0.5 ? 1 : 0;
    const rows = [];
    let lost = 0;
    state.visible.clear();
    for (const node of scroller.querySelectorAll(def.rows)) {
      const { top, bottom, height } = node.getBoundingClientRect();
      if (!height) continue;
      const id =
        node.dataset.messageId ??
        node.querySelector("[data-message-id]")?.dataset.messageId;
      // A mounted row without an id: the selectors no longer fit the DOM.
      if (!id) lost = 1;
      if (bottom - origin > st && top - origin < st + ch)
        state.visible.add(node);
      rows.push([
        id,
        round(top - origin),
        round(bottom - origin),
        hp || node.style.visibility === "hidden" ? 1 : 0,
      ]);
    }
    if (!rows.length && scroller.querySelector("[data-message-id]")) lost = 1;
    const edge = scroller.querySelector(":scope > div:first-child");
    const button = edge?.querySelector("button");
    const write = writes.get(scroller) ?? { px: 0, n: 0 };
    writes.delete(scroller);
    const added = state.added;
    state.added = 0;
    return {
      st: round(st),
      ch,
      sh: scroller.scrollHeight,
      lt: box ? round(box.top - origin) : null,
      lh: box ? round(box.height) : null,
      hp,
      prog: round(write.px),
      writes: write.n,
      added,
      cid: scroller.getAttribute("data-channel-timeline"),
      // "Load older" or "Loading older…" is shown: history remains loadable.
      older: button && !edge.querySelector('[role="alert"]') ? 1 : 0,
      // Still working: launch settling, an older page loading, the thread
      // positioning its rows.
      busy:
        scroller.hasAttribute("data-buzz-launch-pending") ||
        scroller.hasAttribute("data-positioning") ||
        scroller.getAttribute("aria-busy") === "true" ||
        button?.disabled ||
        /Loading older/.test(button?.textContent ?? "")
          ? 1
          : 0,
      lost,
      rows,
    };
  };

  const acts = [];
  let signature = "";
  const sample = (raf) => {
    if (!session) return;
    const t = now();
    const frame = {
      raf,
      t,
      input: t < inputUntil || (chain && t - lastScroll < 300) ? 1 : 0,
      s: {},
    };
    for (const [name, def] of Object.entries(SURFACES)) {
      const scroller = document.querySelector(def.section);
      if (scroller) frame.s[name] = measure(name, def, scroller);
    }
    const focused = document.activeElement?.closest?.("[data-message-id]");
    frame.focus = focused
      ? [
          focused.dataset.messageId,
          focused.closest(SURFACES.thread.section) ? "thread" : "timeline",
        ]
      : null;
    frame.palette = document.querySelector("[data-search-palette]") ? 1 : 0;
    // Not quiet: the picture or scroll moved, a surface is busy, its "Loading
    // messages…" placeholder shows, a row in view is hidden (unmeasured), or
    // no row in view is painted.
    const surfaces = Object.values(frame.s);
    const next = JSON.stringify([
      surfaces.map((s) => [s.st, s.sh, s.hp, s.rows]),
      frame.palette,
      frame.focus,
    ]);
    const inView = (s) =>
      s.rows.filter(([, top, bottom]) => bottom > s.st && top < s.st + s.ch);
    if (
      next !== signature ||
      document.querySelector('[data-buzz-launch-pending="required"]') ||
      surfaces.some(
        (s) =>
          s.busy ||
          s.hp ||
          inView(s).some((row) => row[3]) ||
          (s.rows.length && !inView(s).length),
      )
    )
      changed(t);
    signature = next;
    if (session.frames.length < 20000) session.frames.push(frame);
    else session.truncated = true;
    for (const waiter of session.waiters) {
      const quiet =
        !inflight &&
        t - Math.max(lastChange, waiter.since) >= waiter.quietMs &&
        t - waiter.since >= waiter.minMs;
      waiter.frames = quiet ? waiter.frames + 1 : 0;
      if (waiter.frames < 10 && t < waiter.deadline) continue;
      session.waiters.delete(waiter);
      waiter.resolve({ settled: waiter.frames >= 10, lastChange });
    }
    while (acts.length) acts.shift()();
  };
  const tick = (raf) => {
    if (!session) return;
    requestAnimationFrame(tick);
    scheduler.postTask(() => sample(raf), { priority: "user-blocking" });
  };

  window.__perf = {
    start() {
      writes.clear();
      session = {
        frames: [],
        wheels: [],
        fetches: [],
        waiters: new Set(),
        truncated: false,
      };
      requestAnimationFrame(tick);
    },
    /** Run `fn` right after the next sample; resolves with its page-clock time. */
    act: (fn) =>
      new Promise((resolve, reject) =>
        acts.push(() => {
          const t = now();
          try {
            fn();
            resolve(t);
          } catch (error) {
            reject(error);
          }
        }),
      ),
    /** Resolves once nothing changed and no read was in flight for `quietMs`
     * over 10 frames, not before `minMs`; `settled: false` at the timeout. */
    settled: ({ quietMs = 500, minMs = 0, timeoutMs = 20000 } = {}) =>
      new Promise((resolve) => {
        const since = now();
        session.waiters.add({
          quietMs,
          minMs,
          since,
          deadline: since + Math.max(timeoutMs, minMs + quietMs),
          frames: 0,
          resolve,
        });
      }),
    stop() {
      const { waiters, ...recorded } = session;
      session = null;
      for (const waiter of waiters)
        waiter.resolve({ settled: false, lastChange });
      return { ...recorded, stoppedAt: now() };
    },
  };
}
