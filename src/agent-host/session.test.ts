// @vitest-environment node
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, expect, it, vi } from "vitest";
import { nodeClient } from "../buzz-mcp/node";
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

it("signs in as the agent with its owner's attestation, and publishes nothing", async () => {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  const auth = ["auth", "b".repeat(64), "", "f".repeat(128)];
  const posted: string[] = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== "POST")
        return Response.json({ self: "c".repeat(64) });
      posted.push(new URL(url).pathname);
      return Response.json([]);
    }),
  );
  const relay = "wss://relay.example.test";
  const { session, relay: data } = await connectAgentSession({
    relay,
    secret,
    pubkey,
    auth,
    client: nodeClient({
      relay,
      key: Buffer.from(secret).toString("hex"),
      auth: JSON.stringify(auth),
      root: "/tmp",
    }),
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
    expect(posted).not.toContain("/events");
  } finally {
    data.disconnect();
  }
});
