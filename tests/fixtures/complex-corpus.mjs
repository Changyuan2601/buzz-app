// A deterministic channel history with every row kind ChannelTimeline renders,
// in the shares measured read-only on a live community: the performance
// harness (docs/performance-harness.md) uses it. Content is synthetic. Plain
// JavaScript, so Node fixtures can import it.

/** Shares of timeline rows (Chromium sample, 1,275 rows of 14 channels).
 * Membership rows and day dividers are row shares; the rest are shares of all
 * rows, drawn independently for each message row. */
export const LIVE_SHARES = Object.freeze({
  membership: 0.582,
  dayDivider: 0.168,
  thread: 0.244,
  reactions: 0.14,
  links: 0.103,
  mentionPerson: 0.057,
  mentionAgent: 0.023,
  images: 0.064,
  inlineCode: 0.038,
  lists: 0.037,
  customEmoji: 0.031,
  video: 0.014,
  codeBlocks: 0.007,
  quotes: 0.002,
  headings: 0.002,
  tables: 0.001,
  largeEmoji: 0.005,
  sentFromThread: 0.006,
  files: 0.001,
  emphasis: 0.026,
  multiParagraph: 0.068,
});
// Characters per message: the live histogram's buckets and counts.
const LENGTHS = [
  [1, 19, 36],
  [20, 49, 70],
  [50, 99, 112],
  [100, 199, 136],
  [200, 399, 109],
  [400, 799, 43],
  [800, 1599, 19],
  [1600, 2400, 8],
];
const WORDS =
  "the quick brown fox jumps over a lazy dog while seven bright engineers review layout changes and measure every line twice before shipping".split(
    " ",
  );
// Not in the live sample (Latin only); kept rare so every script appears.
const SCRIPTS = [
  "これは日本語のテキストです これは長い文章を折り返して確認するためのものです",
  "Привет мир это сообщение на русском языке для проверки переноса строк",
  "مرحبا بالعالم هذه رسالة طويلة مكتوبة باللغة العربية للتحقق من التفاف الأسطر",
  "안녕하세요 오늘 회의는 오후 세시에 시작합니다 자료를 확인해 주세요",
];

/** `sign(key, template)` signs a `{ kind, content, created_at, tags }`
 * template with one of the given keys (opaque here) and returns the event.
 * `people` holds pubkeys: a person, an openable agent and an agent the
 * reader cannot open; `reference` names a listed channel. Returns the events
 * and each message row's kinds. */
export function complexCorpus({
  count,
  channelId,
  start,
  authors,
  agent,
  relay,
  viewer,
  people,
  sign,
  reference = "#general",
  seed = 1,
}) {
  let state = seed;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const pick = (list) => list[Math.floor(random() * list.length)];
  const chance = (key) =>
    random() < LIVE_SHARES[key] / (1 - LIVE_SHARES.membership);
  const sentence = (characters) => {
    let text = pick(WORDS);
    while (text.length < characters) text += ` ${pick(WORDS)}`;
    return text[0].toUpperCase() + text.slice(1);
  };
  const length = () => {
    let at = random() * 533;
    for (const [low, high, weight] of LENGTHS) {
      if (at < weight) return low + Math.floor(random() * (high - low));
      at -= weight;
    }
    return 40;
  };
  // A token at a word boundary of the text.
  const insert = (text, token) => {
    const spaces = [...text.matchAll(/ /g)].map((match) => match.index);
    const at = spaces.length ? pick(spaces) : text.length;
    return `${text.slice(0, at)} ${token}${text.slice(at)}`;
  };
  const hex = (digit) => digit.repeat(64);
  const links = [
    "https://example.com/notes",
    "https://github.com/block/buzz-app/pull/619/files#diff-0123456789abcdef0123456789abcdef",
    "[the design notes](https://example.com/docs/design)",
    `buzz://message?channel=general&id=${hex("1")}`,
    reference,
  ];
  const emoji = [
    ["emoji", "party", "https://emoji.test/party.png"],
    ["emoji", "broken", "https://emoji.test/missing.png"],
    ["emoji", "unsafe", "http://emoji.test/unsafe.png"],
  ];
  const media = (index, kind) => {
    const fields = {
      image: [
        "m image/png",
        `dim ${pick(["1200x800", "800x1200", "640x640"])}`,
      ],
      video: ["m video/mp4", "dim 1280x720"],
      file: ["m application/pdf", "size 48213", "filename notes.pdf"],
      audio: ["m audio/mpeg", "duration 42"],
    }[kind];
    return ["imeta", `url https://media.test/${kind}-${index}.bin`, ...fields];
  };

  const events = [];
  const kinds = {};
  let time = start;
  let author = authors[0];
  let membershipAt = -Infinity;
  for (let index = 0; index < count; index++) {
    if (random() < LIVE_SHARES.dayDivider) time += 86_400;
    if (random() < LIVE_SHARES.membership) {
      // An hour apart, so each change is its own row.
      time = Math.max(time + 60, membershipAt + 3_700);
      membershipAt = time;
      const actor = pick([people.person, people.agent, people.closed]);
      const event = sign(relay, {
        kind: 40099,
        content: JSON.stringify({
          type: pick(["member_joined", "member_left"]),
          actor,
          target: actor,
        }),
        created_at: time,
        tags: [["h", channelId]],
      });
      events.push(event);
      kinds[event.id] = ["membership"];
      continue;
    }
    // Runs of messages by one author; a new author or a pause ends one.
    if (random() < 0.6) {
      author = pick(authors);
      time += 600;
    } else time += 30;
    const features = [];
    const has = (key) => chance(key) && features.push(key) > 0;
    let text = sentence(length());
    const tags = [["h", channelId]];
    let by = author;
    if (random() < 0.03) {
      text = pick(SCRIPTS);
      features.push("script");
    }
    if (has("multiParagraph")) {
      const words = text.split(" ");
      const half = Math.max(1, Math.floor(words.length / 2));
      text = `${words.slice(0, half).join(" ")}\n\n${sentence(30 + Math.floor(random() * 120))}`;
    }
    if (has("mentionPerson")) {
      text = insert(text, "@Alice Chen");
      tags.push(["p", people.person]);
    }
    if (has("mentionAgent")) {
      const closed = random() < 0.3;
      text = insert(text, closed ? "@Helper Bot" : "@Build Bot");
      tags.push(["p", closed ? people.closed : people.agent]);
    }
    if (has("links")) text = insert(text, pick(links));
    if (has("customEmoji")) {
      text = insert(text, pick([":party:", ":party:", ":broken:", ":unsafe:"]));
      tags.push(...emoji);
    }
    if (has("inlineCode")) text = insert(text, "`bin/pnpm test`");
    if (has("emphasis")) text = insert(text, "_really_");
    if (random() < 0.15) {
      text = `**Heads up:** ${text}`;
      features.push("strong");
    }
    if (has("lists"))
      text += "\n- first item\n- second item with a few more words\n- third";
    if (has("codeBlocks"))
      text += "\n```\nbin/pnpm test:browser --project chromium\n```";
    if (has("quotes")) text = `> ${sentence(60)}\n\n${text}`;
    if (has("tables"))
      text += "\n\n| check | result |\n|---|---|\n| lint | ok |";
    if (has("headings")) {
      // A long agent report.
      by = agent;
      text = `## Summary\n${text}\n\n1. ${sentence(80)}\n2. ${sentence(120)}\n\n${sentence(300)}`;
    }
    if (has("largeEmoji")) text = "🎉🎉";
    if (has("sentFromThread"))
      tags.push(["buzz:sent-from-thread", hex("2"), sentence(40)]);
    let attachment = 0;
    for (const [key, kind] of [
      ["images", "image"],
      ["video", "video"],
      ["files", "file"],
    ])
      if (has(key)) tags.push(media(index * 4 + attachment++, kind));
    // No live audio; one in every 200 rows keeps the kind covered.
    if (index % 200 === 7) {
      tags.push(media(index * 4 + attachment++, "audio"));
      features.push("audio");
    }
    const event = sign(by, { kind: 9, content: text, created_at: time, tags });
    events.push(event);
    if (has("thread"))
      events.push(
        sign(relay, {
          kind: 39005,
          content: JSON.stringify({
            reply_count: 1 + Math.floor(random() * 9),
            participants: [people.person],
          }),
          created_at: time + 5,
          tags: [
            ["e", event.id],
            ["d", event.id],
            ["h", channelId],
          ],
        }),
      );
    if (has("reactions"))
      for (const content of ["+", ":party:", "👀"].slice(
        0,
        1 + Math.floor(random() * 3),
      ))
        events.push(
          sign(viewer, {
            kind: 7,
            content,
            created_at: time + 10,
            tags: [
              ["h", channelId],
              ["e", event.id],
              ["p", event.pubkey],
              ...(content === ":party:" ? [emoji[0]] : []),
            ],
          }),
        );
    kinds[event.id] = features.length ? features : ["prose"];
  }
  return { events, kinds };
}
