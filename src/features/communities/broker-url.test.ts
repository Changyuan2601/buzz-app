import {
  brokerSocket,
  openBrokerSocket,
} from "../../../tests/broker-socket.mjs";
import type { LiveSubscription } from "../relay/live";
import type { RelayEvent } from "../relay/events";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViteDevServer } from "vite";
import { assert, expect, it, vi } from "vitest";
import { verifyEvent } from "nostr-tools";
import { relayBrokerPlugin } from "../../../browser-host/relay-broker.mjs";
import { connectBrokerTransport } from "../relay/transport";
import { keypair } from "../relay/testing";

it("gates arbitrary destinations before discovery/signing and keeps every request bound to its canonical origin", async () => {
  const identity = keypair(),
    relay = keypair();
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const sockets: string[] = [];
  const publications: { url: string; event: RelayEvent }[] = [];
  let traffic: LiveSubscription | undefined;
  let handler: RequestListener | undefined;
  const server = createServer((req, res) => handler?.(req, res));
  const plugin = relayBrokerPlugin({
    archiveFile: ":memory:",
    identity: () => identity.secret,
    socketFactory: (url) => {
      sockets.push(url);
      return brokerSocket((event) => {
        publications.push({ url, event });
        return "";
      }).factory(url);
    },
    // Use production authority discovery too; only upstream I/O is a fixture.
    upstreamFetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/api/join-policy"))
        return Response.json({ policy: null });
      if (url.includes("/media/"))
        return new Response("fixture", {
          headers: { "Content-Type": "image/png" },
        });
      if (!init?.method)
        return Response.json({ name: "Fixture", pubkey: relay.pubkey });
      const body = JSON.parse(String(init.body));
      if (url.endsWith("/events"))
        return Response.json({ accepted: true, event_id: body.id });
      if (url.endsWith("/claim")) return Response.json({ status: "joined" });
      if (url.endsWith("/accept-policy"))
        return Response.json({ receipt: "fixture-receipt" });
      return Response.json([]);
    },
  });
  await (plugin.configureServer as (s: ViteDevServer) => Promise<void>)({
    httpServer: server,
    config: { logger: { info() {}, error() {} } },
    middlewares: {
      use(cb: RequestListener) {
        handler = cb;
      },
    },
  } as unknown as ViteDevServer);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const a = "https://third.example:8443",
    b = "https://fourth.example";
  const endpoint = (id: string, route: string) =>
    `${base}/api/relay/${encodeURIComponent(id)}/${route}`;
  const post = (
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Origin: base, ...headers },
    });
  const nativeFetch = globalThis.fetch;
  try {
    for (const route of ["session", "info", "stream", "media"])
      expect((await fetch(endpoint(a, route))).status).toBe(400);
    for (const route of [
      "query",
      "sign",
      "publish",
      "profile",
      "claim",
      "accept-policy",
    ])
      expect((await post(endpoint(a, route), {})).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(sockets).toHaveLength(0);
    for (const url of [
      "http://third.example",
      "wss://third.example/path",
      "https://user:pw@third.example",
      "https://third.example?",
      "__proto__",
    ])
      expect((await post(`${base}/api/relay/register`, { url })).status).toBe(
        400,
      );
    expect(
      (
        await post(
          `${base}/api/relay/register`,
          { url: a },
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await post(
          `${base}/api/relay/register`,
          { url: a },
          { "Sec-Fetch-Site": "same-site" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/relay/register`, {
          method: "POST",
          body: JSON.stringify({ url: a }),
        })
      ).status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
    const registration = await post(`${base}/api/relay/register`, {
      url: " WSS://THIRD.example:8443/ ",
    });
    expect(await registration.json()).toMatchObject({ id: a, url: a });
    expect(calls).toHaveLength(0); // Registration is local intent, not remote admission.
    expect(
      (
        await fetch(endpoint(a, "session"), {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(endpoint(a, "stream"), {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
    expect(sockets).toHaveLength(0);
    // Node has no browser Origin injection: supply it at the HTTP boundary, not by repairing broker state.
    vi.stubGlobal(
      "fetch",
      (input: string | URL | Request, init?: RequestInit) =>
        nativeFetch(input, {
          ...init,
          headers: {
            ...init?.headers,
            ...(init?.method === "POST" ? { Origin: base } : {}),
          },
        }),
    );
    const transportA = await connectBrokerTransport(
      base,
      undefined,
      "wss://THIRD.example:8443/",
    );
    expect(transportA.scope).toBe(a);
    assert.exists(transportA.writer);
    traffic = await openBrokerSocket(transportA);
    const signed = await transportA.writer.sign(
      {
        kind: 9,
        content: "fixture",
        tags: [["h", "same-channel"]],
        created_at: 1700000000,
      },
      new AbortController().signal,
    );
    const transportB = await connectBrokerTransport(base, undefined, b);
    await transportB.query([{ kinds: [0], limit: 1 }]);
    await transportA.writer.publish(signed, new AbortController().signal);
    await fetch(endpoint(a, "info"));
    await post(endpoint(b, "profile"), {
      name: "Profile",
      picture: "",
      existing: { about: "Kept" },
    });
    await post(endpoint(b, "accept-policy"), {
      code: "fixture",
      policy_version: "v1",
      age_confirmed: true,
    });
    await post(endpoint(b, "claim"), {
      code: "fixture",
      policy_receipt: "fixture-receipt",
    });
    const media = transportA.media(`${a}/media/${"e".repeat(64)}`);
    assert.exists(media);
    expect((await fetch(media)).status).toBe(200);
    expect(
      (
        await fetch(
          endpoint(a, "media") +
            "?url=" +
            encodeURIComponent(`${b}/media/${"e".repeat(64)}`),
        )
      ).status,
    ).toBe(403);
    const stream = new AbortController();
    const response = await fetch(endpoint(a, "stream"), {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ channels: [] }),
      signal: stream.signal,
    });
    expect(response.status).toBe(200);
    expect(sockets).toEqual([
      "wss://third.example:8443",
      "wss://third.example:8443",
    ]);
    stream.abort();
    expect(publications).toEqual([
      {
        url: "wss://third.example:8443",
        event: JSON.parse(JSON.stringify(signed)),
      },
    ]);
    assert.exists(publications[0]);
    expect(verifyEvent(publications[0].event)).toBe(true);
    expect(calls.some((call) => call.url === `${a}/events`)).toBe(false);
    expect(calls.some((call) => call.url === `${b}/query`)).toBe(true);
    expect(calls.some((call) => call.url === `${b}/api/invites/claim`)).toBe(
      true,
    );
    for (const call of calls) {
      expect(call.init?.redirect).toBe("error");
      if (call.init?.method === "POST") {
        const headers = call.init.headers as Record<string, string>;
        assert.exists(headers.Authorization);
        const auth = JSON.parse(
          Buffer.from(headers.Authorization.slice(6), "base64").toString(),
        );
        expect(verifyEvent(auth)).toBe(true);
        expect(auth.tags).toContainEqual(["u", call.url]);
      }
    }
    expect((await fetch(`${base}/api/relay/%E0%A4%A/session`)).status).toBe(
      400,
    );
  } finally {
    traffic?.dispose();
    vi.unstubAllGlobals();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
