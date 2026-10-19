// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import {
  readLinkedChat,
  linkedDraftKey,
} from "../../features/solo/linked-chat";
import { soloDraft } from "../../features/channel-navigation/routes";
import { StartLinkedMessage } from "./StartLinkedChat";

const owner = createRelaySession(null);
afterAll(() => owner.dispose());
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
});
const viewer = "a".repeat(64),
  root = "b".repeat(64),
  reply = "c".repeat(64);
const scope = `https://relay.test:${viewer}`;
it.each([true, false])(
  "opens an isolated private draft through relay support or opted-in local preview (relay=%s)",
  async (supported) => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_BUZZ_LOCAL_ORIGIN_PREVIEW", supported ? "0" : "1");
    const open = vi.fn<Navigation["open"]>(async () => ({ status: "opened" }));
    const session = {
      ...owner.session,
      viewer,
      scope,
      channels: {
        ...owner.session.channels,
        list: () => ({
          status: "ready" as const,
          channels: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "Design",
              channelType: "stream" as const,
              members: [viewer],
            },
          ],
        }),
      },
      channelWrites: {
        ...owner.session.channelWrites,
        available: true,
        originSupported: supported,
      },
    };
    const view = render(
      <StartLinkedMessage
        session={session}
        navigation={{ ...({} as Navigation), open }}
        close={() => {}}
        message={{
          id: reply,
          channelId: "11111111-1111-4111-8111-111111111111",
          threadRootId: root,
          delivery: "seen",
          authorId: viewer,
          content: "Please look at this",
          createdAt: 1,
          mentions: [],
          participants: [],
          attachments: [],
          reactions: [],
          replyCount: 0,
        }}
      />,
    );
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(open).toHaveBeenCalledOnce();
    const destination = open.mock.calls[0]?.[0];
    const parsed =
      destination?.kind === "page"
        ? soloDraft(destination.route?.params)
        : undefined;
    const id = parsed?.linked;
    expect(id).toBeTruthy();
    expect(parsed).toEqual({ linked: id });
    expect(readLinkedChat(scope, linkedDraftKey(id ?? ""))).toEqual({
      channelId: "11111111-1111-4111-8111-111111111111",
      messageId: reply,
      threadRootId: root,
    });
    expect(owner.session.outbox?.snapshot() ?? []).toEqual([]);
    view.unmount();
  },
);
