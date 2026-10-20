import { Context } from "@deepseek-ai/cordis";
import { expect, it, vi } from "vitest";
import { bytesToHex } from "nostr-tools/utils";
import { AgentsService } from "../../features/agents/service";
import {
  fakeCommunities,
  fakeRelay,
  fakeNative,
} from "../../features/agents/service-testing";
import { memoryStorage } from "../../features/agents/test-fakes";
import { keypair } from "../../features/relay/testing";
import { nodeClient } from "../../buzz-mcp/node";
import {
  addedKey,
  callSessionTool,
  sessionTools,
} from "../../buzz-mcp/session-tools";
import { apply, inject, NOTE_TOOLS } from ".";

it("adds usable agent tools only for the lifetime of the Relay Notes plugin", async () => {
  const ctx = new Context();
  ctx.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const service = new AgentsService(
    ctx,
    fakeCommunities(fakeRelay()).communities,
    fakeNative(),
    memoryStorage(),
  );
  let scope: ReturnType<Context["plugin"]> | undefined;
  try {
    const before = addedKey(service.tools());
    expect(
      sessionTools(service.tools()).some((tool) => tool.name === "note"),
    ).toBe(false);
    scope = ctx
      .extend({ pluginOwner: { id: "buzz.relay-notes", revision: "bundled" } })
      .plugin({ inject, apply });
    await scope;
    expect(service.tools().map((tool) => tool.name)).toEqual(["notes", "note"]);
    expect(addedKey(service.tools())).not.toBe(before);
    expect(
      sessionTools(service.tools()).some((tool) => tool.name === "note"),
    ).toBe(true);
    await scope.dispose();
    expect(service.tools()).toEqual([]);
    expect(addedKey(service.tools())).toBe(before);
  } finally {
    await scope?.dispose();
    await ctx.fiber.dispose();
  }
});

it("publishes and reads a signed recipe through plugin session dispatch", async () => {
  const agent = keypair();
  const stored: object[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/events")) {
      stored.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ accepted: true }));
    }
    return new Response(JSON.stringify(stored));
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    const client = nodeClient({
      relay: "wss://relay.test",
      key: bytesToHex(agent.secret),
      root: "/",
    });
    const saved = JSON.parse(
      (await callSessionTool(
        client,
        {},
        "note",
        {
          action: "save",
          note: "icons",
          title: "Frosted icons",
          expected_event: "absent",
          text: 'Make an individual "{{icon_description}}" icon.\n\nStyle summary.',
        },
        NOTE_TOOLS,
      )) as string,
    );
    expect(saved.status).toBe("confirmed");
    expect(stored[0]).toMatchObject({
      pubkey: agent.pubkey,
      kind: 30023,
      tags: [
        ["d", "icons"],
        ["title", "Frosted icons"],
      ],
    });
    const loaded = JSON.parse(
      (await callSessionTool(
        client,
        {},
        "note",
        { note: saved.naddr },
        NOTE_TOOLS,
      )) as string,
    );
    expect(loaded).toMatchObject({
      event_id: saved.event_id,
      text: 'Make an individual "{{icon_description}}" icon.\n\nStyle summary.',
    });
    stored[0] = { ...stored[0], content: "tampered" };
    await expect(
      callSessionTool(client, {}, "note", { note: saved.naddr }, NOTE_TOOLS),
    ).rejects.toThrow(/invalidly signed/);
    await expect(
      callSessionTool(client, {}, "note", { note: saved.naddr }, []),
    ).rejects.toThrow(/No tool/);
  } finally {
    vi.unstubAllGlobals();
  }
});
