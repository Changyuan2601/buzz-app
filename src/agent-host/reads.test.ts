// @vitest-environment node
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import { expect, it, vi } from "vitest";
import type { BuzzClient } from "../buzz-mcp/client";
import { fromOwner, workflowOf } from "../features/agents/owner-attestation";
import { eventDto } from "../features/relay/events";
import { keypair, signed } from "../features/relay/testing";
import { agentReads } from "./reads";

const RELAY = "wss://relay.example";

function setup() {
  const relay = keypair(),
    owner = keypair(),
    sibling = keypair(),
    agent = keypair();
  const attestation = [
    "auth",
    owner.pubkey,
    "",
    bytesToHex(
      schnorr.sign(
        createHash("sha256")
          .update(`nostr:agent-auth:${sibling.pubkey}:`)
          .digest(),
        owner.secret,
      ),
    ),
  ];
  const profile = signed(sibling, {
    kind: 0,
    content: JSON.stringify({ name: "Sibling" }),
    tags: [attestation],
  });
  const query = vi.fn(async () => [profile]);
  const client = { pubkey: agent.pubkey, query } as unknown as BuzzClient;
  const mention = eventDto(
    signed(relay, {
      kind: 9,
      content: "@Agent workflow",
      tags: [
        ["h", "channel"],
        ["p", agent.pubkey],
        ["buzz:workflow", "true"],
        ["buzz:workflow-owner", sibling.pubkey],
        ["buzz:workflow-mention", agent.pubkey],
      ],
    }),
  );
  return { relay, owner, sibling, agent, attestation, client, query, mention };
}

it("accepts a workflow mention from the owner's attested agent, as the app does", async () => {
  const f = setup();
  const reads = agentReads(f.client, RELAY, async () => f.relay.pubkey);
  await vi.waitFor(() =>
    expect(reads.workflowAuthority()).toBe(f.relay.pubkey),
  );
  expect(
    await fromOwner(
      f.mention,
      f.owner.pubkey,
      workflowOf(reads, f.agent.pubkey),
    ),
  ).toBe(true);
  expect(f.query).toHaveBeenCalledWith([
    { kinds: [0], authors: [f.sibling.pubkey], limit: 1 },
  ]);
  expect(reads.name(f.sibling.pubkey, [])).toBe("Sibling");
});

it("ignores workflow mentions until the community gives its key, then asks again", async () => {
  const f = setup();
  const self = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(f.relay.pubkey);
  const reads = agentReads(f.client, RELAY, self);
  await vi.waitFor(() => expect(self).toHaveBeenCalledOnce());
  await Promise.resolve();
  expect(
    await fromOwner(
      f.mention,
      f.owner.pubkey,
      workflowOf(reads, f.agent.pubkey),
    ),
  ).toBe(false);
  await vi.waitFor(() =>
    expect(reads.workflowAuthority()).toBe(f.relay.pubkey),
  );
  expect(self).toHaveBeenCalledTimes(2);
});

it("does not trust a workflow message signed by another key", async () => {
  const f = setup();
  const reads = agentReads(f.client, RELAY, async () => keypair().pubkey);
  await vi.waitFor(() => expect(reads.workflowAuthority()).toBeDefined());
  expect(
    await fromOwner(
      f.mention,
      f.owner.pubkey,
      workflowOf(reads, f.agent.pubkey),
    ),
  ).toBe(false);
});

it("answers a Solo chat at top level from its label, and threads it again once converted", async () => {
  const f = setup();
  const metadata = (tags: string[][]) =>
    signed(f.relay, {
      kind: 39000,
      content: "",
      tags: [["d", "chat"], ["t", "stream"], ["private"], ...tags],
    });
  const signal = new AbortController().signal;
  const reads = agentReads(f.client, RELAY, async () => f.relay.pubkey);
  const solo = () => reads.soloChat(f.owner.pubkey, "chat", signal);

  f.query.mockResolvedValueOnce([metadata([["t", "buzz.solo"]])]);
  expect(await solo()).toBe(true);
  expect(f.query).toHaveBeenLastCalledWith([
    { kinds: [39000], "#d": ["chat"], limit: 1 },
  ]);
  // Converted to a channel: the label is gone, so mentions keep their threads.
  f.query.mockResolvedValueOnce([metadata([])]);
  expect(await solo()).toBe(false);
  // An unknown channel is not Solo; a failed read fails rather than guess.
  f.query.mockResolvedValueOnce([]);
  expect(await solo()).toBe(false);
  f.query.mockRejectedValueOnce(new Error("offline"));
  await expect(solo()).rejects.toThrow("offline");
});

it("hands over a Solo chat's Canvas only from its owner's side, and says when there is none", async () => {
  const f = setup();
  const reads = agentReads(f.client, RELAY, async () => f.relay.pubkey);
  const canvas = (author: ReturnType<typeof keypair>, tags: string[][] = []) =>
    signed(author, {
      kind: 40100,
      content: `# By ${author.pubkey.slice(0, 4)}`,
      tags: [["h", "chat"], ...tags],
    });
  const read = () => reads.canvas?.("chat", f.owner.pubkey);

  f.query.mockResolvedValueOnce([canvas(f.owner)]);
  expect(await read()).toBe(`# By ${f.owner.pubkey.slice(0, 4)}`);
  expect(f.query).toHaveBeenLastCalledWith([
    { kinds: [40100], "#h": ["chat"], limit: 1 },
  ]);
  // The owner's attested agent writes for the owner.
  f.query.mockResolvedValueOnce([canvas(f.sibling, [f.attestation])]);
  expect(await read()).toBe(`# By ${f.sibling.pubkey.slice(0, 4)}`);
  // A member's head is not the owner's instructions.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  f.query.mockResolvedValueOnce([canvas(keypair())]);
  expect(await read()).toBeUndefined();
  warn.mockRestore();
  // No Canvas is a confirmed empty; a failed read rejects instead.
  f.query.mockResolvedValueOnce([]);
  expect(await read()).toBeUndefined();
  f.query.mockRejectedValueOnce(new Error("offline"));
  await expect(read()).rejects.toThrow("offline");
});
