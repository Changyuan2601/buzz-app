// Signed histories for the perf suite on the vendored complexCorpus (the live
// row mix), all deterministic: fixed author keys and profiles, relay-hosted
// media the fixture serves same-origin, real replies for every thread summary,
// an optional long thread, and planted search tokens.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getPublicKey } from "nostr-tools";
import { complexCorpus } from "../../fixtures/complex-corpus.mjs";

const sha = (text) => createHash("sha256").update(text).digest();
const NAMES =
  "Alice Chen,Bruno Díaz,Chioma Okafor,Dmitri Volkov,Emma Larsen,Farah Haddad,Gustavo Silva,Hana Sato,Ivan Petrov,Jules Martin,Kofi Mensah,Lena Fischer".split(
    ",",
  );
const asset = (path) =>
  readFileSync(new URL(`../../fixtures/${path}`, import.meta.url));
const ASSETS = {
  image: ["image/png", asset("design-system/assets/avatar.png")],
  thumb: ["image/png", asset("attachment-media/still.png")],
  video: ["video/mp4", asset("message-gallery/assets/sample.mp4")],
  file: ["application/octet-stream", Buffer.from("fixture file")],
  missing: ["text/plain", Buffer.from("not an image")], // the corpus's broken emoji
};
const WORDS =
  "thanks i can reproduce this on main after the last merge the timeline jumps when older history loads".split(
    " ",
  );

/** `channels`: [{id, count, seed, longThread?: {replies, fromNewest, mark?}, marks?: {name: rowsFromNewest}}]. */
export function buildCorpus({
  channels,
  sign,
  relayKey,
  viewerKey,
  reference,
}) {
  const key = (label) => new Uint8Array(sha(`buzz-perf:${label}`));
  const authors = NAMES.map((_, index) => key(`author-${index}`));
  const [agent, closed] = [key("agent-build"), key("agent-helper")];
  const keyOf = new Map(
    [...authors, agent, closed].map((k) => [getPublicKey(k), k]),
  );
  const media = new Map(); // sha256 -> served kind
  const hosted = (url, kind) => {
    const hash = sha(url).toString("hex");
    media.set(hash, kind);
    return `https://primary.example/media/${hash}.${url.match(/\.(\w+)$/)?.[1] ?? "bin"}`;
  };
  const kindOf = (tag) =>
    tag
      .find((f) => f.startsWith("m "))
      ?.slice(2)
      .split("/")[0];
  const signed = (k, template) =>
    sign(k, {
      ...template,
      tags: template.tags.map((tag) =>
        tag[0] === "imeta"
          ? tag.map((f) =>
              f.startsWith("url ")
                ? `url ${hosted(f.slice(4), { image: "image", video: "video" }[kindOf(tag)] ?? "file")}`
                : f,
            )
          : tag[0] === "emoji" && tag[2]?.startsWith("https://")
            ? [
                tag[0],
                tag[1],
                hosted(
                  tag[2],
                  tag[2].includes("missing") ? "missing" : "image",
                ),
              ]
            : tag,
      ),
    });
  /** Re-sign `event` with `token` appended (a unique search target). */
  const plant = (event, token) =>
    sign(keyOf.get(event.pubkey), {
      ...event,
      content: `${event.content} ${token}`,
    });
  const profiles = [...NAMES, "Build Bot", "Helper Bot"].map((name, index) => {
    const k = [...authors, agent, closed][index];
    const picture = hosted(`avatar:${getPublicKey(k)}.png`, "image");
    const body = {
      name,
      display_name: name,
      picture,
      ...(index >= NAMES.length ? { is_agent: true } : {}),
    };
    return sign(k, {
      kind: 0,
      content: JSON.stringify(body),
      created_at: 1_699_000_000,
      tags: [],
    });
  });

  let random = 0x9e3779b9;
  const next = () => {
    random = (random * 1_103_515_245 + 12_345) % 2_147_483_648;
    return random / 2_147_483_648;
  };
  const reply = (index) => {
    let text = "";
    for (const length = 20 + Math.floor(next() * 260); text.length < length; )
      text += `${WORDS[Math.floor(next() * WORDS.length)]} `;
    text = text.trim();
    if (index % 7 === 3)
      text += "\n```\nbin/pnpm test:browser --project chromium\n```";
    if (index % 5 === 2) text += "\n- checked chromium\n- checked webkit";
    if (index % 11 === 6) text = `> ${text.slice(0, 60)}\n\n${text}`;
    return text[0].toUpperCase() + text.slice(1);
  };
  const thread = (channelId, root, count, base) =>
    Array.from({ length: count }, (_, index) => {
      const tags = [
        ["h", channelId],
        ["e", root.id, "", "reply"],
      ];
      if (index % 9 === 4)
        tags.push([
          "imeta",
          `url https://media.test/reply-${root.id.slice(0, 8)}-${index}.png`,
          "m image/png",
          "dim 1200x800",
        ]);
      return signed(authors[(index * 5 + base) % authors.length], {
        kind: 9,
        content: reply(index),
        created_at: root.created_at + 20 + index * 37,
        tags,
      });
    });

  const histories = new Map();
  const summaries = [];
  const aux = [];
  const replies = new Map();
  const longThreads = {};
  const marks = {};
  for (const [index, channel] of channels.entries()) {
    const { events } = complexCorpus({
      count: channel.count,
      channelId: channel.id,
      start: 1_700_000_000 + index * 3_000_000,
      authors,
      agent,
      relay: relayKey,
      viewer: viewerKey,
      sign: signed,
      reference,
      seed: channel.seed,
      people: {
        person: getPublicKey(authors[0]),
        agent: getPublicKey(agent),
        closed: getPublicKey(closed),
      },
    });
    const rows = events.filter((e) => e.kind !== 39005 && e.kind !== 7);
    summaries.push(...events.filter((e) => e.kind === 39005));
    aux.push(...events.filter((e) => e.kind === 7));
    if (new Set(rows.map((e) => e.created_at)).size !== rows.length)
      throw new Error(`Corpus ${channel.id}: duplicate row timestamps`);
    // Search targets: messages nothing references, at least `fromNewest` rows back.
    const referenced = new Set(
      [...summaries, ...aux].flatMap((e) =>
        e.tags.filter(([k]) => k === "e").map(([, id]) => id),
      ),
    );
    marks[channel.id] = {};
    for (const [name, fromNewest] of Object.entries(channel.marks ?? {})) {
      let at = rows.length - 1 - fromNewest;
      while (
        at >= 0 &&
        (rows[at].kind !== 9 ||
          referenced.has(rows[at].id) ||
          rows[at].tags.some(([k]) => k === "e") ||
          rows[at].content.includes("perfmark"))
      )
        at--;
      if (at < 0) throw new Error(`Corpus ${channel.id}: no row for ${name}`);
      rows[at] = plant(rows[at], `perfmark${name}${index}`);
      marks[channel.id][name] = {
        id: rows[at].id,
        token: `perfmark${name}${index}`,
      };
    }
    histories.set(channel.id, rows);
    const byId = new Map(rows.map((e) => [e.id, e]));
    for (const [i, summary] of summaries.entries()) {
      const root = byId.get(summary.tags.find(([k]) => k === "e")?.[1]);
      if (root && !replies.has(root.id))
        replies.set(
          root.id,
          thread(channel.id, root, JSON.parse(summary.content).reply_count, i),
        );
    }
    const long = channel.longThread;
    if (long) {
      const root = rows.filter((e) => e.kind === 9).at(-1 - long.fromNewest);
      const list = thread(channel.id, root, long.replies, 3);
      if (long.mark != null) {
        const at = list.length - 1 - long.mark;
        list[at] = plant(list[at], `perfmarkreply${index}`);
        marks[channel.id].reply = {
          id: list[at].id,
          token: `perfmarkreply${index}`,
        };
      }
      replies.set(root.id, list);
      // An exact summary for the long thread replaces any generated one.
      summaries.splice(
        0,
        summaries.length,
        ...summaries.filter(
          (s) => !s.tags.some(([k, v]) => k === "e" && v === root.id),
        ),
      );
      const participants = [...new Set(list.map((e) => e.pubkey))].slice(0, 5);
      summaries.push(
        sign(relayKey, {
          kind: 39005,
          content: JSON.stringify({ reply_count: list.length, participants }),
          created_at: root.created_at + 5,
          tags: [
            ["e", root.id],
            ["d", root.id],
            ["h", channel.id],
          ],
        }),
      );
      longThreads[channel.id] = { root: root.id };
    }
  }
  /** [content type, body] for a proxied corpus media URL. */
  const serveMedia = (url) => {
    const target =
      new URL(url, "http://fixture.invalid").searchParams.get("url") ?? "";
    const kind = media.get(target.match(/\/media\/([0-9a-f]{64})/)?.[1]);
    if (!kind) throw new Error(`Unexpected corpus media: ${target}`);
    return ASSETS[
      target.endsWith(".thumb.jpg") && kind !== "missing" && kind !== "file"
        ? "thumb"
        : kind
    ];
  };
  return {
    histories,
    summaries,
    aux,
    replies,
    profiles,
    longThreads,
    marks,
    serveMedia,
  };
}
