# Right-pane explicit dismissal experiment

This branch compares explicit thread, Profile, GitHub and Members dismissal with ordinary navigation.
It is based directly on upstream main `22201d882ed51e75c3606fea1d87603dbc23a583`.
It does not include the dialog-history PR or the separate Settings section
change. It is an interaction experiment, not an adopted general pane policy.

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
does not recreate terminal sessions or change pane layout history. Bulk Close other
tabs / Close all tabs are not the comparison contract; use individual X controls.

Members is the one dialog exception under test: opening it adds a visit. Back
closes it while staying on the channel; Forward restores it. X, Escape and
outside dismissal retire that visit, so the next Back leaves the channel and
Forward keeps Members closed. A link handoff replaces the Members visit with
its destination when the channel opener is known; cold handoffs retain a channel
visit beneath the new destination. Settings retains main's existing policy.

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
