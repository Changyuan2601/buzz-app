# Session sharing validation

Current behavior and limits live in [Sharing a live session](sharing.md).
These are snapshot-specific results, not cumulative coverage or shipping acceptance.
PR [#1070](https://github.com/block/buzz-app/pull/1070) is independent of lifetime/settings
[#1079](https://github.com/block/buzz-app/pull/1079).

## Current contract and evidence

Share preserves Me placement and session behavior. Explicit Private/Public conversion
confirms metadata, removes only the initiating viewer's placement/assignment, then
opens the same ID in Messages. This supersedes earlier retained-Me conversion.

| Checked snapshot | Local checks | Timing |
| --- | --- | --- |
| `fab1f5599` conversion change | 299 Vitest tests / 13 complete owner files | 15.83s wall; 37.05s summed; slowest file SessionShare 13.89s |
| `ba62c1553` main integration plus test repair | Page/sidebar files: 13 passed; final page file: 11 passed | 3.19s and 3.41s wall, respectively |
| `931271405` | Complete Me/share browser files: 18 Chromium/WebKit cases | 32.8s wall; 55.2s summed; slowest 5.4s; two workers, no retries |
| `931271405` push hooks | Types/related tests, design guards, organization policy | 75.76s client; 4.28s design; no PR-relative Rust inputs |

The main-integration owner run initially passed 584/585 tests. Main had moved
**Retry Me** to MeSidebar; mounting that real owner repaired the fixture without
restoring duplicate product UI. Merge review found no remaining integration blocker.

Hosted CI at `931271405` found the same `me-workspace` personal-recipient failure
in both engines: Beta was an ordinary stream while the test expected personal
session controls. Chromium shard 2: 86 passed/1 failed, 386.34s wall and 666.21s
summed test time; slowest test navigation mute/read 33.57s, file layout 84.25s.
WebKit shard 2: 78 passed/1 failed, about 7m. Other executed checks, including DCO,
passed; Windows validation was skipped. This was not classified as a flake.

### CI fixture repair and cleanup

On `09550a264` plus this cleanup, all 30 cases in the complete `me-workspace`,
`me-polish` and `session-sharing` files passed in Chromium/WebKit: 50.68s wall,
82.24s summed execution, slowest case 5.29s (WebKit Share reachability/recovery).
Two workers, no retries. The fixture now inherits both actual session IDs; its
Messages link is scoped to Beta's secondary tab and session composer. The first
repair run exposed that previously masked ambiguous-selector failure in both
engines; explicit tab scoping fixed it without changing any recipient assertion.
No browser case was added/removed. Seven unused direct-promotion type/import lines
were removed; redundant historical prose was condensed, not production recovery.
Main `f44102078` merged cleanly. A later clean merge of `cfc512868` restored
Retry Me in the retained page; removing our now-redundant sidebar fixture wrapper
fixed the resulting duplicate-button assertion. All 15 page/sidebar/share-attempt
tests then passed (3.22s wall; 1.36s summed). Loading/transient, rejection and recovery
assertions remain. The full 30 browser cases passed again after this integration:
51.27s wall, 82.43s summed, slowest 5.28s. Both bounded cleanup reviews found no
blocker. Hosted CI at `0b0e47bcb` confirmed the personal-recipient repair, but
failed three WebKit cases: held Share readback, an inactive IndexedDB transaction,
and thread-history two-tab setup.

At `0d9fc1998`, six added clock-control lines keep six pending-layout screenshots
from consuming the intentionally held read's unchanged 10s production deadline.
All assertions remain; no browser cases were added/removed. The focused case
passed in both engines; both complete share files passed twice (36 cases, 1.1m).
`e3a795c09` then merged main `0179c8b89`, including its exact late-IndexedDB-callback
fix (#1062) and Virtua update. All four complete affected browser files passed:
52 Chromium/WebKit cases, 1.3m wall, approximately 140.3s summed execution;
slowest case 5.3s, slowest file thread-history 58.6s (rounded list-reporter times).
Two workers, no retries, local Apple Silicon. The thread-tab failure did not
reproduce; its cause is unconfirmed, not claimed fixed by the upstream update.
Current-head hosted CI remains the next gate.

### Retry-focus review follow-up

On `efa065b52` plus the review repairs, the existing failed-share journey now
closes and reopens before retrying: initial focus must enter the dialog and Tab
must remain inside. That assertion failed before repair in both engines. A mounted
Messages-handoff regression likewise failed with the stale `Dev` query before
resetting the unsubmitted draft. Disabled-input states now use the shared Dialog's
first-tabbable default; editable Share still focuses its combobox. The Tab traversal
waits off Base UI's focus guard without raising its 12-step bound.

All 93 tests in seven complete owner files passed (16.61s wall, 22.08s summed), as
did 18 cases in both complete sharing browser files: 91.44s wall, 168.92s summed,
slowest case 24.01s; two Linux browser workers under a two-CPU limit, macOS host,
no retries. No browser cases added/removed. Independent narrow review: 9/10, no
blocker. The non-wrapping footer remains the prior design choice pending a human
layout decision. New focus/draft behavior needs human confirmation; earlier
Share/Convert product confirmation remains recorded, not reused for this repair.

### Approved footer wrapping

On 2026-10-15 the author approved replacing the grouped scrolling footer with
shared Dialog wrapping. On `6c931815c` plus this change, removing the feature
wrapper, focus-scroll handler and eight CSS lines leaves each trailing action as
a shared footer item. Wide controls remain in one row; narrow Copy/Share actions
wrap. At 390px/200% text, Convert alone is wider than its row, so the existing
single-control scrolling fallback remains; no shared styling or label is changed.

The first whole-control geometry assertions failed in both affected journeys in
both engines before the change. Those assertions also exposed the documented
single-oversized-control exception after the wrapper was removed; the final tests
therefore bound overflow to the widest individual control and require separate
Copy/Share rows. They retain real Tab traversal, full Copy/Share viewport checks,
Convert endpoint reachability, pending-action stability and exact-link recovery.
The refined final assertions were not rerun against the old wrapper; independent
source review confirms its non-wrapping row cannot satisfy the separate-row check.

Both complete browser files passed all 22 Chromium/WebKit cases: 110.14s wall,
204.25s summed, slowest 26.11s (WebKit reachability), slowest file me-polish 119.48s
summed. Linux ARM64 browsers, two-CPU limit, macOS host, two workers, no retries.
All 34 tests in the complete Share and page-conversion owner files passed (17.04s
wall, 16.46s summed). No browser cases added or removed. Independent source review:
9/10, no blockers. Layout approval is not human testing of the resulting build;
focus/draft acceptance, exact-head CI and required review remain separate gates.

## Regression and test-layer accounting

- Real signed-details → Me preference → Outbox tests cover ordering, exact
  confirmation, preservation of other groups/labels/lifetime, lost acknowledgments
  without replay, concurrent forms and stale visits. Loading/error absence is not
  removal evidence. Metadata-confirmed removal retry never republishes kind 9002.
- Independent review found two recovery gaps: receipt loss after restart and an
  external details consumer confirming uncertain metadata. Explicit removal-only
  **Move to Messages** and fresh exact-draft reconciliation closed them. Follow-up
  review rated the slice 9/10 and independently passed all 30 conversion tests.
- Shared `meChat` tests and Claude/Codex runtime tests cover verified ordinary type
  overriding retained Me filing, while already-admitted turns keep frozen policy.
- Wes's repairs cover frozen **Submitted audience** disclosure, Messages conversion
  surviving type replacement, reactive pending-share guards and truthful local
  history warnings. The mounted audience/lifecycle regressions failed before repair.
- Browser checks caught replacement-composer autofocus stealing dialog return
  focus in both engines. The workspace-only fix preserves shared focus behavior.
  Pending-footer and label-neutral recovery regressions also failed before repair.
- Relative to main, this PR adds two browser cases per engine: same-ID Me conversion
  and Messages conversion lifecycle/focus. Native focus, navigation, portal hit
  testing and geometry justify this layer. Failure matrices stay in mounted/service
  tests. No browser cases were added or removed for the later conversion decision.
  The separate lifetime/settings case remains in #1079.
- Existing journeys retain frozen retries, history reload, link navigation,
  light/dark 390/950/1280px layouts, enlarged text and keyboard/pointer reachability.
  Screenshots were inspected. No retries, longer deadlines or weakened assertions
  were used to hide failures.

## Historical checkpoints

These do not validate later code. Detailed earlier reports remain in Git history.

| Snapshot/round | Focused result | Local timing |
| --- | --- | --- |
| `76f1499e0`, independent/footer/label recovery | 176 tests / 8 files; 16 browser cases | 14.81s / 22.47s Vitest wall/summed; 31.2s / 48.4s browser |
| `8f24a062d`, Wes repairs and main integration | 189 tests / 11 files; 18 browser cases | 17.11s / 26.64s Vitest; 32.6s browser wall |
| `c98fc1fce`, former combined stack | 509 client tests, 11 native guards, 161 design tests, 66 browser cases | 15.33s client wall; 2.5m browser wall |

The historical combined stack included lifetime/settings. Its native guard tests
were not packaged-GUI acceptance. Unstacking preserved sharing coverage and left
lifetime/settings in #1079. Earlier human feedback predates the current conversion
contract and does not certify it.

## Commands and remaining gates

Use pinned Hermit tools: `pnpm exec vitest run <owner files>` and
`pnpm test:browser <files> --no-deps --project=chromium --project=webkit`.
Normal commit/push hooks remain mandatory. No routine `just scan` was run.
Fixtures use synthetic identities; no configured-account grants were made.
Raw logs and screenshots remain outside Git.

At the user's request, the `931271405` desktop was compiled and launched on
2026-10-14, preserving port 13345 and the configured public identity. This is a
native window using the development broker, not packaged native acceptance.
The author confirmed Share stays in Me and Convert moves to Messages on
2026-10-14. Packaged native persistence/relaunch, live relay ACL/Public history,
cross-account discovery/no-wake and live-agent replies remain separate gates.
Current hosted checks and required human review must be verified at the latest
PR head; prior green checks do not transfer.
