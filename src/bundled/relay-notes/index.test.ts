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

it("adds usable agent tools only for the lifetime of the Shared Notes plugin", async () => {
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
      sessionTools(service.tools()).some((tool) => tool.name === "notes_get"),
    ).toBe(false);
    scope = ctx
      .extend({ pluginOwner: { id: "buzz.relay-notes", revision: "bundled" } })
      .plugin({ inject, apply });
    await scope;
    expect(service.tools().map((tool) => tool.name)).toEqual([
      "notes_get",
      "notes_set",
      "notes_rm",
    ]);
    expect(addedKey(service.tools())).not.toBe(before);
    expect(
      sessionTools(service.tools()).some((tool) => tool.name === "notes_get"),
    ).toBe(true);
    await scope.dispose();
    for (const tool of NOTE_TOOLS) {
      expect(
        sessionTools(service.tools()).some(
          (listed) => listed.name === tool.name,
        ),
      ).toBe(false);
    }
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
    await callSessionTool(
      client,
      {},
      "notes_set",
      {
        name: "icon-recipe",
        title: "Icon recipe",
        text: "Draw an icon.",
      },
      NOTE_TOOLS,
    );
    expect(stored[0]).toMatchObject({ pubkey: agent.pubkey, kind: 30023 });
    expect(
      await callSessionTool(
        client,
        {},
        "notes_get",
        {
          name: "icon-recipe",
          author: "me",
        },
        NOTE_TOOLS,
      ),
    ).toContain("Draw an icon.");
    for (const tool of NOTE_TOOLS) {
      await expect(
        callSessionTool(client, {}, tool.name, {}, []),
      ).rejects.toThrow(/No tool/);
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
