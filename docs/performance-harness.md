# Performance harness

An opt-in Playwright suite (`tests/browser/perf`) that measures what a reader
sees in the message timeline: how long channels, search results and threads
take to show, how much blank space a fast scroll exposes, and whether rows jump
or overlap. It runs the production build in headless Chromium against the
fixture broker, with a deterministic signed corpus (`perf/corpus.mjs` on the
vendored `tests/fixtures/complex-corpus.mjs`) and modelled relay latency. It is
a hill-climbing instrument, not a gate: nothing runs it in CI.

## Run

```sh
bin/pnpm test:perf [-g <test>]          # one run directory (PERF_RUN_DIR), report.json inside
bin/pnpm perf:ab --base <tree> --candidate <tree> --out <dir> \
  --target "<scenario>/<variant> <metric>" [--n 7] -- -g <test>
bin/pnpm perf:compare <base-run,...> <candidate-run,...> [--target <key>]
```

`perf:ab` runs `test:perf` in each tree, n ≥ 5 times each in ABBA order (base,
candidate, then candidate, base), with `PERF_RUN_DIR` and `PERF_ITERATION` set,
and compares the pairs. It stops at the first failed invocation. `--sabotage
<name>` replaces `--candidate` with a scratch worktree of the base (its commit
plus staged, unstaged and untracked changes) carrying one deliberate
regression. Keep `--out` outside both trees or in an ignored directory such as
`.scratch/`: anything else changes a tree's build identity. `PERF_CPU` sets the
CPU throttle (default 4×) for measured windows. Raw frames (`frames.json`) are
written for every iteration the harness or scenario fails, and for all with
`PERF_FRAMES=1`; failures in the fixture's own teardown leave `evidence.json`.

## Tiers

Each scenario declares its numbers. **Targets** are continuous and the only
numbers to climb. **Defects** should be zero; they are judged per iteration and
become deterministic regression tests once fixed. **Guards** may not regress.
**Work** counters are printed beside them and never judged. All are lower-is-better.

| Scenario (test) | Targets | Defects | Guards | Work |
|---|---|---|---|---|
| `channel-open/sequence` (reads answer after 80ms) | `cold.firstRowsMs`, `prepared.firstRowsMs` | | `completeMs`, `scriptMs`, `settleMs` per case | head reads |
| `search-jump/sequence` (80ms) | `inline-cold.focusedMs`, `reply-cold.focusedMs` | `inline-cold.displacementPx` | `scriptMs`, `settleMs` per case | `inline-warm`/`deep-cold` `focusedMs`, `paletteGoneMs`, `deep-cold.inThread` |
| `thread-open/long`, `/short` (80ms) | `latestReplyMs` (long only) | `main.overlapPx`, `main.screenBlankMs`* | `scriptMs`, `settleMs` | short `latestReplyMs`, `main.shiftPx`, `replies` |
| `scroll/unloaded` (older pages after 300ms) | `screenBlankMs`, `deadInputMs` | `afterStop.shiftPx`‡ | `scriptMs`, `settleMs`, `droppedFrames` | `hiddenMs`, `olderPages` |
| `scroll/unmeasured` (300ms) | | `hiddenMs`‡, `shiftPx`‡ | `scriptMs`, `settleMs`, `droppedFrames` | |
| `scroll/reading` (older pages after 2s) | | `shiftPx`†, `idle.shiftPx`* | `scriptMs`, `settleMs`, `droppedFrames` | |
| `scroll/restored` (0ms) | `screenBlankMs` | | `scriptMs`, `settleMs`, `droppedFrames` | |
| `scroll/stale` (0ms) | | `extraCorrections`, `control.afterStopRows`, `narrowed.shiftPx`*, `narrowed.overlapPx`* | `scriptMs`, `settleMs` per fling | |

\* Zero today, kept because a sabotaged build makes it fire (see
[Sabotage](#sabotage)). ‡ Intermittent today: zero in most iterations, and
sabotage makes it fire in every one. † About 1px today. Run the zero and
intermittent ones in the full suite before keeping a change rather than in
every attempt.

- **Opens.** `firstRowsMs`: from the in-page sidebar click to the first frame
  with a painted row in view. Cold means never opened or hovered; prepared means
  the pointer first rested on the sidebar row, which reads the head. `completeMs`:
  to the first frame whose in-view picture (ids, tops, hidden) equals the final one.
- **Search** (from Home, jumping to another channel). `focusedMs`: from the
  click on the result to the first frame with focus inside the target, on the
  surface where it ends up (inline or the Thread panel). Inline-cold and
  inline-warm are head messages above the bottom-pinned view, deep-cold is 90
  rows back, reply-cold is a reply in a 60-reply thread. `displacementPx`: the
  largest distance of the target's top from its final top after it is first
  placed (painted, mostly in view), counting remounts while hidden, so the
  fading palette hides nothing. `paletteGoneMs`: until the palette is removed.
- **Threads.** `latestReplyMs`: from the click on a summary to the first frame
  where the panel is out of its hidden phase, scrolled to within 2px of the
  bottom and showing the newest reply. `main.*`: the main timeline from the click
  until recording stops, as the dock narrows it.
- **Flings** (one CDP gesture from the newest row): unloaded is 30,000px at
  8,000px/s into history that loads as it goes; unmeasured is 12,000px at
  4,000px/s into loaded rows never mounted; reading is 8 steps of 1,200px at
  900px/s, each followed by a pause (until 400ms quiet, at most 8s) in which
  older pages land; restored reopens a fully measured channel from its geometry
  snapshot (Virtua's buffer stays off) and sums three 8,000px flings at 2,000,
  6,000 and 11,000px/s, in an order that alternates across iterations; stale
  flings a measured channel at 3,000px/s (control), narrows the window to
  1100px, and flings again over rows measured at the old width.
  `extraCorrections`: the narrowed fling's programmatic scroll writes minus the
  control's (can be negative). `control.afterStopRows`: rows mounted after the
  control fling stopped. `idle.shiftPx`: shift summed over the reading pauses.

## Failing closed

An iteration fails, after writing its evidence and frames, when a measured
window does not become quiet before its idle, settle or tail barrier times
out; the recording is truncated (20,000 frames); a mounted row has no message
id or the rows vanish while messages show (the selectors no longer fit); any
tiered value is not finite (an empty window is `null`, never zero); fonts are
not loaded; or a scenario's premise does not hold (for example: the cold open
read its head after the idle barrier, older pages landed, the geometry was
restored, the palette was open at the click, the target was focused on the
expected surface). Premises are `perf.require` checks and setup waits in the
scenario files. A comparison is invalid (exit 2) when an invocation or test
failed, was skipped or reported nothing; a report is missing; a scenario's
environment differs (harness hash, browser, CPU rate, viewport, DPR); one side
mixes builds; a metric is missing on a side; the pairs are unequal or fewer
than 5; the target was not measured or is not a target or defect; an argument
is unknown; or the candidate tree changes harness paths. The harness hash
covers every non-spec file git sees in `tests/browser` and `tests/fixtures`, so
each tree measures with identical harness code.

## How it measures

- **Sampling.** After every paint (rAF, then a user-blocking task, so reading
  geometry forces no layout) the recorder stores every mounted row of the
  timeline and thread panel in content coordinates, the scroll position, wheel
  input, relay reads, focus, and programmatic scroll writes through all four
  paths (Virtua corrects with `scrollBy`). All definitions are computed
  offline in `perf/metrics.mjs`.
- **Blank.** A frame counts as blank for its time on screen when more than
  24px of the list area is uncovered in the DOM. Otherwise it counts in
  proportion to compositor exposure: scroll travel, net of programmatic
  writes, beyond the previous frame's contiguous painted rows.
- **Hidden** is time with unmeasured rows (Virtua's hidden slots) in view;
  **dead input** is wheel input at the top edge while older history is loadable.
- **Shift** sums, per frame, the largest move of a painted row in view in both
  frames that the reader did not cause: net of programmatic writes during
  input, net of the whole scroll delta when idle. An idle swap of every row in
  view counts the rows that survived just outside it, else one viewport.
  **Overlap** is the largest overlap of DOM-adjacent painted rows in view.
- **Windows.** For flings, input spans the wheels, after-stop runs from the
  last wheel to the end, and stopped starts two frames after the last scroll
  movement corrections do not explain. Dropped frames are input frames over 25ms.
- **Settle.** After the action the page waits for 500ms (and 10 frames)
  without change and with no read in flight, then a tail of at least 2.5s that
  ends after 1s without change. A change is new geometry, focus or palette
  state, a busy or loading surface, a mutation in a visible row, a scroll
  write, a read ending or a long task. `settleMs` is the last change seen in
  the tail, from the action or the last wheel.

## Comparing builds

Iterations are paired by order (ABBA pairs from `perf:ab`). A target or guard
moves when the exact one-sided signed-rank test on the paired differences
gives p ≤ 0.05 and the median difference is at least the larger of 16.7ms (a
frame at 60Hz) and 5% of the base median, 2px, or 1 count. Equal pairs drop out
of the test, so with 5 pairs all 5 must differ in the same direction. A defect
shows k/n non-zero iterations (above 0.5px, or above 0) with the median and
maximum of those. Its rate moves when the one-sided Fisher exact test gives
p ≤ 0.05 (from none, at least 4 of 5 or 4 of 7 hits: intermittent defects
produce single hits on the same build). Its size moves as a target's does, or
when as many candidate iterations lie beyond the base's whole range by the
practical amount (so a constant defect that worsens in most iterations
counts): `introduced` (from none), `fixed` (to none), `worse`/`better` by rate
or size, `mixed` when they disagree, else `no verdict`. **Keep** (exit 0) needs
the target `improved` (or its defect `fixed`/`better`) and nothing else
regressed, introduced, worse or mixed; anything else reverts (exit 1),
including no verdict. Each attempt reruns its base: compare runs from one
campaign only. The report prints the median load average of each side.

Climb with a campaign of the target's own test (`-- -g <test>`). Every judged
row is tested at p ≤ 0.05, so the full suite (about 40 judged rows besides the
target) blocks a same-build comparison about 40% of the time, almost always on
one guard. Before keeping a change, run the full suite at 7 pairs; if it blocks
only on rows of other tests, rerun those tests as a fresh campaign and revert
only if a row blocks again.

## Sabotage

`perf:ab --sabotage <name>` measures a deliberate regression against its base.
Before a number is trusted after a harness change, its sabotage must still
move it:

| Sabotage | Edit | Must move |
|---|---|---|
| `noShift` | no prepend anchoring | unloaded `afterStop.shiftPx` and `deadInputMs`; reading `shiftPx`, `idle.shiftPx` (unmeasured fails its premise, so add `-- --grep-invert unmeasured`) |
| `buffer0` | no Virtua buffer | unloaded `screenBlankMs`; unmeasured `hiddenMs`, `shiftPx`; stale narrowed `shiftPx`, `overlapPx`; thread `main.screenBlankMs` |
| `buffer6000` | 6,000px buffer | stale `control.afterStopRows`, `extraCorrections`, `scriptMs`, `settleMs` (not restored, whose buffer stays off) |
| `slowRow` | 5ms per message row render | cold and prepared `firstRowsMs`, long `latestReplyMs`, `scriptMs` |

## Limits

Chromium only, headless, at 1440×950 and DPR 1. Timing is unusable on a loaded
machine: load above the core count starves the renderer, and barriers then fail
closed. The recorder adds script time to both sides equally. Blank on screen is
an estimate from DOM geometry and scroll travel, not pixels.
