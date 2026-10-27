# Right-pane explicit dismissal experiment

This branch compares explicit thread, Profile, GitHub and dialog dismissal with ordinary navigation.
It is based directly on upstream main `22201d882ed51e75c3606fea1d87603dbc23a583`.
It does not include the dialog-history PR or the separate Settings section
change. The [navigation history and dismissal contract](navigation-history.md)
records the default for dialogs and content tabs. This experiment's implemented
coverage includes Members, Settings and Agents-page provider dialogs.

Back/Forward keeps the existing behavior: it revisits content and restores the
selected thread while retaining open tabs. X (and the equivalent explicit tab
close controls) removes the thread and retires its addressed visits. Traversal
skips those dismissed visits; Close does not add another visit that Back undoes.
Unrelated channel/message visits remain. A cold thread closes to its own channel
in place. Explicitly opening the same thread later creates a fresh visit.

Profiles and GitHub use the same rule. Their read-only target and optional
thread context are carried as `detail` in the scoped conversation address;
Back/Forward restores selection and reload resolves the panel through the
existing registry. Opening another content tab retains the earlier tab.
Replacing the live community session clears its current panel address and
revokes old panel callbacks; it does not carry local editors across sessions.
An inactive X preserves the selected content while retiring the closed tab's
known visits. Other panel families keep their existing behavior. This experiment
does not recreate terminal sessions or change pane layout history. Close other
tabs and Close all tabs retire the complete set of closed content visits in one
navigation transaction, including inactive tabs. The kept tab stays selected;
underlying channel/message visits and other channel workspaces remain available.

Members follows the same rule: opening it adds a
visit. Back closes it while staying on the channel; Forward restores it. X, Escape and
outside dismissal retire that visit, so the next Back leaves the channel and
Forward keeps Members closed. A link handoff replaces the Members visit with
its destination when the channel opener is known; cold handoffs retain a channel
visit beneath the new destination.

Settings Close retires its known section visits for the same account/community
scope and returns to the covered workspace. Back/Forward between sections remains
reversible until Close. Profile discard confirmation still precedes dismissal.
Agents-page provider controls retire that provider's known visits on the same
scoped Agents page, preserving other providers and page visits. Their pending-work
close protection remains in the shared Dialog. Local nested provider controls in
Settings retain their existing lifecycle; this does not add new history visits
to every existing dialog.

## Try side by side

Run the baseline and this branch on different localhost ports. In each:

1. Visit channel A, then channel B. Open a thread T in B.
2. Back, then Forward: T should return in both versions.
3. Close T with X. Back, then Forward: in this branch the result should be A,
   then B with T closed. There should be no intermediate dismissed-thread stop.
4. Open two threads. Close the inactive one and traverse Back/Forward; it should
   stay closed. Close the selected thread; its surviving neighbour stays useful.
5. Explicitly reopen a dismissed thread; it should work normally.
6. Open Members in B. Back closes it on B; Forward reopens it. X then Back
   returns to A; Forward returns to B with Members closed. Repeat after reload.
7. Repeat the passive traversal and X sequence for Profiles and GitHub. Open
   two profiles and close the inactive one; history should skip it while the
   other stays selected. Follow a member row into Profile and check focus.
8. Open multiple threads and a Profile or GitHub tab. Close others from an
   inactive tab: only that tab remains selected, Back reaches the underlying
   channel and Forward restores the kept content. Close all, then Back/Forward:
   the closed content must not return or leave redundant history stops.
9. Open Settings, change sections, Back/Forward, then X. Back/Forward must skip
   all known sections of the dismissed Settings presentation. Keep editing in
   its discard prompt must leave both the draft and history intact.
10. Open an Agents-page provider link. Back closes its dialog on Agents; Forward
    restores it. X then Back reaches the page before Agents without a duplicate
    Agents stop. A cold provider link closes to Agents in place.

App arrows, supported history shortcuts and mouse Back/Forward use the same
navigation driver. Browsers retain their physical history entries; this branch
skips retired entries rather than claiming to delete arbitrary native history.
The app's traversal affordances account for those skipped entries. Dismissal
indices are kept in sessionStorage for the browser chain; open tabs themselves
retain their existing community-session lifetime.

## Evidence boundaries

Colocated tests cover driver traversal, inactive dismissal, cold targets, verified
thread roots and navigation-attempt lifetime. The browser regression file proves
actual popstate/hashchange traversal, X and two-tab behavior in the production
components with the existing disposable relay fixture. It does not establish
native desktop acceptance or replace the human side-by-side feel test.
