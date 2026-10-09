import { expect, it } from "vitest";
import type { ChannelMessage } from "../relay/contracts";
import { deepLinkStep } from "../navigation/deep-links";
import { profileTarget } from "../profiles/target";
import { messageCopyText, messageCopyLink } from "./message-copy";
const person = "a".repeat(64);
const row: ChannelMessage = {
  id: "b".repeat(64),
  channelId: "general",
  authorId: person,
  content: "Hello @Morgan",
  mentions: [person],
  attachments: [],
  participants: [],
  reactions: [],
  replyCount: 0,
  createdAt: 1,
};
const profiles = new Map([[person, { name: "Morgan" }]]);
it("copies prose mentions as exact profile links and retains Markdown and attachments", () => {
  expect(
    messageCopyText(
      {
        ...row,
        content: "**Hello @Morgan**",
        attachments: [{ kind: "image", url: "https://example.com/a.png" }],
      },
      profiles,
      [],
    ),
  ).toBe(
    `**Hello [@Morgan](${profileTarget(person)})**\n\nhttps://example.com/a.png`,
  );
});
it.each([
  "`@Morgan`",
  "```\n@Morgan\n```",
  "[x][@Morgan]\n\n[@Morgan]: https://example.com",
  "<!-- @Morgan -->",
  "[hello @Morgan](https://example.com)",
  "    @Morgan",
  "\\@Morgan",
])("does not manufacture mentions in literal Markdown: %s", (content) => {
  expect(messageCopyText({ ...row, content }, profiles, [])).toBe(content);
});
it("does not guess edited, stripped, unsigned, or ambiguous mentions", () => {
  for (const change of [
    { edited: true as const },
    { attachmentSeams: [9] },
    { mentions: [] },
  ])
    expect(messageCopyText({ ...row, ...change }, profiles, [])).toBe(
      row.content,
    );
  const other = "c".repeat(64);
  expect(
    messageCopyText(
      { ...row, mentions: [person, other] },
      new Map([...profiles, [other, { name: "Morgan" }]]),
      [],
    ),
  ).toBe(row.content);
});
it("copies an original-Buzz message link that opens with the recipient's community and thread hint", () => {
  const link = messageCopyLink(
    { ...row, threadRootId: "d".repeat(64) },
    `https://relay.test:${person}`,
  );
  if (!link) throw new Error("Expected a message link");
  expect(link).toBe(
    `buzz://message?channel=general&id=${row.id}&thread=${"d".repeat(64)}`,
  );
  expect(
    deepLinkStep(link, { viewer: person, selected: "https://recipient.test" }),
  ).toEqual({
    open: {
      version: 1,
      kind: "conversation",
      scope: { communityOrigin: "https://recipient.test", viewer: person },
      channelId: "general",
      messageId: row.id,
      threadRootId: "d".repeat(64),
    },
  });
  expect(link).not.toContain(person);
  expect(link).not.toContain("relay.test");
});
it("does not create links for pending, failed, unavailable or malformed targets", () => {
  for (const delivery of ["unknown", "failed", "sending"] as const)
    expect(
      messageCopyLink({ ...row, delivery }, `https://relay.test:${person}`),
    ).toBeUndefined();
  expect(messageCopyLink(row, undefined)).toBeUndefined();
  expect(messageCopyLink(row, "invalid")).toBeUndefined();
});
