# Local browser performance runs

Run one checkout with a few parameters:

```sh
source bin/activate-hermit
bin/pnpm test:browser:install # once per pinned browser version
bin/pnpm perf --scenario channel-open --repeat 5 --cpu 4 --out results.json
```

`--scenario all` is the default. `--cpu` sets Chromium's CPU slowdown factor
(1 means unthrottled); it does not throttle network or the fixture server.
`--repeat` defaults to 5. Every sample gets fresh browser storage, signed
histories and server state; a production frontend build is shared by the worker.
One worker runs serially with no retries. These opt-in cases are separate from
the normal browser correctness gate and do not add CI journeys.

The existing browser fixture owns the production React/services/IndexedDB/Virtua
app and modeled local HTTP broker. The runner owns settings and measurement
windows; scenarios own setup, actions and proof that the intended work occurred.
There is no comparison engine, second checkout or prescribed optimization target.

## Measurements

Each sample reports Chromium `Performance.getMetrics` deltas, in milliseconds,
from immediately before the action until the timeline has visible rows and
unchanged visible geometry for at least 200ms across at least three samples:

| Metric | Meaning |
| --- | --- |
| `scriptMs` | `ScriptDuration`: JavaScript execution |
| `layoutMs` | `LayoutDuration`: layout work |
| `styleMs` | `RecalcStyleDuration`: style recalculation |
| `taskMs` | `TaskDuration`: main-thread task time |
| `durationMs` | Browser wall time through the settling barrier |
| `firstRowsMs` | Captured browser click event to visible target rows across two rendering updates |

The first-rows endpoint gives the browser a paint opportunity; it is not a
compositor screenshot or proof that every pixel finished painting. The settle
barrier observes row IDs/positions/heights and scroll geometry, not arbitrary
future async work. A ten-second deadline fails the sample instead of reporting
an unfinished operation as a win. Counter windows also include measurement
overhead and protocol dispatch around the action. Measured actions use browser
input: JavaScript invoked directly through the automation protocol can be absent
from `ScriptDuration`, even when included in `TaskDuration`. Categories overlap: do not
sum them or interpret them as CPU percentages. No forced GC is performed.

`channel-open` measures two independent cases with fresh state:

- `channel-open-cold` clicks a never-opened, never-hovered channel and requires a
  head read during opening.
- `channel-open-hover` gives the same unopened channel a 150ms hover head start,
  then clicks whether preparation is finished or still running. CPU throttling
  applies during hover too. There is no response-completion or idle wait.

Both cases measure click-to-first-rows and browser work during opening plus
settling. Work completed before the click earns the hover case a head start;
remaining preparation can contribute to the measured work. Hover work is outside
these metric windows. `work.hoverMs` records the requested lead and raw
`recording.hoverLeadMs` records the actual browser hover-to-click interval, which
can exceed 150ms due to browser scheduling and protocol dispatch. Head-read counts
before and during opening are diagnostic evidence; hover does not require zero
new reads. Each target has 120 mixed-height text messages; the existing app chooses
how many it initially loads. The corpus content and timestamps are fixed; signing
identities are ephemeral.

The hover case replaces `channel-open-prepared`, which waited for a completed head
response and an idle opportunity. Those older results are a different workload;
collect a new baseline rather than comparing them as equivalent.

## Scrolling

```sh
bin/pnpm perf --scenario scroll-short --repeat 5 --cpu 4
bin/pnpm perf --scenario scroll-long --repeat 5 --cpu 4
```

Both scenarios use the same observer, counters, fresh contexts and result format:

| Scenario | Workload |
| --- | --- |
| `scroll-short` | 800px upward at 1600px/s within the loaded head of a 120-message channel |
| `scroll-long` | 12,000px upward at 4000px/s across a 360-message channel, fully loaded before measuring |

The long case loads older pages without traversing them first, so the gesture
encounters rows the virtualizer has not yet mounted/measured. Setup waits for
page processing to finish, rejects the history-limit notice, then settles geometry.
Neither window permits older-page reads. This isolates rendering from pagination;
network-bound scrolling should be a separate future scenario.

Real Chromium wheel gestures must produce wheel events, scroll-offset movement
of at least 80% of the request, multiple visible messages and changed visible IDs.
Raw frames and work receipts record the requested distance/speed, history size,
released pages, wheel count and observed rows. `scrollTopRangePx` is the observed
offset range, including virtualizer corrections; it is not physical input distance.

`rafMaxGapMs`, `rafP95GapMs` and `rafGapsOver50` describe animation-frame callback
cadence during the gesture. Raw `gestureStartMs` and `gestureEndMs` timestamps
are relative to the recording start: the first observed wheel event and the
browser marker after Chromium reports the synthetic gesture complete. The end
includes that marker's protocol dispatch. Gaps are clipped to those boundaries,
including partial gaps before the first and after the last callback inside the
window. All callbacks count, including stalls when the scroll offset is unchanged.
The settling tail after the end marker is excluded from cadence only:
`scriptMs`, `layoutMs`, `styleMs`, `taskMs` and `durationMs` still cover scrolling
plus settling, with the same measurement overhead.

Recordings without these gesture timestamps used whole-operation cadence,
including the settling tail. Their cadence values are not comparable with the
new definition; rerun baselines before comparing. No summary metrics were added.
Callback gaps expose main-thread stalls, not compositor FPS or a measured
dropped-frame count. No generic blank-time, overlap or visual-shift verdict is
inferred from them.

## Results and iteration

JSON contains raw per-frame geometry, work evidence, all samples and per-metric
median/min/max/sample count. Only wholly passing samples enter summaries. Inspect
the top-level status and each run's errors before using a number; a failed command
is never a successful optimization. Runtime/source identity, dirty status, CPU
setting, viewport, host load and setup timing accompany the samples. A dirty
listing is not a content hash: tie claims to a clean commit.

Every invocation creates a fresh ignored `test-results/perf/run-*` evidence
directory. Existing fixture evidence and failure screenshots are retained there;
the summary defaults to that directory or writes the exact `--out` path. Reusing
an explicit output path replaces that summary. Traces/video are off to reduce
measurement overhead; use the existing functional browser runner for diagnostics.

Choose any relevant metric (including scripting) as the objective, keep the
scenario and settings fixed, and inspect all other metrics plus actual work.
Keep baseline JSON, make one change, rerun, and confirm promising changes with
repeated samples and the existing correctness tests. Use an idle machine and
alternate baseline/candidate runs when making a performance claim. Comparing
different CPU settings, browsers, fixtures or concurrent host loads is not a
controlled comparison. The runner does not decide which tradeoffs are acceptable.

This is Chromium-local evidence with modeled immediate backend responses,
HTTP interception (which disables HTTP cache), preloaded fonts and text content.
It does not measure production network latency, media, native hosting, WebKit,
long-session memory growth or application startup. Add those as explicit workloads
when needed rather than changing the meaning of existing samples.
