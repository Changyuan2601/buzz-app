import { expect, it } from "vitest";
import { DiscoveryState } from "./discovery";
import { keypair, metadata, roster, signed } from "./testing";
import { huddleDescription } from "../huddle/lifecycle";
const creator = keypair(),
  relay = keypair(),
  admin = keypair();
const room = "00000000-0000-4000-8000-000000000002";
const parent = "00000000-0000-4000-8000-000000000001";
const tags = [
  ["h", room],
  ["visibility", "private"],
  ["channel_type", "stream"],
  ["about", huddleDescription(parent)],
];
const receipt = (key = creator, extra = tags) =>
  signed(key, { kind: 9007, created_at: 10, content: "", tags: extra });
const info = (at = 20, about = huddleDescription(parent)) =>
  metadata(relay, room, "Huddle", at, [
    ["P", creator.pubkey],
    ["private"],
    ["t", "stream"],
    ["ttl", "3600"],
    ["about", about],
  ]);
function state() {
  const state = new DiscoveryState(admin.pubkey, relay.pubkey);
  state.accept(roster(relay, room, [admin.pubkey]));
  state.accept(info());
  return state;
}
it("keeps mutable markers and legacy names ordinary until creator proof arrives", () => {
  const owner = state();
  expect(owner.get(room)?.huddle).toBeUndefined();
  expect(owner.channels().map((c) => c.id)).toContain(room);
  expect(owner.accept(receipt(admin))).toBe(false);
  expect(owner.accept(receipt(creator, [...tags, ["h", room]]))).toBe(false);
  expect(owner.get(room)?.huddle).toBeUndefined();
  expect(owner.accept(receipt())).toBe(true);
  expect(owner.get(room)).toMatchObject({
    huddle: true,
    parentChannelId: parent,
  });
  owner.accept(info(30, "An admin changed the description"));
  expect(owner.get(room)).toMatchObject({
    huddle: true,
    parentChannelId: parent,
  });
});
it("does not promote an ordinary creation when later metadata gains a Huddle marker", () => {
  const owner = state();
  expect(
    owner.accept(
      receipt(
        creator,
        tags.filter(([name]) => name !== "about"),
      ),
    ),
  ).toBe(false);
  expect(owner.get(room)?.huddle).toBeUndefined();
});
it("restores signed proof with cached membership, without granting write access", () => {
  const owner = state();
  owner.accept(receipt());
  const restored = new DiscoveryState(admin.pubkey, relay.pubkey);
  for (const event of owner.savedEvents()) restored.accept(event, true);
  expect(restored.get(room)).toMatchObject({
    huddle: true,
    parentChannelId: parent,
    readOnly: true,
  });
  restored.clearCached();
  expect(restored.get(room)).toBeUndefined();
});
