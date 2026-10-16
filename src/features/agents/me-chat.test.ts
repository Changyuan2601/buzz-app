import { expect, it, vi } from "vitest";
import type { RelayData } from "../relay/service";
import { meChat, ownerDm } from "./me-chat";

const owner = "a".repeat(64),
  self = "c".repeat(64);
type Status = "idle" | "loading" | "ready" | "error" | "unavailable";

function community({
  viewer = owner,
  status = "ready" as Status,
  personal = ["chat"],
  refreshed = status,
}: {
  viewer?: string;
  status?: Status;
  personal?: string[];
  refreshed?: Status;
} = {}) {
  let state = status;
  const placement = {
    snapshot: () => ({
      status: state,
      ...(state === "error" ? { error: "Recipe read failed" } : {}),
    }),
    refresh: vi.fn(async () => {
      state = refreshed;
    }),
    has: (id: string) => state === "ready" && personal.includes(id),
  };
  const session = {
    mePlacement: placement,
    channels: {
      list: () => ({
        channels: [
          { id: "chat", channelType: "stream" },
          { id: "dm", channelType: "dm", members: [owner, self] },
        ],
      }),
    },
  };
  let snapshot: Record<string, unknown> = {
    status: "ready",
    scope: "https://relay.test:owner",
    viewer,
    session,
  };
  const relay = { snapshot: () => snapshot } as unknown as RelayData;
  return {
    relay: () => relay,
    placement,
    change(next: Record<string, unknown>) {
      snapshot = { ...snapshot, ...next };
    },
  };
}
const signal = new AbortController().signal;

it("is the owner's Me chat only when the owner's placement holds it", async () => {
  const { relay } = community();
  await expect(meChat(relay, owner, "chat", signal)).resolves.toBe(true);
  await expect(meChat(relay, owner, "other", signal)).resolves.toBe(false);
  // DMs keep their own routing even if filed.
  const filedDm = community({ personal: ["dm"] });
  await expect(meChat(filedDm.relay, owner, "dm", signal)).resolves.toBe(false);
  // Another member's filing never decides how the owner's agent posts.
  const other = community({ viewer: "b".repeat(64) });
  await expect(meChat(other.relay, owner, "chat", signal)).resolves.toBe(false);
  // A host without Me has only Messages.
  const none = community({ status: "unavailable" });
  await expect(meChat(none.relay, owner, "chat", signal)).resolves.toBe(false);
});

it("reads a placement that is not ready before deciding", async () => {
  const { relay, placement } = community({
    status: "idle",
    refreshed: "ready",
  });
  await expect(meChat(relay, owner, "chat", signal)).resolves.toBe(true);
  expect(placement.refresh).toHaveBeenCalledOnce();
});

it("fails rather than guess Messages when the placement cannot be read", async () => {
  const { relay } = community({ status: "error" });
  await expect(meChat(relay, owner, "chat", signal)).rejects.toThrow(
    "Recipe read failed",
  );
});

it("fails when the community changes while the placement is read", async () => {
  const fixture = community({ status: "idle", refreshed: "ready" });
  fixture.placement.refresh.mockImplementationOnce(async () => {
    fixture.change({ scope: "https://relay.test:someone" });
  });
  await expect(meChat(fixture.relay, owner, "chat", signal)).rejects.toThrow(
    "The community changed",
  );
});

it("uses the exact owner/agent DM at top level without consulting Solo placement", async () => {
  const f = community({ status: "unavailable" });
  expect(await meChat(f.relay, owner, "dm", signal, self)).toBe(true);
  expect(f.placement.refresh).not.toHaveBeenCalled();
});
it.each([
  { channelType: "stream" },
  { members: [owner, self, "b".repeat(64)] },
  { members: [owner] },
  { members: [self, "b".repeat(64)] },
  { archived: true },
  { cached: true },
  { readOnly: true },
  { parentChannelId: "parent" },
])(
  "keeps non-direct or unavailable conversations outside the owner DM policy: %j",
  (change) => {
    const channel = {
      id: "dm",
      name: "DM",
      channelType: "dm" as const,
      members: [owner, self],
      ...change,
    };
    expect(ownerDm(channel as never, owner, self)).toBe(false);
  },
);
