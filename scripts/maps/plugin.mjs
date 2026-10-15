import { join } from "node:path";
import { once } from "node:events";
import { mapStore } from "./store.mjs";
import { rosterFeatures } from "./roster.mjs";
import { parseMap } from "../../src/bundled/maps/model.ts";

export function mapDataPlugin({ root, scope, features = rosterFeatures }) {
  return {
    name: "buzz-local-map-data",
    apply: "serve",
    config: () => ({
      define: {
        "import.meta.env.VITE_BUZZ_MAP_DATA": JSON.stringify("1"),
        "import.meta.env.VITE_BUZZ_MAP_TOOL": JSON.stringify(
          join(root, "scripts/maps/publish.mjs"),
        ),
      },
    }),
    configureServer(server) {
      if (
        server.config?.server.host &&
        !["127.0.0.1", "localhost", "::1"].includes(server.config.server.host)
      )
        throw new Error("Maps data requires a loopback-only dev server");
      const store = mapStore(join(root, ".buzz/maps.sqlite"));
      server.httpServer?.once("close", () => store.close());
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/maps/")) return next();
        const origin = `http://${req.headers.host ?? ""}`;
        const reply = (status, body) => {
          res.writeHead(status, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(body));
        };
        if (
          !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
            req.socket.remoteAddress ?? "",
          ) ||
          !/^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host ?? "") ||
          (req.headers.origin && req.headers.origin !== origin) ||
          (req.headers["sec-fetch-site"] &&
            req.headers["sec-fetch-site"] !== "same-origin") ||
          (req.method === "PUT" && req.headers.origin !== origin)
        )
          return reply(403, { error: "Origin rejected" });
        const url = new URL(req.url, origin);
        const channel = url.searchParams.get("channel");
        if (
          url.searchParams.get("scope") !== scope ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(channel ?? "")
        )
          return reply(403, {
            error: "Map belongs to another community or viewer",
          });
        try {
          if (url.pathname === "/api/maps/note") {
            const location = url.searchParams.get("location");
            if (!/^square-roster:[0-9a-f]{64}$/.test(location ?? ""))
              return reply(400, { error: "Invalid retailer reference" });
            if (req.method === "GET")
              return reply(200, store.note(scope, channel, location));
            if (req.method !== "PUT")
              return reply(405, { error: "Method not allowed" });
            const chunks = [];
            let bytes = 0;
            for await (const part of req) {
              bytes += part.length;
              if (bytes > 65536)
                return reply(413, { error: "Note exceeds 64 KiB" });
              chunks.push(part);
            }
            let value;
            try {
              value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              return reply(400, { error: "Invalid note" });
            }
            if (
              typeof value?.text !== "string" ||
              !Number.isSafeInteger(value.revision) ||
              value.revision < 0
            )
              return reply(400, { error: "Invalid note" });
            const saved = store.saveNote(
              scope,
              channel,
              location,
              value.text,
              value.revision,
            );
            return saved
              ? reply(200, saved)
              : reply(409, { error: "Note changed in another window" });
          }
          if (url.pathname === "/api/maps/view") {
            if (req.method === "GET")
              return reply(200, { view: store.view(scope, channel) ?? null });
            if (req.method !== "PUT")
              return reply(405, { error: "Method not allowed" });
            let raw = "";
            for await (const part of req) {
              raw += part;
              if (raw.length > 8192)
                return reply(413, { error: "View metadata too large" });
            }
            const view = parseMap(JSON.parse(raw));
            // This DB holds viewport + dataset references only, never geometry.
            if (
              !view ||
              view.markers.length ||
              view.lines.length ||
              view.datasets?.some((id) => !store.dataset(scope, channel, id))
            )
              return reply(400, { error: "Invalid view" });
            store.saveView(scope, channel, view);
            return reply(200, { saved: true });
          }
          const id = url.pathname.slice("/api/maps/datasets/".length);
          if (
            !url.pathname.startsWith("/api/maps/datasets/") ||
            req.method !== "GET"
          )
            return reply(404, { error: "Not found" });
          const query = store.dataset(scope, channel, id);
          if (!query)
            return reply(404, { error: "Dataset unavailable in this channel" });
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson",
            "Cache-Control": "no-store",
          });
          const abort = new AbortController();
          res.once("close", () => abort.abort());
          let count = 0;
          for await (const feature of features(query, abort.signal)) {
            if (res.destroyed) break;
            if (!res.write(`${JSON.stringify({ feature })}\n`))
              await once(res, "drain", { signal: abort.signal });
            count++;
          }
          if (!res.destroyed)
            res.end(`${JSON.stringify({ complete: true, count })}\n`);
        } catch {
          // Never expose Snowflake errors or row values to chat/logs.
          if (!res.headersSent)
            reply(500, { error: "Map data could not load" });
          else if (!res.destroyed)
            res.end(
              `${JSON.stringify({ error: "Snowflake query failed; no complete dataset was loaded" })}\n`,
            );
        }
      });
    },
  };
}
