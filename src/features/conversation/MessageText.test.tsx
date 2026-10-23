// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { Context } from "@deepseek-ai/cordis";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PluginRuntime } from "../../plugins/runtime";
import { ConversationService } from "./service";
import * as emoji from "../../bundled/emoji";
import type { ChannelMessage } from "../relay/contracts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  cleanup();
  for (const dispose of cleanups.splice(0)) await dispose();
});

it("renders a message body with Markdown, mentions and custom emoji, read-only", async () => {
  const root = new Context();
  const runtime = new PluginRuntime(root, async () => emoji);
  const service = new ConversationService(root);
  cleanups.push(async () => {
    await runtime.dispose();
    await root.fiber.dispose();
  });
  runtime.reconcile([
    {
      manifest: { id: "buzz.emoji", name: "Emoji", apiVersion: 1 as const },
      enabled: true,
      source: "external" as const,
      revision: "one",
      previous: null,
      reloadable: true,
      error: null,
    },
  ]);
  await vi.waitFor(() => expect(service.inline.snapshot()).toHaveLength(2));
  const mic = "b".repeat(64);
  const row: ChannelMessage = {
    id: "row",
    channelId: "c",
    authorId: "a",
    createdAt: 1,
    content: `**Ship it** with \`code\` :party: @Mic :+1: :Tada: :not_an_emoji: https://a.test/:+1: [docs](https://a.test/docs)`,
    mentions: [mic],
    attachments: [],
    reactions: [],
    replyCount: 0,
    participants: [],
    emoji: [{ shortcode: "party", url: "https://a.test/party.png" }],
  };
  const MessageText = service.ui.MessageText;
  expect(service.ui.MessageText).toBe(MessageText);
  const { container } = render(
    <MessageText
      row={row}
      media={(url) => url}
      participantProfiles={new Map([[mic, { name: "Mic" }]])}
    />,
  );
  expect(screen.getByText("Ship it").tagName).toBe("STRONG");
  expect(screen.getByText("code").tagName).toBe("CODE");
  expect(
    container.querySelector('img[src="https://a.test/party.png"]'),
  ).not.toBeNull();
  expect(
    container.querySelector('[data-mention-kind="person"]'),
  ).toHaveTextContent("Mic");
  expect(container).not.toHaveTextContent(":party:");
  // Standard shortcodes show as their emoji once the dataset loads; unknown
  // ones and ones inside links stay as written.
  await vi.waitFor(() =>
    expect(container).toHaveTextContent("👍 🎉 :not_an_emoji:"),
  );
  expect(container).toHaveTextContent("https://a.test/:+1:");
  // Read-only: no link or mention opens anything.
  expect(container.querySelector("a[href], button")).toBeNull();
});
