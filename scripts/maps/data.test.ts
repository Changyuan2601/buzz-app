import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { EventEmitter } from "node:events";
import { mapStore, querySpec } from "./store.mjs";
import { mapDataPlugin } from "./plugin.mjs";
import { loadDataset } from "../../src/bundled/maps/datasets";
import { loadNote, saveNote, NoteConflict } from "../../src/bundled/maps/notes";
import { INITIAL_MAP } from "../../src/bundled/maps/model";

const scope = `https://localhost:3443:${"a".repeat(64)}`;
const query = {
  source: "square-roster",
  category: "hair_salon",
  bbox: [-123, 37, -122, 38],
  requireAddress: true,
};
const roots: string[] = [];
const servers: Server[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "buzz-maps-"));
  roots.push(path);
  return path;
};
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("local map data boundary", () => {
  it("rejects an external socket even when it spoofs loopback headers", async () => {
    const httpServer = new EventEmitter();
    let handler: (
      req: unknown,
      res: unknown,
      next: () => void,
    ) => Promise<void>;
    const plugin = mapDataPlugin({ root: root(), scope });
    expect(() =>
      plugin.configureServer({ config: { server: { host: "0.0.0.0" } } }),
    ).toThrow("loopback");
    plugin.configureServer({
      httpServer,
      middlewares: {
        use: (value: typeof handler) => {
          handler = value;
        },
      },
    });
    let status = 0;
    try {
      if (!handler) throw new Error("Handler not installed");
      await handler(
        {
          url: "/api/maps/view",
          method: "GET",
          headers: { host: "localhost:1433" },
          socket: { remoteAddress: "203.0.113.1" },
        },
        {
          writeHead: (value: number) => {
            status = value;
          },
          end() {},
        },
        () => {},
      );
      expect(status).toBe(403);
    } finally {
      httpServer.emit("close");
    }
  });

  it("closes the data generator when the viewer cancels an active stream", async () => {
    const directory = root();
    const store = mapStore(join(directory, ".buzz/maps.sqlite"));
    const id = store.create(scope, "map", query);
    store.close();
    let finish!: () => void, release!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const plugin = mapDataPlugin({
      root: directory,
      scope,
      features: async function* (_query: unknown, signal: AbortSignal) {
        try {
          yield {
            type: "Feature",
            properties: { label: "hair_salon" },
            geometry: { type: "Point", coordinates: [0, 0] },
          };
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            const cancel = () => reject(new Error("cancelled"));
            signal.addEventListener("abort", cancel, { once: true });
            if (signal.aborted) cancel();
          });
        } finally {
          finish();
        }
      },
    });
    let handler: (
      req: unknown,
      res: unknown,
      next: () => void,
    ) => Promise<void>;
    const server = createServer(
      (req, res) => void handler(req, res, () => res.end()),
    );
    servers.push(server);
    plugin.configureServer({
      httpServer: server,
      middlewares: {
        use: (value: typeof handler) => {
          handler = value;
        },
      },
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/maps/datasets/${id}?${new URLSearchParams({ scope, channel: "map" })}`,
    );
    if (!response.body) throw new Error("Missing response body");
    const reader = response.body.getReader();
    try {
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      await finished;
    } finally {
      release?.();
      await reader.cancel();
    }
  });
  it("persists references and viewport, isolates channel/viewer, and reopens SQLite", () => {
    const path = join(root(), "maps.sqlite");
    let store = mapStore(path);
    const id = store.create(scope, "map", query);
    store.saveView(scope, "map", { ...INITIAL_MAP, datasets: [id] });
    store.close();
    store = mapStore(path);
    try {
      expect(store.dataset(scope, "map", id)).toEqual(query);
      expect(store.dataset(`${scope}other`, "map", id)).toBeUndefined();
      expect(store.dataset(scope, "other", id)).toBeUndefined();
      expect(store.view(scope, "map").datasets).toEqual([id]);
    } finally {
      store.close();
    }
    expect(() => querySpec({ ...query, bbox: [0, 0, 0, 1] })).toThrow();
  });

  it("streams every record without a result cap; rejects foreign origins and record persistence", async () => {
    const directory = root();
    const store = mapStore(join(directory, ".buzz/maps.sqlite"));
    const id = store.create(scope, "map", query);
    store.close();
    const plugin = mapDataPlugin({
      root: directory,
      scope,
      features: async function* () {
        for (let index = 0; index < 1200; index++)
          yield {
            type: "Feature",
            properties: { label: "hair_salon" },
            geometry: { type: "Point", coordinates: [-122.4, 37.76] },
          };
      },
    });
    let handler: Parameters<typeof createServer>[0];
    const server = createServer((req, res) =>
      (handler as (req: unknown, res: unknown, next: () => void) => void)(
        req,
        res,
        () => res.end(),
      ),
    );
    servers.push(server);
    plugin.configureServer({
      httpServer: server,
      middlewares: {
        use: (value: typeof handler) => {
          handler = value;
        },
      },
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server address");
    const origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/api/maps/datasets/${id}?${new URLSearchParams({ scope, channel: "map" })}`;
    const response = await fetch(url);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1201);
    expect(lines.at(-1)).toEqual({ complete: true, count: 1200 });
    expect(
      (await fetch(url, { headers: { origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
    expect(
      (await fetch(url.replace("channel=map", "channel=other"))).status,
    ).toBe(404);
    const viewUrl = `${origin}/api/maps/view?${new URLSearchParams({ scope, channel: "map" })}`;
    expect(
      (
        await fetch(viewUrl, {
          method: "PUT",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({
            ...INITIAL_MAP,
            markers: [{ coordinates: [1, 1], label: "Seller" }],
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(viewUrl, {
          method: "PUT",
          headers: { origin },
          body: JSON.stringify({ ...INITIAL_MAP, datasets: [id] }),
        })
      ).status,
    ).toBe(200);
    expect((await (await fetch(viewUrl)).json()).view.datasets).toEqual([id]);
  });
});

describe("map dataset client", () => {
  it("delivers names and addresses only as allowlisted renderer properties", async () => {
    const { vi } = await import("vitest");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          [
            JSON.stringify({
              feature: {
                type: "Feature",
                properties: {
                  id: `square-roster:${"e".repeat(64)}`,
                  label: "hair_salon",
                  name: "<b>Example salon</b>",
                  address: "123 Example St",
                  secret: "excluded",
                },
                geometry: { type: "Point", coordinates: [0, 0] },
              },
            }),
            JSON.stringify({ complete: true, count: 1 }),
            "",
          ].join("\n"),
        ),
    );
    try {
      const features = await loadDataset(
        "id",
        scope,
        "map",
        new AbortController().signal,
      );
      expect(features[0].properties).toEqual({
        id: `square-roster:${"e".repeat(64)}`,
        label: "hair_salon",
        name: "<b>Example salon</b>",
        address: "123 Example St",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects an interrupted stream instead of plotting partial data", async () => {
    const { vi } = await import("vitest");
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          `${JSON.stringify({
            feature: {
              type: "Feature",
              properties: { label: "Location" },
              geometry: { type: "Point", coordinates: [0, 0] },
            },
          })}\n`,
        ),
    );
    try {
      await expect(
        loadDataset("id", scope, "map", new AbortController().signal),
      ).rejects.toThrow("interrupted");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("personal retailer notes", () => {
  it("preserves Unicode when request chunks split a multibyte character", async () => {
    const directory = root();
    const httpServer = new EventEmitter();
    let handler!: (
      req: unknown,
      res: unknown,
      next: () => void,
    ) => Promise<void>;
    mapDataPlugin({ root: directory, scope }).configureServer({
      httpServer,
      middlewares: {
        use: (value: typeof handler) => {
          handler = value;
        },
      },
    });
    const location = `square-roster:${"d".repeat(64)}`;
    const text = "Café ☕\nVisit again";
    const body = Buffer.from(JSON.stringify({ text, revision: 0 }));
    const split = body.indexOf(Buffer.from("é")) + 1;
    let status = 0;
    let response = "";
    try {
      await handler(
        {
          url: `/api/maps/note?${new URLSearchParams({ scope, channel: "map", location })}`,
          method: "PUT",
          headers: { host: "localhost:1433", origin: "http://localhost:1433" },
          socket: { remoteAddress: "127.0.0.1" },
          async *[Symbol.asyncIterator]() {
            yield body.subarray(0, split);
            yield body.subarray(split);
          },
        },
        {
          writeHead(value: number) {
            status = value;
          },
          end(value: string) {
            response = value;
          },
        },
        () => {},
      );
      expect(status).toBe(200);
      expect(JSON.parse(response)).toEqual({ text, revision: 1 });
    } finally {
      httpServer.emit("close");
    }
    const reopened = mapStore(join(directory, ".buzz/maps.sqlite"));
    try {
      expect(reopened.note(scope, "map", location).text).toBe(text);
    } finally {
      reopened.close();
    }
  });
  it("persists scoped notes across database reopen without silently replacing concurrent edits", async () => {
    const directory = root(),
      path = join(directory, ".buzz/maps.sqlite");
    const location = `square-roster:${"b".repeat(64)}`;
    const store = mapStore(path);
    expect(store.note(scope, "map", location)).toEqual({
      text: "",
      revision: 0,
    });
    expect(store.saveNote(scope, "map", location, "Visit again", 0)).toEqual({
      text: "Visit again",
      revision: 1,
    });
    store.close();
    const reopened = mapStore(path);
    try {
      expect(reopened.note(scope, "map", location)).toEqual({
        text: "Visit again",
        revision: 1,
      });
      expect(reopened.note(scope, "other", location).text).toBe("");
      expect(reopened.note("other-viewer", "map", location).text).toBe("");
      expect(
        reopened.saveNote(scope, "map", location, "Other window", 1)?.revision,
      ).toBe(2);
      expect(
        reopened.saveNote(scope, "map", location, "Stale edit", 1),
      ).toBeUndefined();
      expect(reopened.note(scope, "map", location).text).toBe("Other window");
      expect(reopened.saveNote(scope, "map", location, "", 2)?.revision).toBe(
        3,
      );
      expect(reopened.note(scope, "map", location)).toEqual({
        text: "",
        revision: 3,
      });
    } finally {
      reopened.close();
    }
  });
  it("exercises note client read/save/conflict and enforces origin, identity and input boundaries", async () => {
    const { vi } = await import("vitest");
    let handler: (
      req: unknown,
      res: unknown,
      next: () => void,
    ) => Promise<void>;
    const server = createServer(
      (req, res) => void handler(req, res, () => res.end()),
    );
    servers.push(server);
    mapDataPlugin({ root: root(), scope }).configureServer({
      httpServer: server,
      middlewares: {
        use: (value: typeof handler) => {
          handler = value;
        },
      },
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server");
    const origin = `http://127.0.0.1:${address.port}`,
      nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (path: string, options: RequestInit = {}) =>
      nativeFetch(new URL(path, origin), {
        ...options,
        headers: {
          ...options.headers,
          ...(options.method === "PUT" ? { origin } : {}),
        },
      }),
    );
    const location = `square-roster:${"c".repeat(64)}`;
    const url = `${origin}/api/maps/note?${new URLSearchParams({ scope, channel: "map", location })}`;
    try {
      const initial = await loadNote(
        scope,
        "map",
        location,
        new AbortController().signal,
      );
      const first = await saveNote(scope, "map", location, {
        ...initial,
        text: "<b>personal note</b>",
      });
      expect(first.revision).toBe(1);
      expect(
        await loadNote(scope, "map", location, new AbortController().signal),
      ).toEqual(first);
      await expect(
        saveNote(scope, "map", location, { ...initial, text: "overwrite" }),
      ).rejects.toBeInstanceOf(NoteConflict);
      expect(
        (
          await nativeFetch(url, {
            method: "PUT",
            headers: { origin: "https://evil.example" },
            body: JSON.stringify(first),
          })
        ).status,
      ).toBe(403);
      expect(
        (await nativeFetch(url.replace("channel=map", "channel=other"))).status,
      ).toBe(200);
      expect(
        await (
          await nativeFetch(url.replace("channel=map", "channel=other"))
        ).json(),
      ).toEqual({ text: "", revision: 0 });
      expect(
        (await nativeFetch(url.replace("scope=", "scope=other"))).status,
      ).toBe(403);
      const invalidLocation = new URL(url);
      invalidLocation.searchParams.set("location", "raw-name-and-address");
      expect((await nativeFetch(invalidLocation)).status).toBe(400);
      expect(
        (
          await nativeFetch(url, {
            method: "PUT",
            headers: { origin },
            body: JSON.stringify({ text: "x", revision: -1 }),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await nativeFetch(url, {
            method: "PUT",
            headers: { origin },
            body: "bad JSON",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await nativeFetch(url, {
            method: "PUT",
            headers: { origin },
            body: JSON.stringify({ text: "x".repeat(65536), revision: 1 }),
          })
        ).status,
      ).toBe(413);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
