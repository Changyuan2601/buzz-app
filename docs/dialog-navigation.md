# Dialog navigation and explicit dismissal

This is the product contract for new dialogs and changes to dialog navigation.
It applies to global and contextual dialogs alike. Existing dialogs still need
to be checked and migrated; using the shared `Dialog` does not automatically
connect a feature to navigation history.

## Passive navigation preserves; explicit close dismisses

Opening a dialog creates a visit above its underlying view. Back returns to the
preceding view, closing the dialog before leaving that view. Forward can restore
the dialog. Back/Forward changes what is visible without recording a dismissal.

X, Close, Cancel, and enabled Escape or backdrop dismissal explicitly end that
presentation. Retire its restoration visits without adding a new "dialog closed"
visit. Subsequent Back/Forward must skip the dismissed presentation, with no
unchanged-looking stop. Opening the dialog explicitly again creates a fresh visit.

For `channel A → channel B → Members`:

| Action | Visible result |
| --- | --- |
| Back while Members is open | Members closes; stay on B |
| Forward afterward | Members reopens on B |
| Back twice from Members | B without Members, then A |
| X while Members is open | Members closes; stay on B |
| Back after X | A, with no redundant B stop |
| Forward after that | B with Members closed |

Following a link or completing an action that exits a dialog also ends its
presentation. Members → profile/DM → Back returns to B without Members. A
nested confirmation dismisses only itself unless the action also exits its parent.
Changing a section or step inside a dialog is not dismissal of the whole dialog.

## Keep lifecycle and access guards

The distinction applies after the feature permits an exit. Preserve unsaved-draft
prompts, pending-operation protection, focus restoration, and nested Escape
handling for both navigation and close controls. Cancelling an exit keeps the
dialog and its restoration state intact. Never treat a component unmount during
Back/Forward as an explicit close.

Restore presentation and valid draft state, never replay a submission, destructive
action, completed confirmation, or one-time secret handoff. Completion retires the
finished presentation. Recheck the current account, community, permissions and
data before restoring it. If a flow cannot safely support restoration, make the
exception an explicit product decision and document its behavior and coverage;
do not silently give it different close semantics.

## One navigation owner

Use the existing [navigation controller](../src/features/navigation/controller.ts)
and [history driver](../src/features/navigation/history.ts). The navigation owner
distinguishes traversal from dismissal and retires the relevant visits. Browser
history entries may remain physically present; skipping them must produce the
same visible result through app controls and native browser history.

The shared [Dialog](../src/shared/design-system/ui/dialog.tsx) owns modal controls,
focus, Escape, backdrop handling and close guards. It must not independently own
app history or acquire feature-specific routing. Features supply the dialog's
identity, underlying destination and operation/draft lifecycle to that owner.

Content tabs use the same close intent. Individual close, Close other tabs and
Close all tabs retire the visits belonging to the closed tabs, preserving the
kept tab and meaningful underlying channel/message visits. Closing an inactive
tab must not change the selected content.

Reload reconstruction is separate from close intent: this contract does not
require saving an entire inactive tab strip or every historical layout. State
which reload behavior a feature supports and verify it before claiming that
older visits remain dismissible across reload.

## Prevent accidental regressions

When implementing or changing a dialog, cover passive Back/Forward, explicit
close followed by Back/Forward, reopening after dismissal, action handoffs, and
applicable draft/pending/access guards. Test nested dialogs and reload where the
flow supports them. Use owner-level tests for the policy and representative
built-app journeys for actual history events and focus behavior.

Changing this contract requires an explicit product decision, an update here,
and corresponding regression coverage in the same change. Do not alter the
policy as a side effect of visual work or a history refactor. The
[experiment coverage](right-pane-dismissal-experiment.md) describes the currently
implemented slice, not automatic conformance of every existing dialog.
