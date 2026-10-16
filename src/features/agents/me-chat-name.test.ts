import { expect, it, vi } from "vitest";
import type { RelayData } from "../relay/service";
import type { RelayEvent } from "../relay/events";
import { nameMeChat } from "./me-chat-name";

const first = "a".repeat(64),
  second = "b".repeat(64),
  owner = "c".repeat(64);
const event = {
  id: "1".repeat(64),
  pubkey: owner,
  kind: 9,
  created_at: 100,
  content: "Discuss this change",
  tags: [
    ["h", "chat"],
    ["p", first],
    ["p", second],
  ],
} as unknown as RelayEvent;

// Session identity stays stable across reads, as it does in the owning service.
function connection(
  snapshot: () => { status: string; viewer: string; session: unknown },
): RelayData {
  const state = snapshot();
  return { snapshot: () => state } as unknown as RelayData;
}

it("only the first tagged agent names an unchanged new Berd chat, once", async () => {
  let name = event.content;
  const save = vi.fn(async (_base, draft) => {
    name = draft.name;
  });
  const load = vi.fn(async () => ({
    name,
    canEdit: true,
    channelId: "chat",
    version: "v1",
  }));
  const relay = connection(() => ({
    status: "ready",
    viewer: owner,
    session: {
      mePlacement: { has: () => true },
      read: async () => [event],
      profiles: { snapshot: () => new Map() },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      channelDetails: { available: true, load, save },
    },
  }));
  await nameMeChat(relay, owner, second, event, "Second agent wins?");
  expect(load).not.toHaveBeenCalled();
  await nameMeChat(relay, owner, first, event, "A useful title");
  expect(name).toBe("A useful title");
  await nameMeChat(relay, owner, first, event, "Another title");
  expect(save).toHaveBeenCalledOnce();
  name = "My manual title";
  await nameMeChat(relay, owner, first, event, "Please overwrite");
  expect(name).toBe("My manual title");
  expect(save).toHaveBeenCalledOnce();
});

it("recognizes a clean starting title from signed recipient tags without stripping literal @ text", async () => {
  const sent = { ...event, content: "@Agent @Literal investigate this" };
  const save = vi.fn();
  const relay = connection(() => ({
    status: "ready",
    viewer: owner,
    session: {
      mePlacement: { has: () => true },
      read: async () => [sent],
      profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      channelDetails: {
        available: true,
        load: async () => ({
          name: "@Literal investigate this",
          canEdit: true,
        }),
        save,
      },
    },
  }));
  await nameMeChat(relay, owner, first, sent, "Useful title");
  expect(save).toHaveBeenCalledOnce();
});

it.each(["bold", "bullet_list"])(
  "a %s first draft and its sent message agree on the starting title",
  async (format) => {
    const { startingChatTitle } = await import("../sessions/chat-title");
    const { mentionDraft } = await import("../messages/mention-draft");
    const { composerMarkdown } = await import("../messages/composer-markdown");
    const paragraph = {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "fix login",
          ...(format === "bold" ? { marks: [{ type: "bold" }] } : {}),
        },
      ],
    };
    const draft = mentionDraft({
      document: {
        version: 1,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "token",
                  attrs: {
                    source: "@Agent",
                    recipient: { pubkey: first, name: "Agent" },
                    editAsText: false,
                  },
                },
                { type: "text", text: " " },
              ],
            },
            format === "bullet_list"
              ? {
                  type: "bullet_list",
                  content: [{ type: "list_item", content: [paragraph] }],
                }
              : paragraph,
          ],
        },
      },
    });
    const name = startingChatTitle(draft);
    expect(name).toBe(format === "bold" ? "**fix login**" : "- fix login");
    const sent = { ...event, content: composerMarkdown(draft) };
    const save = vi.fn();
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        mePlacement: { has: () => true },
        read: async () => [sent],
        profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: {
          available: true,
          load: async () => ({ name, canEdit: true }),
          save,
        },
      },
    }));
    await nameMeChat(relay, owner, first, sent, "Login repair");
    expect(save).toHaveBeenCalledOnce();
  },
);

it.each([first, second])(
  "retry wording and tag order do not change the original naming agent (%s)",
  async (agent) => {
    const retry = {
      ...event,
      id: "2".repeat(64),
      created_at: 110,
      content: "Try again",
      tags: [
        ["h", "chat"],
        ["p", second],
        ["p", first],
      ],
    };
    const save = vi.fn();
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        mePlacement: { has: () => true },
        read: vi.fn(async () => [retry, event]),
        profiles: { snapshot: () => new Map() },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: {
          available: true,
          load: async () => ({ name: event.content, canEdit: true }),
          save,
        },
      },
    }));
    await nameMeChat(relay, owner, agent, retry, "A useful title");
    expect(save).toHaveBeenCalledTimes(agent === first ? 1 : 0);
  },
);

it.each(["empty", "full", "same-second", "unrelated", "unsent"])(
  "keeps the title when original-message evidence is %s",
  async (evidence) => {
    const retry = {
      ...event,
      id: "2".repeat(64),
      created_at: 110,
      content: "Try again",
    };
    const history =
      evidence === "empty"
        ? []
        : evidence === "full"
          ? Array.from({ length: 100 }, (_, index) => ({
              ...event,
              id: index.toString(16).padStart(64, "0"),
              created_at: index,
            }))
          : evidence === "unsent"
            ? [{ ...event, delivery: "failed" }, retry]
            : evidence === "same-second"
              ? [event, { ...retry, created_at: event.created_at }]
              : [
                  { ...event, pubkey: second },
                  { ...event, tags: [["h", "other"]] },
                  {
                    ...event,
                    tags: [...event.tags, ["e", "e".repeat(64), "", "reply"]],
                  },
                ];
    const save = vi.fn();
    const load = vi.fn(async () => ({ name: event.content, canEdit: true }));
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        mePlacement: { has: () => true },
        read: async () => history,
        profiles: { snapshot: () => new Map() },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: { available: true, load, save },
      },
    }));
    await nameMeChat(relay, owner, first, retry, "Must not replace");
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  },
);

it.each(["history", "details"])(
  "does not rename after the owning session changes during %s",
  async (stage) => {
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi.fn();
    const session = {
      mePlacement: { has: () => true },
      read: async () => {
        if (stage === "history") {
          began();
          await gate;
        }
        return [event];
      },
      profiles: { snapshot: () => new Map() },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      channelDetails: {
        available: true,
        load: async () => {
          if (stage === "details") {
            began();
            await gate;
          }
          return { name: event.content, canEdit: true };
        },
        save,
      },
    };
    let current = session;
    const relay = {
      snapshot: () => ({ status: "ready", viewer: owner, session: current }),
    } as unknown as RelayData;
    const work = nameMeChat(relay, owner, first, event, "Do not rename");
    try {
      await started;
      current = { ...session };
    } finally {
      release();
    }
    await work;
    expect(save).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "staged session cards keep caption-first naming and protect chosen names (chosen=%s)",
  async (chosen) => {
    const { startingChatTitle } = await import("../sessions/chat-title");
    const { composerMarkdown } = await import("../messages/composer-markdown");
    const draft = {
      text: "@Agent Review this",
      recipients: [{ pubkey: first, name: "Agent", start: 0, end: 6 }],
      sessionCards: ["[Session: Fix](buzz://channel/session-id)"],
    };
    const name = startingChatTitle(draft);
    expect(name).toBe("Review this");
    const sent = { ...event, content: composerMarkdown(draft) };
    const save = vi.fn();
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        mePlacement: { has: () => true },
        read: async () => [sent],
        profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: {
          available: true,
          load: async () => ({
            name,
            labels: chosen ? ["buzz.session.named"] : [],
            canEdit: true,
          }),
          save,
        },
      },
    }));
    await nameMeChat(relay, owner, first, sent, "Useful title");
    expect(save).toHaveBeenCalledTimes(chosen ? 0 : 1);
  },
);

it("an agent tag without a caption retains the session-card starting title", async () => {
  const { startingChatTitle } = await import("../sessions/chat-title");
  expect(
    startingChatTitle({
      text: "@Agent ",
      recipients: [{ pubkey: first, name: "Agent", start: 0, end: 6 }],
      sessionCards: ["[Session: Fix](buzz://channel/session-id)"],
    }),
  ).toBe("[Session: Fix](buzz://channel/session-id)");
});
