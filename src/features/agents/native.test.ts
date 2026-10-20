import { invoke } from "@tauri-apps/api/core";
import { expect, it, vi } from "vitest";
import { hasEventProof } from "../relay/events";
import { keypair, signed } from "../relay/testing";
import { nativeAgents } from "./native";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));

const native = nativeAgents();
if (!native) throw new Error("expected native agents under Tauri");
const agent = keypair();
const message = signed(agent, { kind: 9, content: "hi", tags: [["h", "c"]] });
const query = (response: unknown) => {
  vi.mocked(invoke).mockResolvedValueOnce(response);
  return native.query(agent.pubkey, [{ kinds: [9] }]);
};

it("admits the community's events through the relay verifier", async () => {
  const events = await query([JSON.parse(JSON.stringify(message))]);
  expect(events).toMatchObject([{ id: message.id, content: "hi" }]);
  expect(events.every(hasEventProof)).toBe(true);
  expect(invoke).toHaveBeenCalledWith("app_agent_query", {
    pubkey: agent.pubkey,
    filters: [{ kinds: [9] }],
  });
});

it.each([
  ["a forged signature", [{ ...message, sig: "0".repeat(128) }]],
  ["edited content", [{ ...message, content: "bye" }]],
  ["a malformed record", [{ ...message, tags: "h" }]],
  ["one bad event among good ones", [message, { ...message, kind: 7 }]],
  ["a non-array body", { events: [message] }],
])("rejects %s", async (_, response) => {
  await expect(query(response)).rejects.toThrow(
    /malformed or invalidly signed|not an event array/,
  );
});

it("searches profile names natively and reports a community without the search", async () => {
  const profile = signed(agent, {
    kind: 0,
    content: '{"name":"Wes"}',
    tags: [],
  });
  vi.mocked(invoke).mockResolvedValueOnce([
    JSON.parse(JSON.stringify(profile)),
  ]);
  const found = await native.searchProfiles(agent.pubkey, "wes", 100);
  expect(found).toMatchObject([{ id: profile.id }]);
  expect(found?.every(hasEventProof)).toBe(true);
  expect(invoke).toHaveBeenLastCalledWith("app_agent_search_profiles", {
    pubkey: agent.pubkey,
    query: "wes",
    limit: 100,
  });
  vi.mocked(invoke).mockResolvedValueOnce(null);
  expect(await native.searchProfiles(agent.pubkey, "wes", 100)).toBeUndefined();
  vi.mocked(invoke).mockResolvedValueOnce([
    { ...profile, sig: "0".repeat(128) },
  ]);
  await expect(native.searchProfiles(agent.pubkey, "wes", 100)).rejects.toThrow(
    /malformed or invalidly signed/,
  );
});

it("forwards the typed current-audience query without treating its envelope as events", async () => {
  const destination = "22222222-2222-4222-8222-222222222222";
  const source = "33333333-3333-4333-8333-333333333333";
  const envelope = { audience_authority: 1 };
  vi.mocked(invoke).mockResolvedValueOnce(envelope);
  expect(
    await native.audienceAuthority?.(agent.pubkey, destination, [source]),
  ).toBe(envelope);
  expect(invoke).toHaveBeenLastCalledWith("app_agent_query", {
    pubkey: agent.pubkey,
    filters: [
      {
        kinds: [39000, 39002],
        consistency: "strong",
        audience_authority: { version: 1, destination, sources: [source] },
      },
    ],
  });
});
