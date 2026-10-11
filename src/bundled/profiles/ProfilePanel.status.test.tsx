// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReadFilter, RelayEvent } from "../../features/relay/events";
import { createRelaySession } from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { keypair, signed, type Key } from "../../features/relay/testing";
import { profileTarget } from "../../features/profiles/target";
import { ProfilePanel } from "./ProfilePanel";
import styles from "../../features/user-status/Status.module.css";

afterEach(cleanup);
const viewer = keypair();
const relayAuthor = keypair();
const status = (
  key: Key,
  content: string,
  created_at: number,
  tags: string[][] = [],
) =>
  signed(key, {
    kind: 30315,
    content,
    created_at,
    tags: [["d", "general"], ...tags],
  });

function fixture(
  statuses: (filter: ReadFilter) => Promise<readonly RelayEvent[]>,
) {
  const reads: ReadFilter[] = [];
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relayAuthor.pubkey,
    scope: "https://relay.example.test",
    media: () => undefined,
    query: async (filters) => {
      const filter = filters.find((item) => item.kinds?.includes(30315));
      if (!filter) return [];
      reads.push(filter);
      return [...(await statuses(filter))];
    },
  });
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: `https://relay.example.test:${viewer.pubkey}`,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const panel = (key: Key) => (
    <ProfilePanel
      relay={relay}
      target={profileTarget(key.pubkey) ?? ""}
      close={() => {}}
    />
  );
  return { owner, reads, panel };
}

it("shows the newest self-published general status with its emoji", async () => {
  const person = keypair();
  const f = fixture(async () => [
    status(person, "Old", 1),
    status(person, "In a meeting", 2, [["emoji", "📅"]]),
  ]);
  try {
    render(f.panel(person));
    expect(await screen.findByText("In a meeting")).toBeTruthy();
    expect(document.querySelector(`.${styles.status}`)?.textContent).toBe(
      "📅 In a meeting",
    );
    expect(screen.getByText("📅")).toBeTruthy();
    expect(screen.queryByText("Old")).toBeNull();
    expect(f.reads).toEqual([
      expect.objectContaining({
        kinds: [30315],
        authors: [person.pubkey],
        "#d": ["general"],
        limit: 1,
      }),
    ]);
  } finally {
    f.owner.dispose();
  }
});

it.each([
  ["a cleared status", async (person: Key) => [status(person, "  ", 2)]],
  ["another author's status", async () => [status(keypair(), "Spoofed", 2)]],
  [
    "a failed read",
    async () => {
      throw new Error("offline");
    },
  ],
])("shows no status for %s", async (_name, result) => {
  const person = keypair();
  const read = vi.fn(() => result(person));
  const f = fixture(read);
  try {
    render(f.panel(person));
    await waitFor(() => expect(read).toHaveBeenCalled());
    await act(async () => {
      await read.mock.results[0]?.value.catch(() => {});
    });
    expect(screen.queryByText("Spoofed")).toBeNull();
    expect(document.querySelector(`.${styles.status}`)).toBeNull();
  } finally {
    f.owner.dispose();
  }
});

it("ignores a late status after switching profiles", async () => {
  const first = keypair();
  const second = keypair();
  let release = () => {};
  const f = fixture(async (filter) =>
    filter.authors?.includes(first.pubkey)
      ? new Promise((resolve) => {
          release = () => resolve([status(first, "Stale", 2)]);
        })
      : [status(second, "Current", 2)],
  );
  try {
    const view = render(f.panel(first));
    await waitFor(() => expect(f.reads).toHaveLength(1));
    view.rerender(f.panel(second));
    await act(async () => release());
    expect(await screen.findByText("Current")).toBeTruthy();
    expect(screen.queryByText("Stale")).toBeNull();
  } finally {
    f.owner.dispose();
  }
});
