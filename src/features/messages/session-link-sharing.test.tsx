// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { RelayEvent, ReadFilter } from "../relay/events";
import { PublishRejected } from "../relay/outbox";
import { beginSoloShare, finishSoloShare } from "../solo/share-attempt";
import { MessageComposer } from "./MessageComposer";
import { composerDOMFixture } from "./composer-testing";
import { writeView } from "../../shared/view-state";

composerDOMFixture();
const source = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const root = "a".repeat(64);
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  localStorage.clear();
  for (const owner of owners.splice(0)) owner.dispose();
});
async function fixture(thread = false) {
  const viewer = keypair(),
    relay = keypair(),
    person = keypair(),
    late = keypair();
  let clock = Math.floor(Date.now() / 1000);
  const members = new Map([
    [source, [viewer.pubkey]],
    [destination, [viewer.pubkey, person.pubkey]],
  ]);
  const published: RelayEvent[] = [];
  let reject = false;
  let hold: Promise<void> | undefined;
  const publish = vi.fn(async (event: RelayEvent) => {
    if (event.kind === 9000) {
      if (hold) await hold;
      if (reject) throw new PublishRejected("Invite refused");
      const channel = event.tags.find((tag) => tag[0] === "h")?.[1] ?? "";
      const key = event.tags.find((tag) => tag[0] === "p")?.[1] ?? "";
      members.set(channel, [
        ...new Set([...(members.get(channel) ?? []), key]),
      ]);
    }
    published.push(event);
    clock++;
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://test.example",
      media: () => undefined,
      query: async (filters: readonly ReadFilter[]) =>
        [
          metadata(relay, source, "Work", clock, [
            ["t", "stream"],
            ["t", "buzz.solo"],
            ["private"],
            ["P", viewer.pubkey],
          ]),
          metadata(relay, destination, "Team", clock, [
            ["t", "stream"],
            ["private"],
          ]),
          ...[source, destination].map((id) =>
            roster(relay, id, members.get(id) ?? [], clock),
          ),
          ...published,
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
      writer: {
        kinds: [9, 9000],
        sign: async (event) => signed(viewer, event),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().channels).toHaveLength(2),
  );
  const link = `buzz://channel/${source}`;
  const key = `draft:${destination}${thread ? `:thread:${root}` : ""}`;
  writeView(owner.session.scope, key, `${link}\n\nPlease look at this`);
  const view = render(
    <MessageComposer
      session={owner.session}
      scope={owner.session.scope}
      channelId={destination}
      channelName="Team"
      {...(thread ? { threadRootId: root } : {})}
    />,
  );
  return {
    view,
    session: owner.session,
    published,
    publish,
    members,
    person,
    late,
    reject(value: boolean) {
      reject = value;
    },
    hold(value: Promise<void>) {
      hold = value;
    },
    addLate() {
      members.get(destination)?.push(late.pubkey);
      clock++;
    },
  };
}

it.each([false, true])(
  "consent grants access before posting exactly once in the selected conversation (thread=%s)",
  async (thread) => {
    const f = await fixture(thread);
    let release!: () => void;
    f.hold(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(
      await screen.findByRole("dialog", { name: "Share access to this chat?" }),
    ).toBeVisible();
    expect(f.publish).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Share and send" }),
    );
    try {
      await waitFor(() => expect(f.publish).toHaveBeenCalled());
      expect(f.published).toHaveLength(0);
      expect(screen.getByRole("button", { name: "Sharing…" })).toBeDisabled();
    } finally {
      await act(async () => release());
    }
    await waitFor(() =>
      expect(f.published.filter((event) => event.kind === 9)).toHaveLength(1),
    );
    expect(f.members.get(source)).toContain(f.person.pubkey);
    expect(f.published.map((event) => event.kind)).toEqual([9000, 9]);
    const message = f.published.find((event) => event.kind === 9);
    expect(message?.content).toContain("Please look at this");
    expect(message?.tags).toContainEqual(["s", source]);
    if (thread) expect(message?.tags).toContainEqual(["e", root, "", "reply"]);
    else expect(message?.tags.some((tag) => tag[0] === "e")).toBe(false);
  },
);

it("link-only leaves access unchanged; cancelling preserves the draft", async () => {
  const f = await fixture(true);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("dialog");
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(f.publish).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveTextContent("Please look at this");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Send link only" }),
  );
  await waitFor(() => expect(f.published).toHaveLength(1));
  expect(f.published[0]?.kind).toBe(9);
  expect(f.members.get(source)).not.toContain(f.person.pubkey);
});

it("retains the captured audience on grant failure and retries the existing receipt before sending", async () => {
  const f = await fixture();
  f.reject(true);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Share and send" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Invite refused");
  expect(f.published).toHaveLength(0);
  const first = f.publish.mock.calls[0]?.[0].id;
  f.addLate();
  f.reject(false);
  await userEvent.click(
    screen.getByRole("button", { name: "Retry share and send" }),
  );
  await waitFor(() =>
    expect(f.published.filter((event) => event.kind === 9)).toHaveLength(1),
  );
  expect(f.published[0]?.id).toBe(first);
  expect(f.members.get(source)).toContain(f.person.pubkey);
  expect(f.members.get(source)).not.toContain(f.late.pubkey);
});

it("blocks competing Share intent but still permits link-only sending", async () => {
  const f = await fixture();
  beginSoloShare(f.session, source, { destination, chatPeople: [] });
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Share and send" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Finish the existing Share operation",
  );
  expect(f.publish).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Send link only" }));
  await waitFor(() => expect(f.published).toHaveLength(1));
  expect(f.published[0]?.kind).toBe(9);
  finishSoloShare(f.session, source);
});

it("does not send the link after leaving while an already-dispatched grant finishes", async () => {
  const f = await fixture(true);
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Share and send" }),
  );
  try {
    await waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
    f.view.unmount();
  } finally {
    await act(async () => release());
  }
  // Wait for the dispatched operation to settle; cancellation doesn't revoke it.
  await waitFor(() => expect(f.published).toHaveLength(1));
  await act(async () => {
    await f.session.outbox?.ready();
  });
  expect(f.published.map((event) => event.kind)).toEqual([9000]);
});
