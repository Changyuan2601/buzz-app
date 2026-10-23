// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { SOLO_LABEL } from "../../features/solo/labels";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  metadata,
  profile,
  signed,
} from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import {
  beginSoloShare,
  finishSoloShare,
  soloShareAttempt,
} from "../../features/solo/share-attempt";
import { OutboxStatus } from "./OutboxStatus";
import { createRelayProfiler } from "../../features/relay/profiling";
import { viewRevision } from "../../shared/view-state";
import {
  readShareHistory,
  saveShareHistory,
  shareHistoryKey,
} from "../../features/solo/share-history";
import { ChatSharedMark, soloSharedMarkId } from "./ChatSharedMark";
import { ChannelMembersDialog } from "./ChannelMembersDialog";
import { useRef, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import { SoloWorkspaces } from "./SoloWorkspaces";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import {
  formatPublicKey,
  publicKeyLabels,
} from "../../shared/identity/public-key";

/** The Solo header entry point: the people icon opens the shared access dialog. */
function SoloShare({
  session,
  channel,
  signal,
  onClose,
}: {
  session: RelaySession;
  channel: { id: string };
  signal?: AbortSignal;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useSyncExternalStore(
    session.channels.subscribeList,
    session.channels.list,
  );
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Access
      </button>
      <ChatSharedMark
        session={session}
        channel={list.channels.find((item) => item.id === channel.id)}
      />
      {open && (
        <ChannelMembersDialog
          session={session}
          channelId={channel.id}
          signal={signal}
          trigger={trigger}
          close={() => {
            setOpen(false);
            onClose?.();
          }}
        />
      )}
    </>
  );
}

const source = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const owners: ReturnType<typeof createRelaySession>[] = [];
// jsdom lacks scrollIntoView; the search highlight keeps its row in view.
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
});
function fixture(direct = false) {
  const viewer = keypair(),
    relay = keypair(),
    aria = keypair(),
    dev = keypair();
  const profiles = [
    profile(aria, { name: "Aria" }),
    profile(dev, { name: "Dev" }),
  ];
  let clock = 1_700_000_000;
  const members = new Map([
    [source, [viewer.pubkey]],
    [destination, [viewer.pubkey]],
  ]);
  const metadataEvents = new Map([
    [
      source,
      metadata(relay, source, "Work", clock, [
        ["t", "stream"],
        ["t", SOLO_LABEL],
        ["private"],
        // The owner's own Solo chat, or one shared with them as a guest.
        ["P", direct ? viewer.pubkey : relay.pubkey],
      ]),
    ],
    [
      destination,
      metadata(relay, destination, "Planning", clock, [
        ["t", "stream"],
        ["private"],
      ]),
    ],
  ]);
  const published: RelayEvent[] = [];
  let failLink = false;
  let holdLink: Promise<void> | undefined;
  let failGrant: boolean | string = false;
  let failDetails = false;
  let failRoster = false;
  let holdRoster: Promise<void> | undefined;
  let loseDetailsResponse = false;
  const projects = (assignments: Record<string, string>) => ({
    status: "ready" as const,
    data: {
      sections: [{ id: "g", name: "Project", order: 0 }],
      assignments,
      starred: [],
      muted: [],
    },
  });
  const filedProjects = projects({ [source]: "g" });
  const unfiledProjects = projects({});
  let filed = direct;
  const placement = vi.fn(async (_id: string, _sectionId?: string) => {
    filed = false;
    return { sections: [], assignments: {}, starred: [], muted: [] };
  });
  let records: readonly import("../../features/relay/outbox").OutgoingEvent[] =
    [];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9) await holdLink;
    if (event.kind === 9 && failLink) throw new PublishRejected("Post refused");
    if (
      event.kind === 9000 &&
      (failGrant === true ||
        event.tags.some(([tag, key]) => tag === "p" && key === failGrant))
    )
      throw new PublishRejected("Chat invite refused");
    if (event.kind === 9002 && failDetails)
      throw new PublishRejected("Settings refused");
    published.push(event);
    if (event.kind === 9002) {
      const value = (tag: string) =>
        event.tags.find(([name]) => name === tag)?.[1];
      const previous = metadataEvents.get(source)?.tags ?? [];
      const ttl = value("ttl") ?? previous.find(([tag]) => tag === "ttl")?.[1];
      const visibility = value("visibility");
      const written = event.tags.flatMap(([tag, label]) =>
        tag === "t" ? [label ?? ""] : [],
      );
      const labels = written.length
        ? written.filter(Boolean)
        : previous.flatMap(([tag, label]) =>
            tag === "t" && label !== "stream" ? [label ?? ""] : [],
          );
      metadataEvents.set(
        source,
        metadata(relay, source, value("name") ?? "Work", ++clock, [
          ["t", "stream"],
          ...labels.map((label) => ["t", label]),
          ...previous.filter(([tag]) => tag === "P"),
          [
            visibility
              ? visibility === "open"
                ? "public"
                : "private"
              : previous.some(([tag]) => tag === "public")
                ? "public"
                : "private",
          ],
          [
            "about",
            value("about") ??
              previous.find(([tag]) => tag === "about")?.[1] ??
              "",
          ],
          ...(ttl && ttl !== "0" ? [["ttl", ttl]] : []),
        ]),
      );
      if (loseDetailsResponse) throw new Error("Lost settings response");
    }
    if (event.kind === 9000) {
      const id = event.tags.find(([name]) => name === "h")?.[1] ?? "";
      const key = event.tags.find(([name]) => name === "p")?.[1] ?? "";
      members.set(id, [...new Set([...(members.get(id) ?? []), key])]);
      clock++;
    }
    if (event.kind === 9001) {
      const id = event.tags.find(([name]) => name === "h")?.[1] ?? "";
      const key = event.tags.find(([name]) => name === "p")?.[1] ?? "";
      members.set(
        id,
        (members.get(id) ?? []).filter((member) => member !== key),
      );
      clock++;
    }
  });
  const detailsSign = vi.fn(
    async (event: import("nostr-tools").EventTemplate) => signed(viewer, event),
  );
  const owner = createRelaySession(
    {
      channelIdentity: true,
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://community.test",
      media: () => undefined,
      query: async (filters) => {
        if (
          filters.some(
            (filter) => filter.kinds?.length === 1 && filter.kinds[0] === 39002,
          )
        ) {
          await holdRoster;
          if (failRoster) throw new Error("Roster unavailable");
        }
        if (filters.some((filter) => filter.search))
          return profiles.filter((item) =>
            item.content
              .toLowerCase()
              .includes(filters[0]?.search?.toLowerCase() ?? ""),
          );
        const events = [
          ...metadataEvents.values(),
          ...[...members.keys()].map((id) =>
            signed(relay, {
              kind: 39001,
              created_at: clock,
              content: "",
              tags: [
                ["d", id],
                ["p", viewer.pubkey, "owner"],
              ],
            }),
          ),
          ...[...members].map(([id, keys]) =>
            signed(relay, {
              kind: 39002,
              created_at: clock,
              content: "",
              tags: [
                ["d", id],
                ...keys.map((key) => [
                  "p",
                  key,
                  "",
                  key === viewer.pubkey
                    ? "owner"
                    : profiles.some(
                          (event) =>
                            event.pubkey === key &&
                            JSON.parse(event.content).is_agent,
                        )
                      ? "bot"
                      : "member",
                ]),
              ],
            }),
          ),
          ...published,
          ...profiles,
        ];
        return events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      channelDetails: {
        sign: detailsSign,
        publish,
      },
      memberAdministration: {
        sign: async (event) => signed(viewer, event),
        publish,
      },
      writer: {
        kinds: [9, 9000, 9002],
        sign: async (event) => signed(viewer, event),
        publish: async (event) => {
          await publish(event);
        },
      },
    },
    {
      outboxStorage: {
        load: () => records,
        save: (next) => {
          records = structuredClone(next);
        },
      },
    },
  );
  owners.push(owner);
  const session = direct
    ? {
        ...owner.session,
        soloPreferences: {
          ...owner.session.soloPreferences,
          snapshot: () => (filed ? filedProjects : unfiledProjects),
          refresh: async () => {},
          assign: placement,
        },
      }
    : owner.session;
  const channel = () =>
    owner.session.channels.list().channels.find((item) => item.id === source);
  return {
    session,
    placement,
    failDetails(value: boolean) {
      failDetails = value;
    },
    loseDetailsResponse(value: boolean) {
      loseDetailsResponse = value;
    },
    failRoster(value: boolean) {
      failRoster = value;
    },
    holdRoster(value: Promise<void> | undefined) {
      holdRoster = value;
    },
    addProfile(key: ReturnType<typeof keypair>, name: string, agent = false) {
      profiles.push(
        profile(key, { name, ...(agent ? { is_agent: true } : {}) }),
      );
    },
    viewer,
    aria,
    dev,
    members,
    setArchived(archived: boolean) {
      metadataEvents.set(
        source,
        metadata(relay, source, "Work", ++clock, [
          ["t", "stream"],
          ["t", SOLO_LABEL],
          ["private"],
          ["P", direct ? viewer.pubkey : relay.pubkey],
          ["archived", String(archived)],
        ]),
      );
      session.channels.refreshList?.();
    },
    published,
    publish,
    detailsSign,
    channel,
    failLink(value: boolean) {
      failLink = value;
    },
    holdLink(value: Promise<void> | undefined) {
      holdLink = value;
    },
    failGrant(value: boolean | string) {
      failGrant = value;
    },
    setSourceMembers(keys: string[]) {
      members.set(source, keys);
      clock++;
    },
    setDestinationMembers(keys: string[]) {
      members.set(destination, keys);
      clock++;
    },
    addDestination(key: string) {
      members.set(destination, [
        ...new Set([...(members.get(destination) ?? []), key]),
      ]);
      clock++;
    },
    async ready() {
      owner.session.channels.ensureList();
      await waitFor(() => expect(channel()?.channelType).toBe("solo"));
    },
    mount(props: { signal?: AbortSignal; onClose?: () => void } = {}) {
      const initial = channel();
      if (!initial) throw new Error("Chat not loaded");
      return render(
        <SoloShare session={session} channel={initial} {...props} />,
        { wrapper: ToastProvider },
      );
    },
  };
}

const search = (dialog: HTMLElement) =>
  within(dialog).getByRole("searchbox", { name: "Search people and channels" });
async function chooseDestination(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  await user.clear(search(dialog));
  await user.type(search(dialog), "Plan");
  await user.click(
    await within(dialog).findByRole("button", { name: "Select #Planning" }),
  );
}
const waitForAccess = (dialog: HTMLElement) =>
  waitFor(() =>
    expect(
      within(dialog).queryByRole("status", { name: "Loading members" }),
    ).toBeNull(),
  );

it("adds a person at once under the chat's share rule, by Add or Enter", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await waitForAccess(dialog);
  await user.type(search(dialog), "Aria");
  const results = await within(dialog).findByRole("region", {
    name: "Not in this chat",
  });
  await within(results).findByRole("button", { name: /^Add Aria/ });
  expect(results).not.toHaveTextContent(formatPublicKey(t.aria.pubkey) ?? "");
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9000]),
  );
  expect(t.published[0]?.tags).toContainEqual(["p", t.aria.pubkey]);
  expect(await within(dialog).findByText("Aria is in the chat.")).toBeVisible();
  await user.clear(search(dialog));
  expect(
    await within(dialog).findByRole("region", { name: "People" }),
  ).toHaveTextContent("Aria");
  await user.type(search(dialog), "Dev");
  await user.click(
    await within(dialog).findByRole("button", { name: /^Add Dev/ }),
  );
  await waitFor(() => expect(t.members.get(source)).toContain(t.dev.pubkey));
  // People are added; nothing waits for a footer Share.
  expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
  expect(soloShareAttempt(t.session, source)).toBeUndefined();
});

it("Copy alone neither saves selections nor grants access", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue();
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  expect(clipboard).toHaveBeenCalledWith(`buzz://channel/${source}`);
  const copied = within(dialog).getByRole("button", { name: "Link copied" });
  expect(copied).toHaveFocus();
  expect(within(dialog).getAllByText("Link copied")).toHaveLength(1);
  clipboard.mockRejectedValueOnce(new Error("Clipboard unavailable"));
  await user.click(copied);
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Couldn’t copy the link.",
  );
  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  expect(
    within(dialog).getByRole("button", { name: "Link copied" }),
  ).toHaveFocus();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(t.publish).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Access" }));
  expect(
    search(screen.getByRole("dialog", { name: "Chat access" })),
  ).toHaveValue("");
  expect(
    within(screen.getByRole("dialog", { name: "Chat access" })).getByRole(
      "button",
      { name: "Copy link" },
    ),
  ).toBeEnabled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("shares a frozen channel snapshot to confirmed destination members, reports one actionable grant error, and freezes the retry audience", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  t.failGrant(true);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  expect(within(dialog).getByRole("button", { name: "Share" })).toBeEnabled();
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Chat invite refused",
  );
  expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
  expect(within(dialog).queryByText(/Retry to Planning/)).toBeNull();
  expect(t.published).toHaveLength(0);
  expect(soloShareAttempt(t.session, source)?.audienceKeys).toEqual([
    t.aria.pubkey,
  ]);
  t.addDestination(t.dev.pubkey);
  t.failGrant(false);
  await user.click(within(dialog).getByRole("button", { name: "Retry share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.members.get(source)).toContain(t.aria.pubkey);
  expect(t.members.get(source)).not.toContain(t.dev.pubkey);
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
});

it("posts a partial channel share and reports who couldn't get access", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  t.addDestination(t.dev.pubkey);
  t.failGrant(t.aria.pubkey);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.members.get(source)).toContain(t.dev.pubkey);
  expect(t.members.get(source)).not.toContain(t.aria.pubkey);
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
  expect(
    await screen.findByText(/^Couldn’t give .+ access to the chat\.$/),
  ).toBeVisible();
});

it("keeps the selected channel over close/reopen after posting fails", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  const user = userEvent.setup();
  const view = t.mount();
  t.failLink(true);
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Post refused",
  );
  expect(t.members.get(source)).toContain(t.aria.pubkey);
  expect(t.published.map((item) => item.kind)).toEqual([9000]);
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  view.unmount();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const reopened = screen.getByRole("dialog", { name: "Chat access" });
  expect(
    within(reopened).getByRole("region", { name: "Selected channel" }),
  ).toHaveTextContent("#Planning");
  t.failLink(false);
  await user.click(
    within(reopened).getByRole("button", { name: "Retry share" }),
  );
  await waitFor(() => expect(reopened).not.toBeInTheDocument());
  expect(t.published.map((item) => item.kind)).toEqual([9000, 9]);
});

it("shows Start over only for recovery and keeps the footer actions stable while retrying", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  const footer = dialog.querySelector("footer");
  if (!footer) throw new Error("Share footer missing");
  const actions = () =>
    within(footer)
      .getAllByRole("button")
      .map((button) => button.textContent);
  const initialActions = actions();
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  t.holdLink(first);
  t.failLink(true);
  try {
    await user.click(within(dialog).getByRole("button", { name: "Share" }));
    await waitFor(() =>
      expect(
        t.publish.mock.calls.filter(([event]) => event.kind === 9),
      ).toHaveLength(1),
    );
    expect(actions()).toEqual(initialActions);
    expect(
      within(dialog).queryByRole("button", { name: "Start over" }),
    ).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Share" }),
    ).toHaveAttribute("aria-busy", "true");
  } finally {
    releaseFirst();
    t.holdLink(undefined);
  }
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Post refused",
  );
  expect(
    within(dialog).getByRole("button", { name: "Start over" }),
  ).toBeEnabled();
  const recoveryActions = actions();
  let releaseRetry!: () => void;
  const retry = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  t.holdLink(retry);
  t.failLink(false);
  try {
    await user.click(
      within(dialog).getByRole("button", { name: "Retry share" }),
    );
    await waitFor(() =>
      expect(
        t.publish.mock.calls.filter(([event]) => event.kind === 9),
      ).toHaveLength(2),
    );
    expect(actions()).toEqual(recoveryActions);
    expect(
      within(dialog).getByRole("button", { name: "Start over" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Retry share" }),
    ).toHaveAttribute("aria-busy", "true");
  } finally {
    releaseRetry();
    t.holdLink(undefined);
  }
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  const links = t.publish.mock.calls.filter(([event]) => event.kind === 9);
  expect(links[1]?.[0].id).toBe(links[0]?.[0].id);
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
});

it("serializes the same submitted attempt across two mounted entry points", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  const user = userEvent.setup();
  const initial = t.channel();
  if (!initial) throw new Error("Chat not loaded");
  const first = render(<SoloShare session={t.session} channel={initial} />);
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.holdLink(held);
  try {
    await user.click(within(dialog).getByRole("button", { name: "Share" }));
    await waitFor(() =>
      expect(t.publish.mock.calls.some(([event]) => event.kind === 9)).toBe(
        true,
      ),
    );
    expect(
      within(dialog).getByRole("button", { name: "Share" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      within(dialog).getByRole("button", { name: "Share" }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(within(dialog).getByRole("button", { name: "Share" }));
    expect(
      t.publish.mock.calls.filter(([event]) => event.kind === 9),
    ).toHaveLength(1);
    // Remount while the first attempt awaits the host; the shared attempt stays locked.
    first.unmount();
    const otherView = t.mount();
    await user.click(screen.getByRole("button", { name: "Access" }));
    const other = screen.getByRole("dialog", { name: "Chat access" });
    await user.click(
      within(other).getByRole("button", { name: "Retry share" }),
    );
    expect(within(other).getByRole("alert")).toHaveTextContent(
      "already in progress",
    );
    expect(
      t.publish.mock.calls.filter(([event]) => event.kind === 9),
    ).toHaveLength(1);
    const running = soloShareAttempt(t.session, source);
    await user.click(within(other).getByRole("button", { name: "Start over" }));
    expect(soloShareAttempt(t.session, source)).toBe(running);
    expect(running?.running).toBe(true);
    expect(within(other).getByRole("alert")).toHaveTextContent(
      "already in progress",
    );
    release();
    t.holdLink(undefined);
    await waitFor(() =>
      expect(soloShareAttempt(t.session, source)).toBeUndefined(),
    );
    expect(t.published.filter((event) => event.kind === 9)).toHaveLength(1);
    await user.click(
      within(other).getByRole("button", { name: "Retry share" }),
    );
    expect(soloShareAttempt(t.session, source)).toBeUndefined();
    expect(
      t.publish.mock.calls.filter(([event]) => event.kind === 9),
    ).toHaveLength(1);
    expect(within(other).getByRole("alert")).toHaveTextContent(
      "finished or changed",
    );
    // Closing the settled dialog is separate from deliberately starting over.
    await user.click(within(other).getByRole("button", { name: "Close" }));
    await user.click(
      within(otherView.container).getByRole("button", { name: "Access" }),
    );
    const fresh = screen.getByRole("dialog", { name: "Chat access" });
    expect(within(fresh).getByRole("button", { name: "Done" })).toBeEnabled();
    await chooseDestination(user, fresh);
    expect(within(fresh).getByRole("button", { name: "Share" })).toBeEnabled();
  } finally {
    release();
    t.holdLink(undefined);
  }
});

it("does not let a stale dialog resume a replacement attempt", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  const original = beginSoloShare(t.session, source, {
    destination,
    chatPeople: [],
  });
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  expect(
    within(dialog).getByRole("button", { name: "Retry share" }),
  ).toBeEnabled();
  finishSoloShare(t.session, source);
  const replacement = beginSoloShare(t.session, source, {
    destination,
    chatPeople: [],
  });
  expect(replacement).not.toBe(original);
  await user.click(within(dialog).getByRole("button", { name: "Retry share" }));
  expect(soloShareAttempt(t.session, source)).toBe(replacement);
  expect(t.publish).not.toHaveBeenCalled();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "finished or changed",
  );
});

it.each(["abort", "unmount"] as const)(
  "keeps submitted sharing durable without stale completion after %s",
  async (leave) => {
    const t = fixture();
    await t.ready();
    t.addDestination(t.aria.pubkey);
    const user = userEvent.setup();
    const signal = new AbortController();
    const closed = vi.fn();
    const initial = t.channel();
    if (!initial) throw new Error("Missing channel");
    const view = render(
      <SoloShare
        session={t.session}
        channel={initial}
        signal={signal.signal}
        onClose={closed}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Access" }));
    const dialog = screen.getByRole("dialog", { name: "Chat access" });
    await chooseDestination(user, dialog);
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const held = { promise, resolve, reject };
    t.holdLink(held.promise);
    try {
      await user.click(within(dialog).getByRole("button", { name: "Share" }));
      await waitFor(() =>
        expect(t.publish.mock.calls.some(([event]) => event.kind === 9)).toBe(
          true,
        ),
      );
      if (leave === "abort") signal.abort();
      else view.unmount();
      held.resolve();
      await waitFor(() =>
        expect(soloShareAttempt(t.session, source)).toBeUndefined(),
      );
      expect(t.published.filter((event) => event.kind === 9)).toHaveLength(1);
      expect(closed).not.toHaveBeenCalled();
      expect(
        readShareHistory(viewRevision(t.session.scope, shareHistoryKey(source)))
          .channels,
      ).toEqual([
        {
          id: destination,
          name: "Planning",
          members: [t.viewer.pubkey, t.aria.pubkey],
        },
      ]);
    } finally {
      held.resolve();
    }
  },
);

it("shows the submitted channel audience after members leave or join, including on reopen", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  t.failLink(true);
  const user = userEvent.setup();
  const view = t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  let dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  await within(dialog).findByText(/Link posting is not confirmed/);
  const attempt = soloShareAttempt(t.session, source);
  t.setDestinationMembers([t.viewer.pubkey, t.dev.pubkey]);
  await act(async () => {
    await t.session.channels.refreshRoster?.(destination, {
      consistency: "strong",
    });
  });
  for (const reopen of [false, true]) {
    if (reopen) {
      view.unmount();
      t.mount();
      await user.click(screen.getByRole("button", { name: "Access" }));
      dialog = screen.getByRole("dialog", { name: "Chat access" });
    }
    const selected = within(dialog).getByRole("region", {
      name: "Selected channel",
    });
    const disclosure = within(selected).getByRole("button", {
      name: /Planning.*2 members.*Submitted audience/,
    });
    await user.click(disclosure);
    expect(await within(selected).findByText("Aria")).toBeVisible();
    expect(within(selected).queryByText("Dev")).toBeNull();
  }
  t.failLink(false);
  await user.click(within(dialog).getByRole("button", { name: "Retry share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.members.get(source)).toEqual([t.viewer.pubkey, t.aria.pubkey]);
  expect(t.published.filter((event) => event.kind === 9000)).toHaveLength(1);
  expect(t.published.find((event) => event.kind === 9)?.id).toBe(
    attempt?.messageId,
  );
});

it("freezes an oversized channel audience across Retry until Start over chooses new intent", async () => {
  const t = fixture();
  await t.ready();
  for (let i = 1; i <= 101; i++)
    t.addDestination(i.toString(16).padStart(64, "0"));
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    /100.*recipients/,
  );
  expect(t.publish).not.toHaveBeenCalled();
  const submitted = soloShareAttempt(t.session, source);
  expect(submitted?.audienceKeys).toHaveLength(101);
  if (!submitted?.audienceKeys) throw new Error("Submitted audience missing");
  const frozenKeys = [...submitted.audienceKeys];
  expect(
    within(dialog).getByRole("button", {
      name: /Planning.*102 members.*Submitted audience/,
    }),
  ).toBeVisible();
  t.setDestinationMembers([t.viewer.pubkey, t.aria.pubkey]);
  await user.click(within(dialog).getByRole("button", { name: "Retry share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    /100.*recipients/,
  );
  expect(soloShareAttempt(t.session, source)?.audienceKeys).toEqual(frozenKeys);
  expect(t.publish).not.toHaveBeenCalled();
  expect(t.members.get(source)).toEqual([t.viewer.pubkey]);
  expect(
    within(dialog).getByRole("button", {
      name: /Planning.*102 members.*Submitted audience/,
    }),
  ).toBeVisible();
  await user.click(within(dialog).getByRole("button", { name: "Start over" }));
  expect(soloShareAttempt(t.session, source)).toBeUndefined();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
  await user.type(search(dialog), "Aria");
  await user.click(
    await within(dialog).findByRole("button", { name: /^Add Aria/ }),
  );
  await waitFor(() =>
    expect(t.members.get(source)).toEqual([t.viewer.pubkey, t.aria.pubkey]),
  );
  expect(t.published.map((event) => event.kind)).toEqual([9000]);
});

it("starting over preserves access and lets Outbox finish the exact link before another share", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  t.failLink(true);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Post refused",
  );
  const saved = soloShareAttempt(t.session, source);
  expect(saved?.messageId).toBeDefined();
  const receipt = t.session.outbox
    ?.snapshot()
    .find((item) => item.event.id === saved?.messageId);
  expect(receipt).toBeDefined();
  expect(dialog).not.toHaveTextContent("Retry keeps the");
  const writes = t.publish.mock.calls.length;
  await user.click(within(dialog).getByRole("button", { name: "Start over" }));
  expect(soloShareAttempt(t.session, source)).toBeUndefined();
  expect(t.members.get(source)).toContain(t.aria.pubkey);
  expect(
    t.session.outbox
      ?.snapshot()
      .find((item) => item.event.id === saved?.messageId),
  ).toEqual(receipt);
  expect(t.publish).toHaveBeenCalledTimes(writes);
  expect(search(dialog)).toHaveValue("");
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  const outbox = t.session.outbox;
  if (!outbox || !receipt) throw new Error("Missing link receipt");
  render(<OutboxStatus outbox={outbox} profiling={createRelayProfiler()} />);
  await user.click(screen.getByText(/^Outbox ·/));
  // The Outbox renders the message, not its last transport error.
  const linkRow = screen.getByText(/\[Chat:/).closest("li");
  if (!linkRow) throw new Error("Missing Outbox link");
  t.failLink(false);
  await user.click(within(linkRow).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(["accepted", "seen"]).toContain(
      outbox.snapshot().find((item) => item.event.id === receipt.event.id)
        ?.delivery,
    ),
  );
  expect(
    t.publish.mock.calls
      .filter(([event]) => event.kind === 9)
      .map(([event]) => event.id),
  ).toEqual([receipt.event.id, receipt.event.id]);
  await user.click(
    within(linkRow).getByRole("button", { name: "Remove from outbox" }),
  );
  await waitFor(() =>
    expect(
      outbox.snapshot().find((item) => item.event.id === receipt.event.id),
    ).toBeUndefined(),
  );
  await user.click(screen.getByRole("button", { name: "Access" }));
  const next = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, next);
  await user.click(within(next).getByRole("button", { name: "Share" }));
  await waitFor(() => expect(next).not.toBeInTheDocument());
  expect(t.published.filter((event) => event.kind === 9)).toHaveLength(2);
  expect(t.published.filter((event) => event.kind === 9000)).toHaveLength(1);
});

it("a stale Start over cannot discard a replacement attempt", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  const intent = {
    destination,
    chatPeople: [],
  };
  const original = beginSoloShare(t.session, source, intent);
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  finishSoloShare(t.session, source);
  const replacement = beginSoloShare(t.session, source, intent);
  expect(replacement).not.toBe(original);
  await user.click(within(dialog).getByRole("button", { name: "Start over" }));
  expect(soloShareAttempt(t.session, source)).toBe(replacement);
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "finished or changed",
  );
  expect(t.publish).not.toHaveBeenCalled();
});

it("retries a rejected, expired grant only after its failed Outbox item is dismissed", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  t.failGrant(true);
  const user = userEvent.setup();
  const view = t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  let dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Chat invite refused",
  );
  const first = t.publish.mock.calls[0]?.[0];
  if (!first) throw new Error("Expected invitation");
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue((first.created_at + 16 * 60) * 1000);
  try {
    await user.click(
      within(dialog).getByRole("button", { name: "Retry share" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "addition expired",
    );
    expect(t.publish).toHaveBeenCalledTimes(1);
    view.unmount();
    await t.session.outbox?.dismiss(first.id);
    expect(
      soloShareAttempt(t.session, source)?.grants.get(t.aria.pubkey)?.dismissed,
    ).toBe(true);
    t.failGrant(false);
    t.mount();
    await user.click(screen.getByRole("button", { name: "Access" }));
    dialog = screen.getByRole("dialog", { name: "Chat access" });
    await user.click(
      within(dialog).getByRole("button", { name: "Retry share" }),
    );
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    const grants = t.publish.mock.calls
      .map(([event]) => event)
      .filter((event) => event.kind === 9000);
    expect(grants).toHaveLength(2);
    expect(grants[1]?.id).not.toBe(first.id);
    expect(t.members.get(source)).toContain(t.aria.pubkey);
    expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
  } finally {
    now.mockRestore();
  }
});

it("Done never promotes or removes a Solo chat, and conversion stays in the chat menu", async () => {
  const t = fixture(true);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  expect(within(dialog).queryByRole("textbox", { name: "Name" })).toBeNull();
  expect(within(dialog).queryByRole("switch")).toBeNull();
  expect(
    within(dialog).queryByRole("button", { name: "Convert to channel" }),
  ).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.publish).not.toHaveBeenCalled();
  expect(t.placement).not.toHaveBeenCalled();
  expect(t.channel()?.channelType).toBe("solo");
});

it("shares one channel snapshot, retains confirmed partial access and exact link retry", async () => {
  const t = fixture(true);
  await t.ready();
  t.addDestination(t.aria.pubkey);
  t.addDestination(t.dev.pubkey);
  t.failLink(true);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  const selectedChannel = within(dialog).getByRole("region", {
    name: "Selected channel",
  });
  const channelParticipants = await within(selectedChannel).findByRole(
    "button",
    { name: /#Planning.*3 members/ },
  );
  expect(channelParticipants).toHaveAttribute("aria-expanded", "false");
  expect(within(selectedChannel).queryByText("Dev")).toBeNull();
  await user.click(channelParticipants);
  await within(selectedChannel).findByText("Dev");
  await user.click(channelParticipants);
  // One channel per share: the chosen channel leaves the results.
  await user.type(search(dialog), "Plan");
  expect(within(dialog).queryByRole("region", { name: "Channels" })).toBeNull();
  await user.clear(search(dialog));
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Access confirmed for 2 recipients",
  );
  const attempt = soloShareAttempt(t.session, source);
  expect([...(attempt?.audienceKeys ?? [])].sort()).toEqual(
    [t.aria.pubkey, t.dev.pubkey].sort(),
  );
  const id = attempt?.messageId;
  const late = keypair();
  t.addDestination(late.pubkey);
  await act(async () => {
    await t.session.channels.refreshRoster?.(destination, {
      consistency: "strong",
    });
  });
  expect(
    await within(selectedChannel).findByRole("button", {
      name: /#Planning.*3 members.*Submitted audience/,
    }),
  ).toHaveAttribute("aria-expanded", "false");
  t.failLink(false);
  await user.click(within(dialog).getByRole("button", { name: "Retry share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.members.get(source)).toEqual(
    expect.arrayContaining([t.viewer.pubkey, t.aria.pubkey, t.dev.pubkey]),
  );
  expect(t.members.get(source)).not.toContain(late.pubkey);
  expect(t.published.filter((event) => event.kind === 9000)).toHaveLength(2);
  expect(
    t.publish.mock.calls
      .filter(([event]) => event.kind === 9)
      .map(([event]) => event.id),
  ).toEqual([id, id]);
  expect(t.placement).not.toHaveBeenCalled();
  expect(t.channel()?.channelType).toBe("solo");
  expect(t.published.some((event) => event.kind === 9002)).toBe(false);
  cleanup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const reopened = screen.getByRole("dialog", { name: "Chat access" });
  const shared = await within(reopened).findByRole("region", {
    name: "Shared with channels",
  });
  const segment = within(shared).getByRole("button", {
    name: /#Planning.*3 members/,
  });
  expect(segment).toHaveAttribute("aria-expanded", "false");
  await user.click(segment);
  await within(shared).findByText("Dev");
  expect(reopened).not.toHaveTextContent(
    formatPublicKey(late.pubkey) ?? "late",
  );
  t.setSourceMembers([t.viewer.pubkey, t.aria.pubkey]);
  await act(async () => {
    await t.session.channels.refreshRoster?.(source, { consistency: "strong" });
  });
  expect(segment).toHaveAccessibleName(/#Planning.*2 members/);
  expect(t.published.filter((event) => event.kind === 9000)).toHaveLength(2);
});

it("leaves agents to mentions but includes channel bots without waking them", async () => {
  const t = fixture();
  await t.ready();
  const bot = keypair();
  t.addProfile(bot, "Helper Bot", true);
  t.addDestination(bot.pubkey);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await waitForAccess(dialog);
  await user.type(search(dialog), "Helper");
  const results = await within(dialog).findByRole("region", {
    name: "Not in this chat",
  });
  await within(results).findByText("To add an agent, mention it in the chat.");
  expect(results).toHaveTextContent("No other matching people.");
  expect(within(results).queryByRole("button", { name: /Helper/ })).toBeNull();
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
  expect(t.published[0]?.tags).toContainEqual(["role", "bot"]);
  expect(t.published[1]?.tags.some(([name]) => name === "p")).toBe(false);
  expect(document.querySelector("[data-solo-shared]")).toBeNull();
});

it("shows loading and failed current access with refresh, never an empty roster", async () => {
  const t = fixture();
  await t.ready();
  let release!: () => void;
  t.holdRoster(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  t.failRoster(true);
  const user = userEvent.setup();
  t.mount();
  try {
    await user.click(screen.getByRole("button", { name: "Access" }));
    const dialog = screen.getByRole("dialog", { name: "Chat access" });
    const access = within(dialog).getByRole("region", { name: "Member list" });
    expect(
      within(access).getByRole("status", { name: "Loading members" }),
    ).toBeVisible();
    release();
    expect(await within(access).findByRole("alert")).toHaveTextContent(
      "Roster unavailable",
    );
    // A failed roster read never presents verified roles.
    expect(within(access).queryByText("Owner", { exact: true })).toBeNull();
    t.failRoster(false);
    t.holdRoster(undefined);
    const refresh = within(dialog).getByRole("button", {
      name: "Refresh member data",
    });
    await waitFor(() =>
      expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
    );
    await user.click(refresh);
    await within(access).findByRole("region", { name: "People" });
    expect(within(access).queryByRole("alert")).toBeNull();
    t.failRoster(true);
    await chooseDestination(user, dialog);
    const selectedChannel = within(dialog).getByRole("region", {
      name: "Selected channel",
    });
    const unavailable = await within(selectedChannel).findByRole("button", {
      name: /#Planning.*Participants unavailable/,
    });
    expect(selectedChannel).not.toHaveTextContent("0 members");
    await user.click(unavailable);
    expect(within(selectedChannel).getByRole("status")).toHaveTextContent(
      "unavailable",
    );
    t.failRoster(false);
    await user.click(
      within(selectedChannel).getByRole("button", {
        name: "Retry participants",
      }),
    );
    await within(selectedChannel).findByRole("button", {
      name: /#Planning.*1 member/,
    });
    expect(t.publish).not.toHaveBeenCalled();
  } finally {
    release();
    t.holdRoster(undefined);
  }
});

it("resumes a submitted existing destination after remount without replacing its link ID", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  const attempt = beginSoloShare(t.session, source, {
    destination,
    chatPeople: [],
  });
  t.failLink(true);
  const user = userEvent.setup();
  const view = t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await user.click(within(dialog).getByRole("button", { name: "Retry share" }));
  await within(dialog).findByRole("alert");
  const id = attempt.messageId;
  view.unmount();
  t.failLink(false);
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const reopened = screen.getByRole("dialog", { name: "Chat access" });
  await user.click(
    within(reopened).getByRole("button", { name: "Retry share" }),
  );
  await waitFor(() => expect(reopened).not.toBeInTheDocument());
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
  expect(
    t.publish.mock.calls
      .filter(([event]) => event.kind === 9)
      .map(([event]) => event.id),
  ).toEqual([id, id]);
});

it("groups agents and people by role while only verified additional humans mark the chat Shared", async () => {
  const t = fixture();
  const bot = keypair(),
    unknown = keypair();
  t.addProfile(bot, "Helper Bot", true);
  t.members.set(source, [t.viewer.pubkey, bot.pubkey]);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  let dialog = screen.getByRole("dialog", { name: "Chat access" });
  const agents = await within(dialog).findByRole("region", { name: "Agents" });
  await within(agents).findByText("Helper Bot");
  expect(within(agents).getByRole("heading")).toHaveTextContent("Agents · 1");
  const people = within(dialog).getByRole("region", { name: "People" });
  expect(people).toHaveTextContent("(you)");
  expect(people).not.toHaveTextContent("Helper Bot");

  t.setSourceMembers([t.viewer.pubkey, bot.pubkey, unknown.pubkey]);
  await act(async () => {
    await t.session.channels.refreshRoster?.(source, { consistency: "strong" });
  });
  await waitFor(() =>
    expect(
      within(
        within(dialog).getByRole("region", { name: "People" }),
      ).getAllByRole("listitem"),
    ).toHaveLength(2),
  );
  expect(within(dialog).getAllByText("Helper Bot")).toHaveLength(1);
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(document.querySelector("[data-solo-shared]")).toBeNull();
  t.addProfile(unknown, "Guest Human");
  await t.session.profiles.ensure([unknown.pubkey], "foreground");
  await waitFor(() =>
    expect(document.querySelector("[data-solo-shared]")).not.toBeNull(),
  );
  await user.click(screen.getByRole("button", { name: "Access" }));
  dialog = screen.getByRole("dialog", { name: "Chat access" });
  expect(
    await within(dialog).findByRole("region", { name: "People" }),
  ).toHaveTextContent("Guest Human");
  expect(t.publish).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  saveShareHistory(t.session.scope, source, [], {
    id: destination,
    name: "Planning",
    members: [t.viewer.pubkey, bot.pubkey],
  });
  await user.click(screen.getByRole("button", { name: "Access" }));
  dialog = screen.getByRole("dialog", { name: "Chat access" });
  const shared = await within(dialog).findByRole("region", {
    name: "Shared with channels",
  });
  const recorded = within(shared).getByRole("button", {
    name: /#Planning.*2 members/,
  });
  expect(within(shared).queryByText("Helper Bot")).toBeNull();
  await user.click(recorded);
  await within(shared).findByText("Helper Bot");
  expect(t.publish).not.toHaveBeenCalled();
});

it("never posts a zero-recipient channel share and Start over clears the channel", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "no other current members",
  );
  expect(t.publish).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Start over" }));
  expect(
    within(dialog).queryByRole("region", { name: "Selected channel" }),
  ).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(t.publish).not.toHaveBeenCalled();
});

it("shows Shared on cold render from verified members and cached human evidence without administration demand", async () => {
  const t = fixture();
  t.members.set(source, [t.viewer.pubkey, t.aria.pubkey]);
  await t.ready();
  await t.session.profiles.ensure([t.aria.pubkey], "foreground");
  const channel = t.channel();
  expect(t.session.memberAdministration.snapshot(source)?.status).not.toBe(
    "ready",
  );
  expect(channel?.cached).not.toBe(true);
  // The sidebar's status mark is not an action; Access manages sharing.
  render(
    <>
      <button type="button" aria-describedby={soloSharedMarkId(source)}>
        Row
      </button>
      <ChatSharedMark session={t.session} channel={channel} />
    </>,
  );
  expect(screen.getByRole("button")).toHaveAccessibleDescription("Shared");
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(t.session.memberAdministration.snapshot(source)?.status).not.toBe(
    "ready",
  );
});

it("explains access changes and disables a saved Retry until current access recovers", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  const attempt = beginSoloShare(t.session, source, {
    destination,
    chatPeople: [],
  });
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await waitForAccess(dialog);
  t.setArchived(true);
  await waitFor(() => expect(t.channel()?.archived).toBe(true));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "access changed",
  );
  expect(
    within(dialog).getByRole("button", { name: "Retry share" }),
  ).toBeDisabled();
  expect(soloShareAttempt(t.session, source)).toBe(attempt);
  expect(t.publish).not.toHaveBeenCalled();
  t.setArchived(false);
  await waitFor(() => {
    expect(t.channel()).toBeDefined();
    expect(t.channel()?.archived).not.toBe(true);
  });
  await waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Retry share" }),
    ).toBeEnabled(),
  );
  expect(within(dialog).queryByRole("alert")).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "Retry share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
});

it("offers matching people and channels as labelled results without public keys", async () => {
  const t = fixture();
  const planningPerson = keypair();
  t.addProfile(planningPerson, "Planning Person");
  t.members.set(source, [t.viewer.pubkey, t.aria.pubkey]);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  expect(
    await within(dialog).findByRole("region", { name: "People" }),
  ).toHaveTextContent("Aria");
  await user.type(search(dialog), "Planning");
  const people = await within(dialog).findByRole("region", {
    name: "Not in this chat",
  });
  await within(people).findByRole("button", { name: /^Add Planning Person/ });
  const channels = within(dialog).getByRole("region", { name: "Channels" });
  expect(
    within(channels).getByRole("button", { name: "Select #Planning" }),
  ).toHaveTextContent("Select");
  expect(dialog).not.toHaveTextContent(formatPublicKey(t.aria.pubkey) ?? "");
  expect(dialog).not.toHaveTextContent(
    formatPublicKey(planningPerson.pubkey) ?? "",
  );
  await user.click(
    within(channels).getByRole("button", { name: "Select #Planning" }),
  );
  expect(search(dialog)).toHaveValue("");
  expect(
    within(dialog).getByRole("region", { name: "Selected channel" }),
  ).toHaveTextContent("#Planning");
  expect(within(dialog).getByRole("button", { name: "Share" })).toBeEnabled();
  await user.click(
    within(dialog).getByRole("button", { name: "Remove #Planning" }),
  );
  expect(within(dialog).getByRole("button", { name: "Done" })).toBeEnabled();
  expect(t.publish).not.toHaveBeenCalled();
});

it("distinguishes namesakes in results and adds only the chosen identity", async () => {
  const t = fixture();
  const first = keypair(),
    second = keypair();
  t.addProfile(first, "Morgan");
  t.addProfile(second, "Morgan");
  await t.ready();
  const labels = publicKeyLabels([first.pubkey, second.pubkey]);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await waitForAccess(dialog);
  await user.type(search(dialog), "Morgan");
  const firstAdd = await within(dialog).findByRole("button", {
    name: `Add Morgan (${labels.get(first.pubkey)})`,
  });
  expect(
    within(dialog).getByRole("button", {
      name: `Add Morgan (${labels.get(second.pubkey)})`,
    }),
  ).toBeVisible();
  // Without a naming plugin the rows still differ visibly, by key only.
  const shown = within(dialog)
    .getAllByText(/^npub…/)
    .map((node) => node.textContent);
  expect(shown).toHaveLength(2);
  expect(new Set(shown).size).toBe(2);
  expect(shown).toContain(
    firstAdd.getAttribute("aria-label")?.match(/\((npub…\w+)\)/)?.[1],
  );
  await user.click(firstAdd);
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9000]),
  );
  expect(t.published[0]?.tags).toContainEqual(["p", first.pubkey]);
  expect(t.published[0]?.tags).not.toContainEqual(["p", second.pubkey]);
});

it("keeps completed access/link work out of Retry when device-local history cannot be saved", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  await chooseDestination(user, dialog);
  const original = Storage.prototype.setItem;
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.includes("solo:shares:")) throw new Error("Quota");
      original.call(this, key, value);
    });
  try {
    await user.click(within(dialog).getByRole("button", { name: "Share" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "history couldn’t be saved",
    );
    await within(dialog).findByRole("button", { name: "Done" });
    expect(soloShareAttempt(t.session, source)).toBeUndefined();
    expect(
      within(dialog).queryByRole("button", { name: "Retry share" }),
    ).toBeNull();
    expect(
      await within(dialog).findByRole("region", { name: "People" }),
    ).toHaveTextContent("Aria");
    expect(t.members.get(source)).toContain(t.aria.pubkey);
    expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
  } finally {
    storage.mockRestore();
  }
});

it("updates the row conversion guard for a share owned by another mounted entry point", async () => {
  const t = fixture(true);
  await t.ready();
  const user = userEvent.setup();
  render(
    <SoloWorkspaces
      session={t.session}
      scope={t.session.scope}
      chats={[{ id: source, title: "Work" }]}
      renderChat={(item) => <button type="button">{item.title}</button>}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Actions for Work" }));
  const convert = await screen.findByRole("menuitem", {
    name: "Convert to channel",
  });
  expect(convert).not.toHaveAttribute("aria-disabled", "true");
  act(() => {
    beginSoloShare(t.session, source, {
      destination,
      chatPeople: [],
    });
  });
  expect(convert).toHaveAttribute("aria-disabled", "true");
  await user.click(convert);
  expect(
    screen.queryByRole("dialog", { name: "Convert to channel" }),
  ).toBeNull();
  act(() => {
    finishSoloShare(t.session, source);
  });
  expect(convert).not.toHaveAttribute("aria-disabled", "true");
  await user.click(convert);
  expect(
    await screen.findByRole("dialog", { name: "Convert to channel" }),
  ).toBeVisible();
});

it("lets the chat owner remove someone with access from the row menu", async () => {
  const t = fixture(true);
  t.members.set(source, [t.viewer.pubkey, t.aria.pubkey]);
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Access" }));
  const dialog = screen.getByRole("dialog", { name: "Chat access" });
  const people = await within(dialog).findByRole("region", { name: "People" });
  await user.click(
    await within(people).findByRole("button", { name: "Actions for Aria" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove from chat" }),
  );
  const confirm = await within(dialog).findByRole("button", {
    name: "Remove member",
  });
  expect(dialog).toHaveAccessibleName("Remove member from chat");
  await waitFor(() => expect(confirm).toBeEnabled());
  await user.click(confirm);
  await waitFor(() =>
    expect(t.published.map((event) => event.kind)).toEqual([9001]),
  );
  expect(t.members.get(source)).toEqual([t.viewer.pubkey]);
});
