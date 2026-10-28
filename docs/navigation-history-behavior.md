# Navigation history behavior

Dialogs and content tabs follow the [navigation history and dismissal contract](navigation-history.md).
The integrated families are Members, Settings sections, provider controls opened
within Settings or through Agents-page links, and thread, Profile and GitHub tabs.

Back/Forward revisits content and restores the selected thread while retaining
open tabs. X (and the equivalent explicit tab
close controls) removes the thread and retires its addressed visits. Traversal
skips those dismissed visits; Close does not add another visit that Back undoes.
Unrelated channel/message visits remain. A cold thread closes to its own channel
in place. Explicitly opening the same thread later creates a fresh visit.

Profiles and GitHub use the same rule. Their read-only target and optional
thread context are carried as `detail` in the scoped conversation address;
Back/Forward restores selection and reload resolves the panel through the
existing registry. Opening another content tab retains the earlier tab.
Replacing the live session within the same account/community reconstructs the
read-only address, including after deliberate same-community resets. Old panel
callbacks are revoked; local editors do not carry across sessions. A different
account/community scope clears the current detail address once known; a
temporarily unknown reconnect scope does not.
An inactive X preserves the selected content while retiring the closed tab's
known visits. Other panel families keep their existing behavior. Navigation
does not recreate terminal sessions or change pane layout history. Close other
tabs and Close all tabs retire the complete set of closed content visits in one
navigation transaction, including inactive tabs. The kept tab stays selected;
underlying channel/message visits and other channel workspaces remain available.

Members follows the same rule: opening it adds a visit. Back closes it while
staying on the channel; Forward restores it. X, Escape and outside dismissal
retire that visit, so the next Back leaves the channel and
Forward keeps Members closed. A link handoff replaces the Members visit with
its destination when the channel opener is known; cold handoffs retain a channel
visit beneath the new destination.

Settings Close retires its known section visits for the same account/community
scope and returns to the covered workspace. Back/Forward between sections remains
reversible until Close. Profile discard confirmation still precedes dismissal.
Agents-page provider controls retire that provider's known visits on the same
scoped Agents page, preserving other providers and page visits. Their pending-work
close protection remains in the shared Dialog. Settings → Agent setup provider
controls get a nested Settings visit: Back closes the provider while leaving
Settings open, Forward restores it, and provider Close retires only its nested
visits. Closing Settings retires its sections and nested provider visits together.
Restoration opens controls, never an install, sign-in or save operation. This does
not add new history visits to every existing confirmation or editor.

## History and lifetime boundaries

App arrows, supported history shortcuts and mouse Back/Forward use the same
navigation driver. Browsers retain their physical history entries; the driver
skips retired entries rather than claiming to delete arbitrary native history.
The app's traversal affordances account for those skipped entries. Dismissal
indices and known visit targets are kept in sessionStorage for the browser chain.
Same-window refresh restores addressable conversation, thread, panel and Channel
settings tabs with their order, panes and selection. Explicit Close can retire
associated visits made before the refresh; Back/Forward then skips that content.
Current registrations and channel eligibility still govern restored content.
Background content waits for selection; missing providers stay closeable and
unreviewed recovery requires Resume.

Recovery is best-effort when storage is unavailable or full. Quit/relaunch,
cross-device sync, feature-local inspection sub-tabs, drawer visibility and edit
dialogs are not guaranteed by this layer. Another window keeps its own session
storage copy; leaving a community revokes its live tab writer and clears this
window's partition. No retention
policy currently prunes saved workspace visit associations or the driver's known
visit map, and each update serializes its full store. A failed workspace save
removes the older snapshot when storage permits, preventing stale tabs from
returning; live navigation remains usable. If storage also refuses removal,
recovery remains best effort.

## Evidence boundaries

Colocated tests cover driver traversal, inactive dismissal, cold targets, verified
thread roots and navigation-attempt lifetime. The browser regression file proves
actual popstate/hashchange traversal, X and two-tab behavior in the production
components with the existing disposable relay fixture. It does not establish
native desktop acceptance. Manual comparison and acceptance steps are recorded
in the pull request description.
