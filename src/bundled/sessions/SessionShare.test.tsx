// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  metadata,
  profile,
  roster,
  signed,
} from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import {
  beginSessionShare,
  finishSessionShare,
  sessionShareAttempt,
} from "../../features/sessions/share-attempt";
import { OutboxStatus } from "../channels/OutboxStatus";
import { createRelayProfiler } from "../../features/relay/profiling";
import { SessionShare } from "./SessionShare";

const source = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
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
        ["private"],
        ["about", "Buzz session (buzz.sessions/v1)"],
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
  let failCreation = false;
  let failGrant = false;
  let failDetails = false;
  let loseDetailsResponse = false;
  const placement = vi.fn(async () => {});
  let records: readonly import("../../features/relay/outbox").OutgoingEvent[] =
    [];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9) await holdLink;
    if (event.kind === 9 && failLink) throw new PublishRejected("Post refused");
    if (event.kind === 9000 && failGrant)
      throw new PublishRejected("Session invite refused");
    if (event.kind === 9007 && failCreation)
      throw new PublishRejected("Create refused");
    if (event.kind === 9002 && failDetails)
      throw new PublishRejected("Settings refused");
    published.push(event);
    if (event.kind === 9002) {
      const value = (tag: string) =>
        event.tags.find(([name]) => name === tag)?.[1];
      const previous = metadataEvents.get(source)?.tags ?? [];
      const ttl = value("ttl") ?? previous.find(([tag]) => tag === "ttl")?.[1];
      const visibility = value("visibility");
      metadataEvents.set(
        source,
        metadata(relay, source, value("name") ?? "Work", ++clock, [
          ["t", "stream"],
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
    if (event.kind === 9007) {
      const id = event.tags.find(([name]) => name === "h")?.[1] ?? "";
      members.set(id, [viewer.pubkey]);
      metadataEvents.set(
        id,
        metadata(
          relay,
          id,
          event.tags.find(([name]) => name === "name")?.[1] ?? "New",
          ++clock,
          [
            ["t", "stream"],
            [
              event.tags.find(([name]) => name === "visibility")?.[1] ===
              "private"
                ? "private"
                : "public",
            ],
          ],
        ),
      );
    }
    if (event.kind === 9000) {
      const id = event.tags.find(([name]) => name === "h")?.[1] ?? "";
      const key = event.tags.find(([name]) => name === "p")?.[1] ?? "";
      members.set(id, [...new Set([...(members.get(id) ?? []), key])]);
      clock++;
    }
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://community.test",
      media: () => undefined,
      query: async (filters) => {
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
          ...[...members].map(([id, keys]) => roster(relay, id, keys, clock)),
          ...published,
          ...profiles,
        ];
        return events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
      channelDetails: {
        sign: async (event) => signed(viewer, event),
        publish,
      },
      writer: {
        kinds: [9, 9000, 9002, 9007],
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
  const placementState = {
    ...owner.session.mePlacement.snapshot(),
    status: "ready" as const,
  };
  const session = direct
    ? {
        ...owner.session,
        mePlacement: {
          ...owner.session.mePlacement,
          available: true,
          snapshot: () => placementState,
          ensure() {},
          set: placement,
          has: () => true,
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
    viewer,
    aria,
    dev,
    members,
    published,
    publish,
    channel,
    failLink(value: boolean) {
      failLink = value;
    },
    holdLink(value: Promise<void> | undefined) {
      holdLink = value;
    },
    failCreation(value: boolean) {
      failCreation = value;
    },
    failGrant(value: boolean) {
      failGrant = value;
    },
    addDestination(key: string) {
      members.set(destination, [
        ...new Set([...(members.get(destination) ?? []), key]),
      ]);
      clock++;
    },
    async ready() {
      owner.session.channels.ensureList();
      await waitFor(() => expect(channel()?.channelType).toBe("session"));
    },
    mount(props: { signal?: AbortSignal; onShared?: () => void } = {}) {
      const initial = channel();
      if (!initial) throw new Error("Session not loaded");
      return render(
        <SessionShare
          session={session}
          channel={initial}
          direct={direct}
          {...props}
        />,
      );
    },
  };
}

async function chooseDestination(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  option: "Planning" | "Create new channel…" = "Planning",
) {
  await user.click(within(dialog).getByRole("combobox", { name: "Share to" }));
  await user.click(await screen.findByRole("option", { name: option }));
}

it("Copy alone neither saves selections nor grants access", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Share" }));
  const dialog = screen.getByRole("dialog", { name: "Share session" });
  const clipboard = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue();
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  expect(clipboard).toHaveBeenCalledWith(`buzz://channel/${source}`);
  expect(t.publish).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Share" }));
  expect(
    within(screen.getByRole("dialog", { name: "Share session" })).getByRole(
      "combobox",
      { name: "Share to" },
    ),
  ).toHaveTextContent("Choose a channel");
  expect(t.publish).not.toHaveBeenCalled();
});

it("defaults Everyone to confirmed destination members, reports one actionable grant error, and freezes the retry audience", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  t.failGrant(true);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Share" }));
  const dialog = screen.getByRole("dialog", { name: "Share session" });
  expect(
    within(dialog).getByRole("radio", { name: "Everyone in this channel" }),
  ).toHaveAttribute("aria-checked", "true");
  await chooseDestination(user, dialog);
  expect(within(dialog).getByRole("button", { name: "Share" })).toBeEnabled();
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Session invite refused",
  );
  expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
  expect(within(dialog).queryByText(/Retry to Planning/)).toBeNull();
  expect(t.published).toHaveLength(0);
  expect(sessionShareAttempt(t.session, source)?.audienceKeys).toEqual([
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

it("keeps exact selected session recipients over close/reopen after posting fails", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  const view = t.mount();
  t.failLink(true);
  await user.click(screen.getByRole("button", { name: "Share" }));
  const dialog = screen.getByRole("dialog", { name: "Share session" });
  await chooseDestination(user, dialog);
  await user.click(
    within(dialog).getByRole("radio", { name: "Selected people" }),
  );
  await user.type(
    within(dialog).getByRole("combobox", { name: "Find people" }),
    "Aria",
  );
  await user.click(await within(dialog).findByRole("option", { name: /Aria/ }));
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Post refused",
  );
  expect(t.members.get(source)).toContain(t.aria.pubkey);
  expect(t.members.get(destination)).not.toContain(t.aria.pubkey);
  expect(t.published.map((item) => item.kind)).toEqual([9000]);
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  view.unmount();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Share" }));
  const reopened = screen.getByRole("dialog", { name: "Share session" });
  expect(reopened).toHaveTextContent("1 selected for session access");
  t.failLink(false);
  await user.click(
    within(reopened).getByRole("button", { name: "Retry share" }),
  );
  await waitFor(() => expect(reopened).not.toBeInTheDocument());
  expect(t.published.map((item) => item.kind)).toEqual([9000, 9]);
});

it("serializes the same submitted attempt across two mounted entry points", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  const initial = t.channel();
  if (!initial) throw new Error("Session not loaded");
  const first = render(<SessionShare session={t.session} channel={initial} />);
  await user.click(screen.getByRole("button", { name: "Share" }));
  const dialog = screen.getByRole("dialog", { name: "Share session" });
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
    // Remount while the first attempt awaits the host; the shared attempt stays locked.
    first.unmount();
    const otherView = t.mount();
    await user.click(screen.getByRole("button", { name: "Share" }));
    const other = screen.getByRole("dialog", { name: "Share session" });
    await user.click(
      within(other).getByRole("button", { name: "Retry share" }),
    );
    expect(within(other).getByRole("alert")).toHaveTextContent(
      "already in progress",
    );
    expect(
      t.publish.mock.calls.filter(([event]) => event.kind === 9),
    ).toHaveLength(1);
    const running = sessionShareAttempt(t.session, source);
    await user.click(within(other).getByRole("button", { name: "Start over" }));
    expect(sessionShareAttempt(t.session, source)).toBe(running);
    expect(running?.running).toBe(true);
    expect(within(other).getByRole("alert")).toHaveTextContent(
      "already in progress",
    );
    release();
    t.holdLink(undefined);
    await waitFor(() =>
      expect(sessionShareAttempt(t.session, source)).toBeUndefined(),
    );
    expect(t.published.filter((event) => event.kind === 9)).toHaveLength(1);
    await user.click(
      within(other).getByRole("button", { name: "Retry share" }),
    );
    expect(sessionShareAttempt(t.session, source)).toBeUndefined();
    expect(
      t.publish.mock.calls.filter(([event]) => event.kind === 9),
    ).toHaveLength(1);
    expect(within(other).getByRole("alert")).toHaveTextContent(
      "finished or changed",
    );
    // Closing the settled dialog is separate from deliberately starting over.
    await user.click(within(other).getByRole("button", { name: "Close" }));
    await user.click(
      within(otherView.container).getByRole("button", { name: "Share" }),
    );
    const fresh = screen.getByRole("dialog", { name: "Share session" });
    expect(within(fresh).getByRole("button", { name: "Share" })).toBeDisabled();
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
  const original = beginSessionShare(t.session, source, {
    destination,
    audience: "selected",
    channelPeople: [],
    sessionPeople: [],
  });
  t.mount();
  await user.click(screen.getByRole("button", { name: "Share" }));
  const dialog = screen.getByRole("dialog", { name: "Share session" });
  expect(
    within(dialog).getByRole("button", { name: "Retry share" }),
  ).toBeEnabled();
  finishSessionShare(t.session, source);
  const replacement = beginSessionShare(t.session, source, {
    destination,
    audience: "selected",
    channelPeople: [],
    sessionPeople: [],
  });
  expect(replacement).not.toBe(original);
  await user.click(within(dialog).getByRole("button", { name: "Retry share" }));
  expect(sessionShareAttempt(t.session, source)).toBe(replacement);
  expect(t.publish).not.toHaveBeenCalled();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "finished or changed",
  );
});

it("uses a searched new-channel invitee in the default Everyone roster, without session selection", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Share" }));
  const dialog = screen.getByRole("dialog", { name: "Share session" });
  await chooseDestination(user, dialog, "Create new channel…");
  expect(
    within(dialog).getByRole("radio", { name: "Everyone in this channel" }),
  ).toHaveAttribute("aria-checked", "true");
  await user.type(
    within(dialog).getByRole("textbox", { name: "Name" }),
    "Project room",
  );
  await user.type(
    within(dialog).getByRole("combobox", {
      name: "Find people to add to new channel",
    }),
    "Aria",
  );
  await user.click(await within(dialog).findByRole("option", { name: /Aria/ }));
  expect(
    within(dialog).queryByRole("group", {
      name: "People to share session with",
    }),
  ).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  const created = t.published
    .find((item) => item.kind === 9007)
    ?.tags.find(([name]) => name === "h")?.[1];
  expect(created).toBeDefined();
  expect(t.members.get(created ?? "")).toContain(t.aria.pubkey);
  expect(t.members.get(source)).toContain(t.aria.pubkey);
  expect(t.published.map((item) => item.kind)).toEqual([9007, 9000, 9000, 9]);
  expect(
    t.published
      .filter((item) => item.kind === 9000)
      .map((item) => item.tags.find(([name]) => name === "h")?.[1]),
  ).toEqual([created, source]);
});

it("creates one channel, separately adds its chosen people, grants the session audience and posts once on retry", async () => {
  const t = fixture();
  await t.ready();
  const user = userEvent.setup();
  t.mount();
  t.failLink(true);
  await user.click(screen.getByRole("button", { name: "Share" }));
  const dialog = screen.getByRole("dialog", { name: "Share session" });
  await chooseDestination(user, dialog, "Create new channel…");
  await user.click(
    within(dialog).getByRole("radio", { name: "Selected people" }),
  );
  await user.type(
    within(dialog).getByRole("textbox", { name: "Name" }),
    "Project room",
  );
  await user.type(
    within(dialog).getByRole("combobox", {
      name: "Find people to add to new channel",
    }),
    "Aria",
  );
  await user.click(await screen.findByRole("option", { name: /Aria/ }));
  await user.type(
    within(dialog).getByRole("combobox", {
      name: "Find people for session access",
    }),
    "Dev",
  );
  await user.click(await screen.findByRole("option", { name: /Dev/ }));
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Post refused",
  );
  const created = t.published
    .find((item) => item.kind === 9007)
    ?.tags.find(([name]) => name === "h")?.[1];
  expect(created).toBeDefined();
  expect(t.members.get(created ?? "")).toContain(t.aria.pubkey);
  expect(t.members.get(source)).toContain(t.dev.pubkey);
  expect(t.members.get(source)).not.toContain(t.aria.pubkey);
  expect(t.members.get(created ?? "")).not.toContain(t.dev.pubkey);
  t.failLink(false);
  await user.click(within(dialog).getByRole("button", { name: "Retry share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.published.map((item) => item.kind)).toEqual([9007, 9000, 9000, 9]);
  expect(t.published.filter((item) => item.kind === 9007)).toHaveLength(1);
});

it.each(["abort", "unmount"] as const)(
  "keeps submitted sharing durable without stale completion after %s",
  async (leave) => {
    const t = fixture();
    await t.ready();
    const user = userEvent.setup();
    const signal = new AbortController();
    const shared = vi.fn();
    const initial = t.channel();
    if (!initial) throw new Error("Missing channel");
    const view = render(
      <SessionShare
        session={t.session}
        channel={initial}
        signal={signal.signal}
        onShared={shared}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Share" }));
    const dialog = screen.getByRole("dialog", { name: "Share session" });
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
        expect(sessionShareAttempt(t.session, source)).toBeUndefined(),
      );
      expect(t.published.filter((event) => event.kind === 9)).toHaveLength(1);
      expect(shared).not.toHaveBeenCalled();
    } finally {
      held.resolve();
    }
  },
);

it("lets an oversized Everyone attempt start over and share with selected people", async () => {
  const t = fixture();
  await t.ready();
  for (let i = 1; i <= 101; i++)
    t.addDestination(i.toString(16).padStart(64, "0"));
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Share" }));
  const dialog = screen.getByRole("dialog", { name: "Share session" });
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "more than 100 recipients",
  );
  expect(t.publish).not.toHaveBeenCalled();
  expect(
    within(dialog).getByRole("radio", { name: "Selected people" }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.click(within(dialog).getByRole("button", { name: "Start over" }));
  expect(sessionShareAttempt(t.session, source)).toBeUndefined();
  expect(within(dialog).queryByRole("alert")).toBeNull();
  expect(
    within(dialog).getByRole("combobox", { name: "Share to" }),
  ).toBeEnabled();
  await chooseDestination(user, dialog);
  await user.click(
    within(dialog).getByRole("radio", { name: "Selected people" }),
  );
  await user.type(
    within(dialog).getByRole("combobox", { name: "Find people" }),
    "Aria",
  );
  await user.click(await within(dialog).findByRole("option", { name: /Aria/ }));
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(t.members.get(source)).toEqual([t.viewer.pubkey, t.aria.pubkey]);
  expect(t.published.map((event) => event.kind)).toEqual([9000, 9]);
});

it("starting over preserves access and lets Outbox finish the exact link before another share", async () => {
  const t = fixture();
  await t.ready();
  t.addDestination(t.aria.pubkey);
  t.failLink(true);
  const user = userEvent.setup();
  t.mount();
  await user.click(screen.getByRole("button", { name: "Share" }));
  const dialog = screen.getByRole("dialog", { name: "Share session" });
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Post refused",
  );
  const saved = sessionShareAttempt(t.session, source);
  expect(saved?.messageId).toBeDefined();
  const receipt = t.session.outbox
    ?.snapshot()
    .find((item) => item.event.id === saved?.messageId);
  expect(receipt).toBeDefined();
  expect(dialog).toHaveTextContent("A new share may post another link.");
  const writes = t.publish.mock.calls.length;
  await user.click(within(dialog).getByRole("button", { name: "Start over" }));
  expect(sessionShareAttempt(t.session, source)).toBeUndefined();
  expect(t.members.get(source)).toContain(t.aria.pubkey);
  expect(
    t.session.outbox
      ?.snapshot()
      .find((item) => item.event.id === saved?.messageId),
  ).toEqual(receipt);
  expect(t.publish).toHaveBeenCalledTimes(writes);
  expect(
    within(dialog).getByRole("combobox", { name: "Share to" }),
  ).toHaveTextContent("Choose a channel");
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  const outbox = t.session.outbox;
  if (!outbox || !receipt) throw new Error("Missing link receipt");
  render(<OutboxStatus outbox={outbox} profiling={createRelayProfiler()} />);
  await user.click(screen.getByText(/^Outbox ·/));
  // The Outbox renders the message, not its last transport error.
  const linkRow = screen.getByText(/\[Session ·/).closest("li");
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
  await user.click(screen.getByRole("button", { name: "Share" }));
  const next = screen.getByRole("dialog", { name: "Share session" });
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
    audience: "selected" as const,
    channelPeople: [],
    sessionPeople: [],
  };
  const original = beginSessionShare(t.session, source, intent);
  t.mount();
  await user.click(screen.getByRole("button", { name: "Share" }));
  const dialog = screen.getByRole("dialog", { name: "Share session" });
  finishSessionShare(t.session, source);
  const replacement = beginSessionShare(t.session, source, intent);
  expect(replacement).not.toBe(original);
  await user.click(within(dialog).getByRole("button", { name: "Start over" }));
  expect(sessionShareAttempt(t.session, source)).toBe(replacement);
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
  await user.click(screen.getByRole("button", { name: "Share" }));
  let dialog = screen.getByRole("dialog", { name: "Share session" });
  await chooseDestination(user, dialog);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Session invite refused",
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
      sessionShareAttempt(t.session, source)?.grants.get(t.aria.pubkey)
        ?.dismissed,
    ).toBe(true);
    t.failGrant(false);
    t.mount();
    await user.click(screen.getByRole("button", { name: "Share" }));
    dialog = screen.getByRole("dialog", { name: "Share session" });
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

async function openDirect(
  t: ReturnType<typeof fixture>,
  props: Parameters<typeof t.mount>[0] = {},
) {
  const user = userEvent.setup();
  await t.ready();
  const view = t.mount(props);
  await user.click(screen.getByRole("button", { name: "Share" }));
  const dialog = screen.getByRole("dialog", { name: "Share conversation" });
  await waitFor(() =>
    expect(within(dialog).getByRole("button", { name: "Share" })).toBeEnabled(),
  );
  return { user, dialog, view };
}
it("shares Me with zero added people using default private/ongoing settings and the existing channel", async () => {
  const t = fixture(true);
  const onShared = vi.fn();
  const { user, dialog } = await openDirect(t, { onShared });
  expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue(
    "Work",
  );
  expect(
    within(dialog).getByRole("switch", { name: "Private" }),
  ).toHaveAttribute("aria-checked", "true");
  expect(
    within(dialog).getByRole("radio", { name: /Ongoing/ }),
  ).toHaveAttribute("aria-checked", "true");
  await user.click(within(dialog).getByRole("button", { name: "Copy link" }));
  expect(t.publish).not.toHaveBeenCalled();
  expect(t.placement).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  await waitFor(() => expect(onShared).toHaveBeenCalledOnce());
  expect(t.published.map((event) => event.kind)).toEqual([9002]);
  expect(t.published[0]?.tags).toEqual([
    ["h", source],
    ["name", "Work"],
    ["about", ""],
  ]);
  expect(t.placement).toHaveBeenCalledWith(source, false, expect.anything());
  expect(t.channel()?.channelType).toBe("stream");
});
it("confirms public history exposure before any writes", async () => {
  const t = fixture(true);
  const { user, dialog } = await openDirect(t);
  await user.click(within(dialog).getByRole("switch", { name: "Private" }));
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(t.publish).not.toHaveBeenCalled();
  await user.click(
    within(dialog).getByRole("button", { name: "Make public and share" }),
  );
  await waitFor(() => expect(t.placement).toHaveBeenCalledOnce());
  expect(t.published[0]?.tags).toContainEqual(["visibility", "open"]);
});
it.each(["grant", "details", "placement", "uncertain"] as const)(
  "recovers Me Share after %s failure without duplicating confirmed grants or TTL writes",
  async (failure) => {
    const t = fixture(true);
    const onShared = vi.fn();
    const { user, dialog } = await openDirect(t, { onShared });
    await user.type(
      within(dialog).getByRole("combobox", { name: "Find people" }),
      "Aria",
    );
    await user.click(
      await within(dialog).findByRole("option", { name: /Aria/ }),
    );
    await user.click(within(dialog).getByRole("radio", { name: /Temporary/ }));
    t.failGrant(failure === "grant");
    t.failDetails(failure === "details");
    t.loseDetailsResponse(failure === "uncertain");
    if (failure === "placement")
      t.placement.mockRejectedValueOnce(new Error("Placement refused"));
    await user.click(within(dialog).getByRole("button", { name: "Share" }));
    await within(dialog).findByRole("alert");
    expect(onShared).not.toHaveBeenCalled();
    expect(
      within(dialog).getByRole("textbox", { name: "Name" }),
    ).toBeDisabled();
    expect(t.published.map((event) => event.kind)).toEqual(
      failure === "grant" ? [] : failure === "details" ? [9000] : [9000, 9002],
    );
    if (failure !== "placement") expect(t.placement).not.toHaveBeenCalled();
    t.failGrant(false);
    t.failDetails(false);
    t.loseDetailsResponse(false);
    await user.click(
      within(dialog).getByRole("button", { name: "Retry share" }),
    );
    await waitFor(() => expect(onShared).toHaveBeenCalledOnce());
    expect(t.published.map((event) => event.kind)).toEqual([9000, 9002]);
    expect(t.published[1]?.tags).toContainEqual(["ttl", "604800"]);
    expect(t.members.get(source)).toEqual([t.viewer.pubkey, t.aria.pubkey]);
    expect(t.session.channelDetails.snapshot(source)).toBeUndefined();
    expect(sessionShareAttempt(t.session, source)).toBeUndefined();
  },
);

it("Start over reloads editable settings after a rejected direct share", async () => {
  const t = fixture(true);
  const onShared = vi.fn();
  const { user, dialog } = await openDirect(t, { onShared });
  t.failDetails(true);
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Settings refused",
  );
  t.failDetails(false);
  await user.click(within(dialog).getByRole("button", { name: "Start over" }));
  const name = await within(dialog).findByRole("textbox", { name: "Name" });
  await waitFor(() => expect(name).toBeEnabled());
  expect(name).toHaveValue("Work");
  const share = within(dialog).getByRole("button", { name: "Share" });
  expect(share).toBeEnabled();
  await user.click(share);
  await waitFor(() => expect(onShared).toHaveBeenCalledOnce());
});

it("Start over can edit promoted settings after placement fails without replaying grants or TTL", async () => {
  const t = fixture(true);
  const onShared = vi.fn();
  const { user, dialog } = await openDirect(t, { onShared });
  await user.type(
    within(dialog).getByRole("combobox", { name: "Find people" }),
    "Aria",
  );
  await user.click(await within(dialog).findByRole("option", { name: /Aria/ }));
  await user.click(within(dialog).getByRole("radio", { name: /Temporary/ }));
  t.placement.mockRejectedValueOnce(new Error("Placement refused"));
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Placement refused",
  );
  expect(t.channel()?.channelType).toBe("stream");
  await user.click(within(dialog).getByRole("button", { name: "Start over" }));
  const name = await within(dialog).findByRole("textbox", { name: "Name" });
  await waitFor(() => expect(name).toBeEnabled());
  expect(
    within(dialog).getByRole("radio", { name: /Temporary/ }),
  ).toHaveAttribute("aria-checked", "true");
  await user.clear(name);
  await user.type(name, "Shared work");
  await user.click(within(dialog).getByRole("button", { name: "Share" }));
  await waitFor(() => expect(onShared).toHaveBeenCalledOnce());
  expect(t.published.map(({ kind }) => kind)).toEqual([9000, 9002, 9002]);
  expect(t.published[2]?.tags).toEqual([
    ["h", source],
    ["name", "Shared work"],
    ["about", ""],
  ]);
  expect(t.members.get(source)).toEqual([t.viewer.pubkey, t.aria.pubkey]);
  expect((await t.session.channelDetails.load(source)).ttlSeconds).toBe(604800);
  expect(sessionShareAttempt(t.session, source)).toBeUndefined();
});
