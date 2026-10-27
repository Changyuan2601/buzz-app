import { expect, it, vi } from "vitest";
import { agentKey } from "./membership";
import { AgentRecords, type Member } from "./records";
import { recordKey } from "./store";
import { memoryStorage } from "./test-fakes";

const pubkey = "a".repeat(64);
const home: Member = {
  key: pubkey,
  pubkey,
  relay: "wss://home.example",
  owner: "b".repeat(64),
  type: "test/agent",
  name: "Ada",
  deleted: false,
};
const away: Member = {
  ...home,
  key: agentKey(pubkey, "https://away.example", "https://home.example"),
  relay: "wss://away.example",
  home: "wss://home.example",
};

function records() {
  const storage = memoryStorage();
  const changed = vi.fn();
  const settled = vi.fn();
  const owner = new AgentRecords(storage, {
    defaults: ({ pubkey }) => ({
      pubkey,
      attention: {},
      config: { model: "a" },
    }),
    changed,
    settled,
  });
  return { storage, owner, changed, settled };
}

it("keeps config in the home record and the rest in the membership's own", async () => {
  const { storage, owner, settled } = records();
  await owner.edit(away.key, {
    kind: "settings",
    member: away,
    change: { config: { model: "b" }, attentionEnabled: true },
  });
  expect(owner.saved(pubkey)?.config).toEqual({ model: "b" });
  expect(owner.saved(away.key)).toMatchObject({
    pubkey: away.key,
    attentionEnabled: true,
    config: undefined,
  });
  expect(
    JSON.parse(storage.get(recordKey(away.key)) ?? "{}"),
  ).not.toHaveProperty("config");
  // The membership sees its agent's config.
  expect(owner.recordOf(away).config).toEqual({ model: "b" });
  expect(settled).toHaveBeenCalledWith(pubkey);
  expect(settled).toHaveBeenCalledWith(away.key);
});

it("applies each edit to the record the one before it saved", async () => {
  const { owner, changed } = records();
  const created = owner.edit(pubkey, {
    kind: "create",
    record: { pubkey, attention: {}, config: { model: "c" } },
  });
  const enabled = owner.edit(pubkey, {
    kind: "settings",
    member: home,
    change: { attentionEnabled: true },
  });
  await Promise.all([created, enabled]);
  expect(owner.saved(pubkey)).toMatchObject({
    config: { model: "c" },
    attentionEnabled: true,
  });
  expect(changed).toHaveBeenCalledTimes(2);
});

it("forgets attention when the agent leaves, and the record when it goes", async () => {
  const { storage, owner } = records();
  await owner.edit(pubkey, {
    kind: "settings",
    member: home,
    change: { attentionEnabled: true },
  });
  await owner.edit(pubkey, { kind: "leave" });
  expect(owner.saved(pubkey)).toEqual({
    pubkey,
    attention: {},
    config: { model: "a" },
  });
  await owner.edit(pubkey, { kind: "remove" });
  expect(owner.saved(pubkey)).toBeUndefined();
  expect(storage.get(recordKey(pubkey))).toBeNull();
});
