// Runs inside the browser. DOM truth plus two rendering opportunities qualify
// readiness; a mounted shell, loading row or error can never finish a sample.
export function observeGitHub({ signed, timeoutMs = 10_000 }) {
  let start, end, frame, timer;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const milestones = {};
  const consecutive = {};
  const frames = [];
  const observer = new PerformanceObserver((list) =>
    frames.push(...list.getEntries()),
  );
  if (!PerformanceObserver.supportedEntryTypes.includes("long-animation-frame"))
    throw new Error("Long Animation Frames unavailable");
  observer.observe({ type: "long-animation-frame" });
  const visible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (
      !rect.width ||
      !rect.height ||
      rect.top < 0 ||
      rect.left < 0 ||
      rect.bottom > innerHeight ||
      rect.right > innerWidth
    )
      return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        style.opacity === "0"
      )
        return false;
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        const clip = node.getBoundingClientRect();
        if (rect.top < clip.top || rect.bottom > clip.bottom) return false;
      }
    }
    return true;
  };
  const mark = (name, ready, now) => {
    consecutive[name] = ready ? (consecutive[name] ?? 0) + 1 : 0;
    if (consecutive[name] === 2 && milestones[name] === undefined)
      milestones[name] = now - start;
  };
  const tick = () => {
    if (end !== undefined) return;
    const now = performance.now();
    const panel = document.querySelector('aside[aria-label="GitHub"]');
    const find = (selector, text) =>
      [...(panel?.querySelectorAll(selector) ?? [])].find(
        (node) => node.textContent.trim() === text && visible(node),
      );
    const fact = (label, value) =>
      [...(panel?.querySelectorAll("dl > div") ?? [])].some(
        (node) =>
          node.querySelector("dt")?.textContent === label &&
          node.querySelector("dd")?.textContent === value &&
          visible(node),
      );
    const description =
      !!find("p, div", "Revision three benchmark description.") &&
      !!find("p, div", "Render correct data before reporting success.") &&
      !!find("h2", "Implementation");
    const details =
      !!find("h2", "Benchmark change #9") &&
      !!find('[data-pr-state="open"]', "open") &&
      !!find(
        'a[href="https://github.com/sample/project/tree/fix/perf-v3"]',
        "fix/perf-v3",
      ) &&
      !!find('a[href="https://github.com/sample/project/tree/main"]', "main") &&
      fact("Files changed", "2") &&
      fact("Changes", "+3 / −1") &&
      visible(panel?.querySelector('time[datetime="2026-10-26T12:00:00Z"]'));
    const rows = [
      ...(panel?.querySelectorAll(
        '[aria-label="Pull request checklist"] > li',
      ) ?? []),
    ];
    const expected = signed
      ? [
          "Checks1 failed · 1 running · 1 passed",
          "ReviewChanges requested by reviewer",
          "Threads2 unresolved",
          "MergeBlocked by main’s rules",
        ]
      : ["Checks1 failed · 1 running · 1 passed"];
    const checklist =
      expected.every((text) =>
        rows.some((node) => node.textContent === text && visible(node)),
      ) &&
      !!find(
        'button[aria-expanded="false"]',
        "1 failed · 1 running · 1 passed",
      );
    mark("descriptionMs", description, now);
    mark("detailsMs", details, now);
    mark("checklistMs", checklist, now);
    mark(
      "completeMs",
      description &&
        details &&
        checklist &&
        !panel.querySelector('[role="alert"]'),
      now,
    );
    if (milestones.completeMs !== undefined) {
      end = now;
      clearTimeout(timer);
      finish();
    } else frame = requestAnimationFrame(tick);
  };
  const click = (event) => {
    if (!event.target.closest("#open-pr") || start !== undefined) return;
    start = performance.now();
    frame = requestAnimationFrame(tick);
    timer = setTimeout(() => {
      end = performance.now();
      cancelAnimationFrame(frame);
      finish();
    }, timeoutMs);
  };
  document.addEventListener("click", click, true);
  return {
    done: () => done,
    result: () => ({
      ...milestones,
      durationMs: end - start,
      error:
        milestones.completeMs === undefined
          ? "Correct complete PR was not visible before deadline"
          : undefined,
      requests: performance
        .getEntriesByType("resource")
        .filter(
          (entry) =>
            entry.startTime >= start &&
            (entry.name.includes("/__github/") ||
              entry.name.startsWith("https://api.github.com/")),
        )
        .map((entry) => ({
          url: entry.name,
          startMs: entry.startTime - start,
          responseMs: entry.responseEnd - start,
          durationMs: entry.duration,
        })),
    }),
    async longFrames() {
      await new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => setTimeout(resolve, 0)),
        ),
      );
      frames.push(...observer.takeRecords());
      return frames
        .filter(
          (entry) =>
            entry.startTime < end && entry.startTime + entry.duration > start,
        )
        .map((entry) => ({
          startMs: entry.startTime - start,
          durationMs: entry.duration,
          blockingDurationMs: entry.blockingDuration,
        }));
    },
    stop() {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("click", click, true);
    },
  };
}
