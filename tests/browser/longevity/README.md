`repeat-navigation` is campaign scenario slot 1. It is separate from the frozen
13 main / 10 editor cases; their source, settings, recorder and reporter are unchanged.

Run with pinned tools:

```sh
bin/node tests/browser/longevity/run.mjs --repeat 1 --cpu 4 --out /absolute/path/results.json
```

One sample retains one real production app/session with two 40-message channels,
Markdown content and two existing Alpha threads with six added signed replies each,
plus the fixture's existing broadcast reply. Exact expected row identities come
from those signed fixture inputs, including the broadcast.
After warming every channel/thread and initializing fixed drafts, 100 cycles each
select Alpha, open/edit/actually close both thread tabs, select/edit Beta,
then return Alpha. Each draft edit inserts and removes one character.
The edit establishes a document-end caret through a trusted key command and
observes that selection before inserting; thread finite reads settle before editing.
No messages are sent and content/draft sizes do not grow. Pane hide is not tab close.

At checkpoints 0, 25 and 100, conditioning revisits Beta then Alpha, waits for
current wire EOSE/finite query completion and settled geometry, and establishes
pointer modality. The frozen recorder measures the same trusted Alpha→Beta click.
Every checkpoint must have zero head reads during the action, identical mounted
Beta row IDs, preserved Beta draft and no open thread tabs or message publications.
This prevents comparing cold versus warm opens or expired-head revalidation.

CPU slowdown applies during aging too. The frozen recorder resets CPU1 when it
returns; this scenario immediately reapplies the selected slowdown. Normal timers,
animations, signing, read-state writes and subscription renewal remain enabled.

One `perf-sample` attachment contains all checkpoints. Metrics are prefixed with
`cycle0_`, `cycle25_` and `cycle100_`; raw samples, resource observations, each cycle's
receipt and cumulative phase costs remain in `work`. CPU categories overlap and
must not be summed. Build/fixture signing, warm-up, conditioning and counted aging
costs are distinct. The whole-session 20-minute bound allows the fixed 700 pointer
actions and 300 reversible edits without relaxing individual action/settle limits.
Partial work is also retained in the fixture's `repeatNavigation` report as it
completes: attempted/completed cycles, current action/checkpoint, partial segment
counters and checkpoint/resource observations survive a later failure. Failed
runs remain excluded from the frozen reporter's successful summaries.

No forced GC occurs. CDP DOM/listener/heap counts include uncollected garbage and
cannot prove a retained leak. Active fixture sockets/wires are current state;
cumulative query/publication arrays are work evidence, not production retention.
Threads share the session live stream, so wire counts do not establish disposal of
internal JavaScript listeners. Any retention diagnosis needs separate evidence.

Browser-layer justification: actual tab mount/disposal, focus/editing, animated
panel geometry, real production session/broker and accumulated browser resources
cannot be proven by isolated lower-layer helpers. Existing perf cases reset the
session per action; the existing Settings leak regression covers a different owner
with post-GC correctness assertions. This scenario adds no production export/seam.
