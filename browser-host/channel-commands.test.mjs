import { expect, it } from "vitest";
import { validChannelCommand } from "./channel-commands.mjs";
const id = "11111111-1111-4111-8111-111111111111";
it("allows only ordinary invitations, without extra roles", () => {
  const invite = {
    kind: 9000,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["p", "a".repeat(64)],
    ],
  };
  expect(validChannelCommand(invite)).toBe(true);
  expect(
    validChannelCommand({
      ...invite,
      tags: [...invite.tags, ["role", "admin"]],
    }),
  ).toBe(false);
  expect(validChannelCommand({ ...invite, kind: 9001 })).toBe(false);
});

it("admits stream and NIP-CL system channel creation only", () => {
  const create = (type) => ({
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "For You records"],
      ["visibility", "private"],
      ["channel_type", type],
      ["t", "for-you"],
    ],
  });
  expect(validChannelCommand(create("stream"))).toBe(true);
  expect(validChannelCommand(create("system"))).toBe(true);
  for (const type of ["dm", "forum", "session", "System", ""])
    expect(validChannelCommand(create(type))).toBe(false);
});

it("creates a Solo chat with its label, an optional description and lifetime", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["t", "buzz.solo"],
    ],
  };
  expect(validChannelCommand(create)).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags.slice(0, 4), ["about", "Notes"], create.tags[4]],
    }),
  ).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags.slice(0, 4), ["ttl", "604800"], create.tags[4]],
    }),
  ).toBe(true);
  for (const [index, value] of [
    [3, "dm"],
    [1, " "],
  ]) {
    expect(
      validChannelCommand({
        ...create,
        tags: create.tags.map((tag, i) =>
          i === index ? [tag[0], value] : tag,
        ),
      }),
    ).toBe(false);
  }
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags, ["p", "a".repeat(64)]],
    }),
  ).toBe(false);
  expect(validChannelCommand({ ...create, content: "extra" })).toBe(false);
});

it("accepts one trailing outbox identifier for invitations and rejects ambiguous envelopes", () => {
  const invite = (tags) => ({ kind: 9000, created_at: 1, content: "", tags });
  const h = ["h", id],
    p = ["p", "a".repeat(64)],
    client = ["client-id", id];
  expect(validChannelCommand(invite([h, p, client]))).toBe(true);
  for (const tags of [
    [h, p, client, client],
    [client, h, p],
    [h, p, ["client-id", "invalid"]],
    [h, p, [...client, "extra"]],
  ])
    expect(validChannelCommand(invite(tags))).toBe(false);
});

it("allows bounded ordinary stream creation and rejects malformed TTL", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Release notes"],
      ["visibility", "open"],
      ["channel_type", "stream"],
      ["about", "Updates for the team"],
    ],
  };
  expect(validChannelCommand(create)).toBe(true);
  expect(
    validChannelCommand({ ...create, tags: create.tags.slice(0, 4) }),
  ).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: create.tags.map((tag) =>
        tag[0] === "about" ? ["about", "x".repeat(1001)] : tag,
      ),
    }),
  ).toBe(false);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags, ["ttl", "604800"]],
    }),
  ).toBe(true);
  expect(
    validChannelCommand({
      ...create,
      tags: [...create.tags.slice(0, 4), ["ttl", "604800"]],
    }),
  ).toBe(true);
  for (const tags of [
    [...create.tags, ["buzz-space", "personal"]],
    [...create.tags.slice(0, 4), ["ttl", "60"], create.tags[4]],
    [...create.tags, ["about", "Again"]],
  ])
    expect(validChannelCommand({ ...create, tags })).toBe(false);
  for (const ttl of [
    "",
    "0",
    "01",
    "+1",
    "1\n",
    "-1",
    "forever",
    "2147483648",
  ]) {
    expect(
      validChannelCommand({
        ...create,
        tags: [...create.tags, ["ttl", ttl]],
      }),
    ).toBe(false);
  }
});

it("rejects every truncated mandatory creation-tag prefix", () => {
  const create = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Release notes"],
      ["visibility", "open"],
      ["channel_type", "stream"],
    ],
  };
  for (let length = 0; length < create.tags.length; length++)
    expect(
      validChannelCommand({ ...create, tags: create.tags.slice(0, length) }),
    ).toBe(false);
});

it("admits NIP-CL labels at the end of a channel creation, before the client id", () => {
  const create = (labels) => ({
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Records"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ["about", "For You records"],
      ...labels,
      ["client-id", "22222222-2222-4222-8222-222222222222"],
    ],
  });
  expect(validChannelCommand(create([]))).toBe(true);
  expect(
    validChannelCommand(
      create([
        ["t", "for-you"],
        ["t", "app:records"],
      ]),
    ),
  ).toBe(true);
  for (const labels of [
    [["t", "system"]],
    [["t", "Upper"]],
    [["t", ""]],
    [
      ["t", "a"],
      ["t", "a"],
    ],
    [
      ["t", "a"],
      ["about", "late"],
    ],
    Array.from({ length: 9 }, (_, n) => ["t", `l${n}`]),
  ])
    expect(validChannelCommand(create(labels))).toBe(false);
});

it("admits an exact creation-time source before labels, never malformed or duplicate sources", () => {
  const base = {
    kind: 9007,
    created_at: 1,
    content: "",
    tags: [
      ["h", id],
      ["name", "Work"],
      ["visibility", "private"],
      ["channel_type", "stream"],
    ],
  };
  const source = ["origin", id, "a".repeat(64), "b".repeat(64)];
  expect(
    validChannelCommand({
      ...base,
      tags: [...base.tags, source, ["t", "buzz.solo"]],
    }),
  ).toBe(true);
  for (const tags of [
    [...base.tags, source, source],
    [...base.tags, ["origin", id, "bad"]],
    [...base.tags, ["origin", id, "a".repeat(64), "a".repeat(64)]],
    [...base.tags, ["t", "buzz.solo"], source],
  ]) {
    expect(validChannelCommand({ ...base, tags })).toBe(false);
  }
});
