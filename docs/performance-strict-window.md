# Strict-window opening measurement (campaign slot 2)

This one additional case, `thread-open-strict-window`, measures a normal pointer
opening of a substantial UUID thread through the production app, broker, signed
finite reader and ThreadPanel. It is a separate harness version from the existing
13 main cases and 10 editor cases. Their scenarios, content and endpoints remain
unchanged; `perf.config.mjs` excludes this opt-in file from the original `all`.
Do not pool old and new harness measurements.

```sh
bin/node tests/browser/perf/strict-window-run.mjs --browser chromium --cpu 4 --repeat 5 --out strict.json
bin/node tests/browser/perf/strict-window-run.mjs --browser webkit --cpu 1 --repeat 5 --out strict-webkit.json
```

The fixed corpus has 303 direct, signed replies from twelve ephemeral participants
in one UUID channel, plus its root and forty ordinary channel-context rows. Content
and timestamps are fixed; signing identities and IDs are fresh per sample. The
newest ten contain prose, formatting, checklist/table, code, quote, links, two image
previews and two video previews. Local repository media is served by the same
fixture route as the existing rich-thread case. There are no edit/reaction/delete
overlays in this corpus: the fixture strict answer currently does not model their
auxiliary closure. The request still uses normal `include_aux:true`.

The app's actual strict policy opens ten traversal rows, not the entire backing
thread. Older demand uses fifty-row windows. This workload preserves that policy;
it never forces eager loading, changes mounted work or treats hidden history as
required initial work. The expected opening is **eleven mounted message IDs**:
root followed by the newest ten replies in chronological order. The backing
corpus is not a claim that 304 rows are rendered at opening.

Setup opens the channel through the real app, observes its root, delivers a signed
relay-owned summary and fills an ordinary channel draft. It never hovers/opens the
thread or requests its history. Replies remain in the modeled upstream thread
store; ordinary UUID unread queries include them. The existing `firstSeenHistory`
option supplies 500 newer busy-channel messages that fill the normal newest500
unread read. No history/cache/session snapshot is injected into the client.
Setup preloads the app fonts and settles channel geometry. Ordinary background
startup work remains enabled; visible content is not treated as proof that every
optional startup operation has finished.

Timing starts at the existing browser recorder's start immediately before the
trusted pointer click on the root's View thread button. `firstRowsMs` observes
that captured click to two successive rendering updates with visible **thread**
rows; it does not observe the already-visible channel rows. The recorder is reused
from `perf/runner.mjs` with the thread selector and expected eleven IDs.

The operation ends only after all eleven expected IDs mount, initial positioning
finishes, the newest reply is visible, the reply editor is editable, both image
links exist, the two expected original images are present, visible images have decoded dimensions, both videos have loaded data
and dimensions, real panel/grid animations finish, the channel's Virtua hold and
geometry settle, its original reading anchor is preserved, and thread geometry
settles. The recorder then requires its unchanged 200ms/three-frame quiet barrier.
The channel draft, exact row ordering, absent error and request receipts are
validated before a sample can pass. No fixed sleep, shortened readiness, disabled
motion, skipped signature/bounds check or post-endpoint required work is allowed.

Image completion is attachment-specific: replies 299 and 302 must each contain
their exact expected source link and one original native-lazy img with matching
src/currentSrc. Reply 302 must always have a nonzero pixel rectangle intersecting
both the thread scrollport and browser viewport in two dimensions, plus the
renderer’s data-image-ready state, loaded natural dimensions and revealed pixels.
Reply 299 requires that readiness only when its link intersects the viewport;
legitimate offscreen lazy images are never forced to load or decode. The two
witnesses are rechecked after geometry settles and retained in sample.work.
This repaired endpoint is a new harness version: never pool its timing with
8971b31, whose generic every(img) check could pass with missing newest pixels.

Receipts retain all setup/operation response filters and event IDs, full signed
39007 bounds, pre-served reply IDs, final mounted IDs, channel anchor, CPU/browser
state and raw geometry/LoAF frames. Opening must have zero pre-served reply IDs,
zero prior traversal requests, exactly one strict window with limit10 and no
cursor, ten expected reply IDs plus one signed bound, has_more true and the exact
continuation, no legacy thread_cursor, and exactly those ten replies served.
Root verification remains separate and all actual root/aux queries are recorded.
Any missing work, wrong cursor, unwanted eager page, error, bad geometry/readiness,
unexpected transport or console/page failure fails the sample, rather than
contributing an incomplete timing.

After the timing window, the same sample performs one **untimed correctness
control**: real upward wheel demand, held production-broker continuation, exact
signed-window cursor/limit50, release and all61 unique ordered IDs (root+60replies),
with the channel draft retained. This proves the opener left authentic history
available. Its costs are not opening metrics. Protocol/recovery permutations stay
in existing `thread-window.spec.mjs` and colocated relay owner suites.

Chromium reports the existing script/layout/style/task/wall/LoAF and click-to-rows
metrics at the requested CPU slowdown. WebKit supports only CPU1 here and reports
wall/click-to-rows/geometry. Chromium CDP counters and LoAF are explicitly listed
as unsupported in WebKit, never substituted with zero. These are Linux browser
fixture measurements, not native, real-network, cross-platform or human acceptance.
