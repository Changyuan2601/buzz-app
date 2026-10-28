import { verifyEvent } from "nostr-tools";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { expect } from "../fixture.mjs";

const normalize = (text) => text?.replace(/\s+/g, " ").trim();

// Channel-only, installed before navigation/setup. Leave/blur and subsequent
// samples never erase history; a fresh document owns a fresh ledger.
export async function channelWork(page, app) {
  const manifests = new Map(
    [...app.histories].map(([key, source]) => {
      const head = source.slice(-20).map((e) => ({ ...e }));
      const latest = head.at(-1);
      if (!latest) return [key, undefined];
      const tree = fromMarkdown(latest.content, {
        extensions: [gfmStrikethrough()],
        mdastExtensions: [gfmStrikethroughFromMarkdown()],
      });
      const semantics = { blockquote: 0, em: 0, strong: 0, delete: 0 };
      const names = {
        emphasis: "em",
        strong: "strong",
        blockquote: "blockquote",
        delete: "delete",
      };
      const text = (node) => {
        if (names[node.type]) semantics[names[node.type]]++;
        return (
          node.value ??
          (node.children ?? []).map(text).join("") +
            (["paragraph", "blockquote"].includes(node.type) ? "\n" : "")
        );
      };
      return [
        key,
        {
          expectedIds: head.map((e) => e.id),
          expectedLatest: latest.id,
          expectedText: normalize(text(tree)),
          expectedSemantics: semantics,
          expectedSigned: head.every((e) => verifyEvent(e)),
          expectedCursor: { created_at: head[0].created_at, id: head[0].id },
        },
      ];
    }),
  );
  const relay = app.signRelay({
    kind: 39006,
    created_at: 0,
    tags: [],
    content: "",
  }).pubkey;
  await page.addInitScript(() => {
    const ledger = { sequence: 0, history: [] };
    window.__perfChannelWork = ledger;
    for (const type of ["pointerover", "pointerout", "focus", "blur"])
      document.addEventListener(
        type,
        (event) => {
          const channel = event.target.closest?.("button[data-channel-id]")
            ?.dataset.channelId;
          if (channel)
            ledger.history.push({
              sequence: ++ledger.sequence,
              type,
              channel,
              trusted: event.isTrusted,
              t: performance.now(),
            });
        },
        { capture: true, passive: true },
      );
    const requests = new WeakMap();
    const text = Response.prototype.text;
    Response.prototype.text = function (...args) {
      const result = Reflect.apply(text, this, args);
      const entries = requests.get(this);
      if (entries)
        result.then(
          (body) => {
            for (const entry of entries) {
              entry.body = body;
              entry.bodySequence = ++ledger.sequence;
              entry.status = this.status;
            }
          },
          (error) => {
            for (const entry of entries) entry.error = String(error);
          },
        );
      return result;
    };
    const fetch = window.fetch;
    window.fetch = function (...args) {
      const entries = [];
      const url = new URL(args[0]?.url ?? args[0], location.href);
      if (url.pathname === "/api/relay/primary/query") {
        // Audited current caller: fetch(url, JSON init.body), then response.text().
        // Both wrappers return the original promises, consume no extra stream,
        // and record before the caller's existing await continuation.
        const body = args[1]?.body;
        const filters = typeof body === "string" ? JSON.parse(body) : [];
        for (const filter of filters)
          if (filter.top_level && filter.until === undefined)
            for (const channel of filter["#h"] ?? []) {
              const entry = {
                sequence: ++ledger.sequence,
                type: "request",
                channel,
                filter,
                t: performance.now(),
              };
              ledger.history.push(entry);
              entries.push(entry);
            }
      }
      const result = Reflect.apply(fetch, this, args);
      if (entries.length)
        result.then(
          (response) => {
            for (const entry of entries) entry.status = response.status;
            requests.set(response, entries);
          },
          (error) => {
            for (const entry of entries) entry.error = String(error);
          },
        );
      return result;
    };
  });
  return {
    latest: (id) => manifests.get(`primary/${id}`).expectedLatest,
    receipt(id, boundary) {
      return {
        ...manifests.get(`primary/${id}`),
        relay,
        responses: boundary?.history
          .filter((e) => e.type === "request")
          .map((e) => {
            let events,
              error = e.error;
            try {
              if (e.body !== undefined) events = JSON.parse(e.body);
            } catch (failure) {
              error = String(failure);
            }
            return {
              filter: e.filter,
              status: e.status,
              bodySequence: e.bodySequence,
              events,
              error,
            };
          }),
        boundary,
      };
    },
    check(receipt) {
      const { boundary, expectedIds, responses, relay } = receipt;
      expect(
        boundary.history.filter(
          (e) =>
            e.sequence < boundary.trigger &&
            ["pointerover", "focus", "request"].includes(e.type),
        ),
        "channel target has no prior intent or in-flight preparation",
      ).toEqual([]);
      expect(receipt.expectedSigned, "fixture head signatures").toBe(true);
      expect(
        responses,
        "one actual complete channel head response",
      ).toHaveLength(1);
      const response = responses[0];
      expect(response.status).toBe(200);
      expect(response.error).toBeUndefined();
      expect(
        Array.isArray(response.events),
        "head body captured at original browser stop",
      ).toBe(true);
      expect(
        response.bodySequence,
        "actual body completed before original browser stop",
      ).toBeLessThan(boundary.end);
      expect(response.filter.limit, "original head limit").toBe(20);
      const rows = response.events.filter((e) => e.kind === 9);
      expect(
        rows.map((e) => e.id),
        "fixture-owned exact signed head20 membership",
      ).toEqual([...expectedIds].reverse());
      expect(
        response.events.every((e) => verifyEvent(e)),
        "actual response signatures and hash identities",
      ).toBe(true);
      const bounds = response.events.filter((e) => e.kind === 39006);
      expect(bounds, "one relay-signed channel head bound").toHaveLength(1);
      expect(bounds[0].pubkey).toBe(relay);
      const channel = response.filter["#h"][0];
      expect(bounds[0].tags).toEqual([
        ["h", channel],
        ["d", `${channel}:head`],
      ]);
      expect(JSON.parse(bounds[0].content)).toEqual({
        has_more: true,
        next_cursor: receipt.expectedCursor,
      });
      expect(
        boundary.latest.id,
        "fixture latest at original visible completion boundary",
      ).toBe(receipt.expectedLatest);
      expect(boundary.latest.visible, "required latest visible").toBe(true);
      expect(boundary.latest.selected, "required selected channel").toBe(
        "page",
      );
      expect(
        boundary.latest.composer,
        "required current channel composer",
      ).toEqual([`Message #${channel === "beta" ? "Beta" : "Alpha"}`]);
      expect(
        boundary.latest.bodyVisible,
        "required latest content visible",
      ).toBe(true);
      expect(
        normalize(boundary.latest.text),
        "source-derived visible latest content",
      ).toBe(receipt.expectedText);
      expect(
        boundary.latest.semantics,
        "source-derived Markdown semantics",
      ).toEqual(receipt.expectedSemantics);
    },
  };
}
