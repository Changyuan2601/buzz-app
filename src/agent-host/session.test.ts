// @vitest-environment node
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools/pure";
import { afterEach, expect, it, vi } from "vitest";
import type { NativeCall } from "../features/agents/native";
import { connectAgentSession } from "./session";

/** A relay connection the test answers by hand. */
class Socket {
  static last: Socket | undefined;
  readyState = 1;
  onmessage?: (event: { data: string }) => Promise<void>;
  onclose?: () => void;
  onerror?: () => void;
  readonly sent: unknown[][] = [];
  constructor() {
    Socket.last = this;
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as unknown[]);
  }
  close() {
    this.readyState = 3;
  }
  async receive(message: unknown[]) {
    await this.onmessage?.({ data: JSON.stringify(message) });
  }
}

afterEach(() => vi.unstubAllGlobals());

it("signs in and reads through the app's custody, and publishes nothing", async () => {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const auth = ["auth", "b".repeat(64), "", "f".repeat(128)];
  const posted: { path: string; headers: Headers }[] = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== "POST")
        return Response.json({ self: "c".repeat(64) });
      posted.push({
        path: new URL(url).pathname,
        headers: new Headers(init.headers),
      });
      return Response.json([]);
    }),
  );
  const relay = "wss://relay.example.test";
  // The app's custody, as `agent_host.rs` answers: it signs with the key.
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const call = (async (command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    if (command === "app_agent_login")
      return finalizeEvent(
        {
          kind: 22242,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", String(args?.relay)],
            ["challenge", String(args?.challenge)],
            auth,
          ],
        },
        secret,
      );
    if (command === "app_agent_read_auth")
      return { authorization: "Nostr signed", authTag: JSON.stringify(auth) };
    throw new Error(`Unexpected ${command}`);
  }) as NativeCall;
  const { session, relay: data } = await connectAgentSession({
    relay,
    pubkey,
    call,
    scope: "scope",
  });
  try {
    const socket = Socket.last as Socket;
    await socket.receive(["AUTH", "challenge"]);
    const login = socket.sent.find((message) => message[0] === "AUTH")?.[1] as
      | { id: string; pubkey: string; tags: string[][] }
      | undefined;
    expect(login?.pubkey).toBe(pubkey);
    expect(verifyEvent(login as never)).toBe(true);
    expect(login?.tags).toContainEqual(auth);
    expect(calls[0]).toEqual([
      "app_agent_login",
      { pubkey, relay, challenge: "challenge" },
    ]);
    await socket.receive(["OK", login?.id, true, ""]);
    await vi.waitFor(() =>
      expect(session.live.snapshot().status).toBe("connected"),
    );
    expect(session.workflowAuthority).toBe("c".repeat(64));
    // The session has no writer, and its socket no publishing.
    expect(
      await session.publishAgentPresence(
        "online",
        [pubkey],
        new AbortController().signal,
      ),
    ).toBe(false);
    expect(socket.sent.filter((message) => message[0] === "EVENT")).toEqual([]);
    expect(posted.map(({ path }) => path)).not.toContain("/events");
    // Its reads carry the headers custody signed for each one.
    await session.read([{ kinds: [9], "#h": ["c"], limit: 1 }], {
      signal: new AbortController().signal,
    });
    const reads = calls.filter(
      ([command]) => command === "app_agent_read_auth",
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const [, args] of reads)
      expect(args?.url).toBe("https://relay.example.test/query");
    expect(posted.length).toBe(reads.length);
    for (const { headers } of posted) {
      expect(headers.get("authorization")).toBe("Nostr signed");
      expect(headers.get("x-auth-tag")).toBe(JSON.stringify(auth));
    }
  } finally {
    data.disconnect();
  }
});
