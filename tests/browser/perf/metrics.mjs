// Pure metrics over recorder sessions (recorder.mjs). Durations weight each
// frame by how long it stayed on screen (its rAF interval); latencies use the
// post-paint clock `at`, the clock of perf.act and input events.
export const BLANK_PX = 24; // a frame is blank above this many uncovered px
export const DROPPED_MS = 25; // > 1.5 vsync at 60Hz

/** Total length of the union of [a, b] spans. */
export function union(spans) {
  let total = 0;
  let start = 0;
  let end = -Infinity;
  for (const [a, b] of spans
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]))
    if (a > end) {
      if (end > start) total += end - start;
      [start, end] = [a, b];
    } else end = Math.max(end, b);
  return end > start ? total + end - start : total;
}

/** Painted rows contiguous with each viewport edge: how far they reach past 0 and ch. */
export function lead(rows, ch) {
  const painted = rows.filter((r) => !r.hidden).sort((a, b) => a.top - b.top);
  const covers = (y) =>
    painted.some((r) => r.top <= y + 0.5 && r.bottom >= y - 0.5);
  let top = 0;
  let bottom = ch;
  for (const r of painted.toReversed())
    if (r.top < top && r.bottom >= top - 0.5) top = r.top;
  for (const r of painted)
    if (r.bottom > bottom && r.top <= bottom + 0.5) bottom = r.bottom;
  return { above: covers(0) ? -top : 0, below: covers(ch) ? bottom - ch : 0 };
}

/** Largest move (px) of a painted row in view in both frames that the reader
 * did not cause: content motion net of programmatic writes during input, or of
 * the whole scroll delta when idle. An idle swap of every row in view is
 * charged by the rows that survived just outside it, else one viewport. */
export function shift(prev, next, input) {
  const ref = input ? next.prog : next.st - prev.st;
  const inView = (r, st) =>
    !r.hidden && r.bottom - st > 0 && r.top - st < next.ch;
  const before = new Map(
    prev.rows.filter((r) => !r.hidden).map((r) => [r.id, r]),
  );
  const visible = next.rows.filter((r) => inView(r, next.st));
  const kept = visible.filter((r) => before.has(r.id));
  let px = Math.max(
    0,
    ...kept.map((r) => Math.abs(r.top - before.get(r.id).top - ref)),
  );
  const prevInView = prev.rows.filter((r) => inView(r, prev.st));
  if (!input && visible.length && !kept.length && prevInView.length) {
    const after = new Map(
      next.rows.filter((r) => !r.hidden).map((r) => [r.id, r]),
    );
    const survivors = prevInView.filter((r) => after.has(r.id));
    px = survivors.length
      ? Math.max(
          ...survivors.map((r) => Math.abs(after.get(r.id).top - r.top - ref)),
        )
      : next.ch;
  }
  return px > 0.5 ? px : 0;
}

/** Per-frame series for one surface ("timeline" or "thread"); timeline frames
 * of another channel are absent. Rows are in viewport coordinates. */
export function frames(session, surface, channel) {
  const out = [];
  let prev = null;
  let gap = false;
  for (const [index, f] of session.frames.entries()) {
    const s = f.s[surface];
    const base = {
      t: f.raf,
      at: f.t,
      input: f.input,
      focus: f.focus,
      palette: f.palette,
      interval: index ? f.raf - session.frames[index - 1].raf : 0,
    };
    if (!s || (channel && s.cid !== channel)) {
      out.push({ ...base, absent: true });
      gap ||= !!prev;
      continue;
    }
    const rows = s.rows.map(([id, top, bottom, h]) => ({
      id,
      top,
      bottom,
      hidden: h === 1,
    }));
    const view = rows.map((r) => ({
      ...r,
      top: r.top - s.st,
      bottom: r.bottom - s.st,
    }));
    const lo = s.lt == null ? 0 : Math.max(0, s.lt - s.st);
    const hi = s.lt == null ? s.ch : Math.min(s.ch, s.lt + s.lh - s.st);
    const clip = (r) => [Math.max(r.top, lo), Math.min(r.bottom, hi)];
    const covered = union(view.filter((r) => !r.hidden).map(clip));
    const next = { ...s, rows, lead: lead(view, s.ch) };
    const row = {
      ...base,
      st: s.st,
      ch: s.ch,
      hp: s.hp,
      older: s.older,
      writes: s.writes,
      prog: s.prog,
      added: s.added,
      rows: view,
      blank: Math.max(0, hi - lo - covered),
      hidden: union(view.map(clip)) - covered,
      bottomGap: s.sh - s.ch - s.st,
      overlap: 0,
      shiftPx: prev ? shift(prev, next, f.input === 1) : 0,
    };
    // DOM-adjacent painted rows in view; pairs over 4000px apart are not neighbours.
    const shown = (r) => !r.hidden && r.bottom > 0 && r.top < s.ch;
    for (const [i, b] of view.entries()) {
      const a = view[i - 1];
      const px = a && a.bottom - b.top;
      if (a && shown(a) && shown(b) && px > 0.5 && px <= 4000)
        row.overlap = Math.max(row.overlap, px);
    }
    // Chromium scrolls on the compositor: travel past the previous frame's
    // painted lead was blank on screen for its share of the interval.
    const travel = prev ? s.st - s.prog - prev.st : 0;
    const exposed =
      !prev || gap
        ? 0
        : Math.min(
            s.ch,
            travel < 0 ? -travel - prev.lead.above : travel - prev.lead.below,
          );
    row.exposedShare = exposed > BLANK_PX ? exposed / Math.abs(travel) : 0;
    out.push(row);
    prev = next;
    gap = false;
  }
  for (const [i, r] of out.entries()) r.w = (out[i + 1]?.t ?? r.t) - r.t;
  return out;
}

/** Stats of the window [from, to) on the rAF clock; null when it has no frames
 * (a window that saw nothing must fail its iteration, not read as clean). */
export function stats(series, from, to) {
  const out = {
    screenBlankMs: 0,
    hiddenMs: 0,
    deadInputMs: 0,
    shiftPx: 0,
    overlapPx: 0,
    droppedFrames: 0,
    rowsAdded: 0,
    corrections: 0,
  };
  let count = 0;
  for (const [i, r] of series.entries()) {
    if (r.absent || r.t < from || r.t >= to) continue;
    const span = Math.min(r.t + r.w, to) - r.t;
    const next = series[i + 1];
    count++;
    // Blank on screen: DOM blank, else the exposure of the following interval.
    out.screenBlankMs +=
      r.blank > BLANK_PX
        ? span
        : next && !next.absent
          ? span * next.exposedShare
          : 0;
    if (r.hidden > 0.5) out.hiddenMs += span;
    if (r.input && r.st <= 0.5 && r.older) out.deadInputMs += span;
    out.shiftPx += r.shiftPx;
    out.overlapPx = Math.max(out.overlapPx, r.overlap);
    out.droppedFrames += r.interval > DROPPED_MS ? 1 : 0;
    out.rowsAdded += r.added;
    out.corrections += r.writes;
  }
  return count
    ? Object.fromEntries(
        Object.entries(out).map(([k, v]) => [k, Math.round(v * 10) / 10]),
      )
    : null;
}

/** First frame painted after page-clock `time`, on the rAF clock. */
export const frameAt = (series, time) =>
  series.find((r) => !r.absent && r.at > time)?.t ?? time;

/** A wheel-driven fling: the input window, after it, and once the list stopped
 * (two frames after its last movement not explained by corrections). */
export function fling(session) {
  const series = frames(session, "timeline");
  const [first, last] = [session.wheels[0], session.wheels.at(-1)];
  const start = frameAt(series, first ?? Infinity);
  const end = frameAt(series, last ?? Infinity);
  const moving = series.filter((r) => !r.absent && r.t >= start);
  let still = 0;
  for (let i = 1; i < moving.length; i++) {
    const moved = moving[i].st - moving[i - 1].st;
    if (Math.abs(moved) > 0.5 && Math.abs(moved - moving[i].prog) > 0.5)
      still = i;
  }
  const stopped = moving[still + 2]?.t ?? session.stoppedAt;
  const inWindow = series.filter((r) => !r.absent && r.t >= start && r.t < end);
  // Travel includes the frame painted after the last wheel.
  const travel = series.filter((r) => !r.absent && r.t >= start && r.t <= end);
  return {
    series,
    wheels: session.wheels.length,
    travelledPx: travel.length ? Math.abs(travel[0].st - travel.at(-1).st) : 0,
    loadable: inWindow.length > 0 && inWindow.every((r) => r.older),
    input: stats(series, start, end),
    afterStop: stats(series, end, session.stoppedAt),
    stopped: stats(series, stopped, session.stoppedAt),
  };
}

/** A surface opening after the action at `from`: first painted row in view,
 * and when the picture stopped changing. */
export function opened(series, from) {
  const after = series.filter((r) => !r.absent && r.at > from);
  const inView = (r) => r.rows.filter((x) => x.bottom > 0 && x.top < r.ch);
  const picture = (r) =>
    inView(r)
      .map((x) => `${x.id}:${Math.round(x.top)}:${x.hidden}`)
      .join();
  const first = after.find((r) => inView(r).some((x) => !x.hidden));
  let complete = after.length;
  while (complete > 0 && picture(after[complete - 1]) === picture(after.at(-1)))
    complete--;
  return {
    firstRowsMs: first ? first.at - from : null,
    completeMs: after.length ? after[complete].at - from : null,
  };
}

/** Row `id` once placed (painted, mostly in view, surface shown): its largest
 * distance from where it ends (mounted, hidden or not), and whether it ends in view. */
export function placement(series, id, from) {
  const top = (r) => r.rows?.find((x) => x.id === id)?.top;
  const placed = (r) => {
    const x = r.rows?.find((x) => x.id === id && !x.hidden);
    const seen = x && Math.min(x.bottom, r.ch) - Math.max(x.top, 0);
    return (
      !!x &&
      !r.hp &&
      (seen >= Math.min(x.bottom - x.top, r.ch) / 2 ||
        (x.top >= 0 && x.top < r.ch))
    );
  };
  const after = series.filter((r) => !r.absent && r.at >= from);
  const index = after.findIndex(placed);
  const end = after.length ? top(after.at(-1)) : undefined;
  const tops = after
    .slice(Math.max(0, index))
    .map(top)
    .filter((v) => v != null);
  return {
    displacementPx:
      index < 0 || end == null
        ? null
        : Math.max(...tops.map((v) => Math.abs(v - end))),
    inViewAtEnd: after.length > 0 && placed(after.at(-1)),
  };
}

/** Time from `from` until focus is inside row `id` on `surface`. */
export function focused(series, id, surface, from) {
  const hit = series.find(
    (r) => r.at > from && r.focus?.[0] === id && r.focus[1] === surface,
  );
  return hit ? hit.at - from : null;
}
