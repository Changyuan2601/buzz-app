import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { verifyEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { keypair, signed } from "../features/relay/testing";
import type { BuzzEvent, Filter } from "./client";
import { nodeClient } from "./node";
import { respond } from "./rpc";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

it("guards signed sends through MCP and a loopback HTTP relay, then permits reconsideration and continuation", async () => {
  const user = keypair();
  const first = signed(user, {
    kind: 9,
    content: "Question",
    created_at: 1,
    tags: [["h", "channel"]],
  });
  const events: BuzzEvent[] = [first];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    if (request.url === "/events") {
      expect(verifyEvent(input)).toBe(true);
      events.push(input);
      response.end(JSON.stringify({ accepted: true }));
    } else {
      const filters = input as Filter[];
      response.end(
        JSON.stringify(
          events.filter((event) =>
            filters.some((filter) =>
              Object.entries(filter).every(([key, value]) => {
                if (key === "kinds")
                  return (value as number[]).includes(event.kind);
                if (key === "ids")
                  return (value as string[]).includes(event.id);
                if (key.startsWith("#"))
                  return event.tags.some(
                    (tag) =>
                      tag[0] === key.slice(1) &&
                      (value as string[]).includes(tag[1] ?? ""),
                  );
                return true;
              }),
            ),
          ),
        ),
      );
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const relay = `ws://127.0.0.1:${address.port}`;
  const clients = [keypair(), keypair()].map((agent) =>
    nodeClient({ relay, key: bytesToHex(agent.secret), root: "/" }),
  );
  const call = async (
    index: number,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const reply = await respond(
      clients[index],
      { channel: "channel" },
      { id: 1, method: "tools/call", params: { name, arguments: args } },
    );
    if (!("result" in reply)) throw new Error(JSON.stringify(reply.error));
    return reply.result as { isError?: boolean; content: { text: string }[] };
  };
  const sends = await Promise.all(
    clients.map((_, index) =>
      call(index, "send", {
        audience: "everyone",
        text: `Answer ${index}`,
        cursor: first.id,
      }),
    ),
  );
  expect(sends.map((result) => result.isError === true)).toEqual([false, true]);
  expect(events).toHaveLength(2);
  expect(sends[1]?.content[0]?.text).toContain("Answer 0");
  const view = await call(1, "read", {});
  const cursor = view.content[0]?.text.match(/cursor ([a-f0-9]{64})/)?.[1];
  const revised = await call(1, "send", {
    audience: "everyone",
    text: "Additional detail after reading the first answer",
    cursor,
  });
  expect(revised.isError).not.toBe(true);
  const next = revised.content[0]?.text.match(/cursor ([a-f0-9]{64})/)?.[1];
  expect(
    (
      await call(1, "send", {
        audience: "everyone",
        text: "Continuation",
        cursor: next,
      })
    ).isError,
  ).not.toBe(true);
  expect(events).toHaveLength(4);
});
