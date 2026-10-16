# Default-agent onboarding: real Solo development slice

## Status and scope

This branch uses the real desktop app, Solo page/sidebar, registered Claude setup,
Agents service/native-held identity, private channel outbox and ordinary message
history. The earlier standalone simulated preview and its fixture entry are removed.
There is no fake provider connection, fabricated agent reply or hidden viewer-authored
seed event. The prepared welcome is visibly app-authored content before compute.

The first slice supports the native **Claude** agent type on its existing macOS/Linux
hosts, not other adapters. `AgentType.startConversation` is an optional capability.
Welcome also lists the other registered types as placeholders with disabled Connect
buttons and “Not available in this demo”; it does not check their readiness, open
setup or create agents through them. Existing ordinary chats with other types
remain unchanged. No host command, key namespace, protocol kind, application
startup or plugin foundation was modified.

## Try in this worktree

Run `BUZZ_DEV_VIEWER= bin/just desktop --port 1432 --no-watch`. The empty pin selects
native identity mode; no private keys belong in environment files. Other worktrees
can remain open, but one copy claims each local agent. A hosting conflict is a
visible error, not permission to bypass the claim. The Dock icon names the branch.

1. Select an existing community using the ordinary community UI. Provider setup
   cannot run a useful Welcome chat without a joined, connected community.
2. Open **Solo**. With no Solo chats/default, the normal new destination presents
   app-authored **Welcome**. A Welcome sidebar entry also opens the explicit
   `welcome` Solo route before a saved chat exists.
3. One provider card lists the registered choices. **Connect** or Claude's gear
   action opens its existing provider management dialog. Readiness, sign-in and
   provider defaults stay real; this flow uses those defaults rather than adding
   a model form to the card. Other demo providers remain disabled. **Continue** creates
   an actual agent named Welcome and an ordinary private Solo chat named Welcome,
   confirms placement/invitation, then selects that exact agent for this chat.
4. Buzz sends a private app-authored instruction into the agent's continuing Claude
   session. The prepared welcome stays above it; the new actual signed `send`
   asks: “Great, we’re connected! Before we get started, take a sec to give me a
   name and choose an avatar, and then I can show you around.” It appears in the
   ordinary `ChannelTimeline`, directly above customization, without repeating the
   prepared welcome or starting a tour. No viewer message is published for this trigger.
   A shared, disabled composer keeps the chat frame visible before provider
   connection and throughout customization. Its visible status names the next step;
   there are no recipient, attachment or formatting tools. Only **Looks good** with
   a nonempty name other than Welcome saves customization and mounts the ordinary
   functional composer. Saved drafts remain intact. Other Solo chats are unchanged.
   Existing signed welcome messages are not rewritten when this prompt changes.
5. Once that reply exists, the card suggests a generated name and catalog avatar.
   **Shuffle** replaces both; either can be edited independently. Choose **Looks good**.
   `Agents.save` performs the real identity edit. The composer/message identity
   becomes the chosen name; the sidebar/header remain the saved chat title,
   **Welcome**. A compact confirmation states what was saved.
6. **New chat** starts the ordinary Solo composer with that agent selected. An
   existing draft's explicit selection wins; explicit mentions and ordinary send
   admission remain unchanged. The default is a device-local view preference scoped
   to account/community, not global identity, ownership, online state or permission.

The development build offers **Solo → Restart welcome** in the selected relay,
including relays that have never used this new flow. The entry stays visible during
setup; once a welcome reply is confirmed or setup is complete, confirmation can
clear that local setup receipt and open the app-authored Welcome screen again.
Cancel keeps the current setup; a changed receipt blocks a stale confirmation.
Other relays, existing chats, agents, provider connection and the current default
are preserved. Nothing is created until **Continue**; that creates a new real
agent/chat. Saving the new customization replaces the local default. Before a
confirmed welcome, Restart stays disabled so creation/startup recovery cannot be
silently abandoned. This entry is not included in production builds.

Provider/customization cards are centered within the message-content column, not
left-aligned under its text gutter. The centering/restart feedback pass passes
TypeScript, targeted Biome and 10 sidebar cases, including Cancel/focus restoration,
confirmed customization reset and the in-progress creation guard. No screenshots
or live publications were made.

Name ideas come from the connected Claude provider using its effective model in
an unsaved, safe-mode process with no tools, MCP servers or workspace instructions.
A 30-second bounded request produces up to 12 ideas; the mounted card consumes the
batch before asking again. Existing local agent names and already-shown ideas are
excluded, without claiming globally unique names. Avatars are sampled from the full
installed catalog, excluding the current choice. Manual edits and navigation fence
late suggestions; errors leave the current draft editable with Shuffle available to
retry. Neither suggestion nor Shuffle saves an identity, posts a chat message or
changes the default. Only **Looks good** does that. Response-style presets, shortcut
actions, cross-device default sync, default management UI, app-wide first-run routing,
other provider adapters and the earlier Bestie role are not included.

## Ownership and safety

- `features/sessions/welcome.ts`: one scoped setup receipt, reuse of existing
  `workSessions` create/delivered/refresh/invite and `mePlacement` operations, exact
  agent key, observed-reply reconciliation, and device-local default preference.
- `bundled/sessions/SoloWelcome.tsx`: app welcome, registered provider controls,
  setup/recovery, customization and confirmation; mounted by `SessionsPage`.
  `MeSidebar` retains actual chat title semantics. `NewSessionComposer` seeds the
  default only when there is no explicit draft choice.
- `AgentsService.welcome`: verifies the selected live community, owned local agent,
  supported/ready provider, fresh roster/placement evidence and exact private Solo
  roster. Native-held keys still sign and publish through existing enforcement.
- `AgentRunners.startConversation`: existing queue/rate/claim/lifecycle owner,
  independent of synthetic RelayEvents. The startup handle allows one top-level
  kind-9 publication to the exact Welcome channel; it rejects thread/different-channel
  posts and late use. Startup claim uncertainty fails closed. Restricted JS handles
  are feature guards under the trusted renderer model, not a new host security sandbox.
- Claude delivers app input to the same `AgentSessions` channel key used by later
  Solo messages, with top-level tool context. Cancellation before process startup
  prevents input submission. A native publication already entered cannot be revoked;
  navigation can leave an unknown attempted outcome, and the UI warns a reply may
  still arrive. Reopening never automatically repeats an attempted introduction.

A durable marker is written before agent/channel creation and kickoff. Interrupted
native creation without a returned key stops for explicit exact-key recovery; it
never merges namesakes or auto-creates another agent. Channel and invitation receipt
IDs are reused. If command submission occurred but saving its ID failed, setup stops
rather than blindly creating another channel. Receipt storage is not a cross-window
transaction; simultaneous first-run setup in multiple windows remains an acceptance
gap, not an exactly-once claim. Explicit kickoff retry strongly reads a bounded
20-event ordinary query by exact agent/channel and post-attempt time, then checks
for top-level replies locally. It does not use NIP-CW: that timeline extension
requires paired cursors and does not apply author/since filtering. A saturated page
without an introduction blocks another turn rather than inferring absence. The
read survives live timeline establishment but retains normal caller/access fences.
Native transport coverage reproduces the rejected half-cursor request before the
fix. Network races after publication and deliberate repeated retries are not a
relay transaction.

## UI owners and evidence

Shared owners reused: `PanelFrame`, `SessionHeading` / `PanelHeaderLabel`,
`ChannelTimeline`, `MessageComposer`, selected-assistant control, `ProviderDialog`,
`SettingsGroup`, `Field`, `Input`, `Select`, `Avatar`, `SurfaceButton`, `Popover`,
`Button` and existing icons/catalog artwork. No shared control repainting.
Applicable design guide sections: screen/whole-surface composition, plugin boundaries,
forms, anchored pickers, feedback/error states, identity shapes, keyboard focus and
responsive composition. Customization is app-owned content, not a fabricated message
or replacement timeline. The composition follows the recovered Figma references:
`WelcomeIntro` is app-authored content using the actual MessageRow container,
byline and received-bubble styles, with no synthetic event/timestamp/action bar.
A robot placeholder is named Welcome; the large Welcome to Buzz heading sits above
the prepared message, with one prominent centered provider card beneath its body. After creation it shows a compact current
provider summary through `ChannelTimeline.beforeMessages`; the shared timeline
measures this leading content with its existing ResizeObserver/startMargin.
`ChannelTimeline.afterMessages` places the portrait-centric customization card
immediately beneath the real welcome in the same scrollport. Its large squircle
avatar and centered editable title use the existing Avatar and title-Input recipes;
Shuffle/Looks good keep their actual behavior. Saving replaces that card with a
compact saved identity/default summary, still in the scrollport. No bottom-pinned
setup, second scrollport, made-up feature carousel or response-style preset is
added. The ordinary composer appears only after setup completes. Chat title remains
Welcome. Other chat layout remains unchanged.

The next polish pass replaces transparent SettingsGroup frames with one
feature-owned recessed step surface (`surface-inset`, `border-standard`,
`radius-container`) for both provider selection and customization. Titles sit
inside that boundary; customization's actions share a separated footer. Completed
provider evidence becomes an unboxed inline status and the saved identity uses a
quiet divider, avoiding multiple nested cards. Shared controls/focus/popup behavior
and all setup/save paths remain unchanged. This follows the design guide's inline
surface/depth and form composition guidance, not a new shared Card API or floating
overlay. Typecheck, targeted Biome and 20 mounted Welcome/page checks pass for this
polish; rendered dark/light, narrow and enlarged-text acceptance remains with the
human feedback round. No new screenshots or live messages were produced.

The 2026-10-15 composition feedback round passes typecheck, targeted Biome and 116
focused mounted Welcome/page plus timeline checks. No new screenshots or live
messages were taken/sent; human visual acceptance, narrow/theme/enlarged-text and
native-scroll verification remain deferred for the feedback round.

Focused checks run during implementation:

- TypeScript and targeted Biome; design guards and mechanical detector.
- Agents/service safety tests: actual runner claim, no event-shaped startup input,
  exact-chat/single-publication restriction, late handle rejection, foreign/shared/
  non-Solo refusal, claim failure/another host, community replacement and an already
  dispatched publication's outcome.
- Claude runtime/session tests: private input without a fake buzz-event, same saved
  conversation for real follow-up, and cancelled opening sends no input.
- Setup receipt tests: invite failure/restart reuses exact ids, uncertain native
  creation and storage failure do not create again, created key retained after view
  cancellation, scoped defaults, and post-attempt top-level reply matching.
- Mounted real React controls: StrictMode/reopen avoids automatic repeat, real save
  precedes default confirmation, failed save keeps draft, and retry recognizes an
  introduction even with a newer threaded reply. Ordinary new-Solo tests cover the
  default and explicit-choice precedence, including consecutive new chats.
- Live native macOS: existing community/profile restored, managed Claude installer
  completed, actual Welcome agent/private Solo chat created, genuine introduction
  received without viewer seed, real name/avatar saved as **Juniper**, new Solo draft
  selected Juniper, and an ordinary owner-authored follow-up received a real reply.
  A development HMR reload interrupted the first read; explicit retry recovered on
  the same chat/agent. Full GUI relaunch is a separate acceptance check.

The human has tried the native flow during interactive design feedback; that is
not complete acceptance of the final snapshot. Full scan, packaged/cross-platform
acceptance, simultaneous-window setup, startup routing after account/community/profile
creation, other provider adapters and hosted behavior remain deferred. Local passing
checks and one real native path are not a claim that onboarding is ready to ship.
The branch is a work-in-progress snapshot for team feedback, not an integration-ready
release. It retains its original base; newer mainline changes are not integrated.
