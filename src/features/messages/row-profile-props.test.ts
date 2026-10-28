import { expect, it } from "vitest";
import type { ChannelMessage, Profile } from "../relay/contracts";
import type { MessageRowProps } from "./MessageRow";
import { sameRowProps } from "./row-profile-props";

const author = "a".repeat(64);
const mentioned = "b".repeat(64);
const other = "c".repeat(64);
const row: ChannelMessage = {
  id: "row",
  channelId: "channel",
  authorId: author,
  content: "Hello",
  createdAt: 1,
  mentions: [mentioned],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
const profile = (name: string, isAgent = false): Profile =>
  ({ pubkey: name, name, isAgent }) as unknown as Profile;
const alice = profile("Alice");
const bob = profile("Bob");
const media = () => undefined;
const onOpenLink = () => true;
const props = (
  entries: [string, Profile][],
  agents: string[] = [],
  overrides: Partial<MessageRowProps> = {},
): MessageRowProps => ({
  row,
  profile: alice,
  participantProfiles: new Map(entries),
  agentPubkeys: new Set(agents),
  media,
  onOpenLink,
  day: false,
  retry: undefined,
  ...overrides,
});

it("ignores profiles and agents the row does not read", () => {
  expect(
    sameRowProps(
      props([[author, alice]]),
      props(
        [
          [author, alice],
          [other, bob],
        ],
        [other],
      ),
    ),
  ).toBe(true);
});

it("re-renders when an identity the row reads changes", () => {
  const before = props([[author, alice]]);
  expect(sameRowProps(before, props([[author, profile("Alice")]]))).toBe(false);
  expect(
    sameRowProps(
      before,
      props([
        [author, alice],
        [mentioned, bob],
      ]),
    ),
  ).toBe(false);
  expect(sameRowProps(before, props([[author, alice]], [author]))).toBe(false);
  expect(sameRowProps(before, props([]))).toBe(false);
});

it("compares every other prop by identity", () => {
  const entries: [string, Profile][] = [[author, alice]];
  expect(
    sameRowProps(
      props(entries, [], { day: false }),
      props(entries, [], { day: true }),
    ),
  ).toBe(false);
  expect(
    sameRowProps(props(entries), props(entries, [], { row: { ...row } })),
  ).toBe(false);
  expect(
    sameRowProps(props(entries), props(entries, [], { stackNext: true })),
  ).toBe(false);
});

it("re-renders for any change when the text links a profile or a map appears", () => {
  const linked = { ...row, content: "See nostr:npub1qqqq" };
  expect(
    sameRowProps(
      props([[author, alice]], [], { row: linked }),
      props(
        [
          [author, alice],
          [other, bob],
        ],
        [],
        { row: linked },
      ),
    ),
  ).toBe(false);
  const { participantProfiles: _, ...withoutMap } = props([]);
  expect(sameRowProps(withoutMap, props([]))).toBe(false);
});
