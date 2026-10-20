// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import type { Navigation } from "../../features/navigation/controller";
import {
  readLinkedChat,
  linkedDraftKey,
} from "../../features/solo/linked-chat";
import { soloDraft } from "../../features/channel-navigation/routes";
import {
  MenuRoot,
  MenuTrigger,
  MenuPopup,
} from "../../shared/design-system/ui/Menu";
import { StartLinkedChat } from "./StartLinkedChat";

const owner = createRelaySession(null);
afterAll(() => owner.dispose());
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const viewer = "a".repeat(64),
  root = "b".repeat(64),
  reply = "c".repeat(64);
const scope = `https://relay.test:${viewer}`;
it("opens an isolated Solo draft with the exact source link", async () => {
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
            id: "design",
            name: "Design",
            channelType: "stream" as const,
            members: [viewer],
          },
        ],
      }),
    },
    channelWrites: { ...owner.session.channelWrites, available: true },
  };
  const view = render(
    <MenuRoot>
      <MenuTrigger>Message actions</MenuTrigger>
      <MenuPopup>
        <StartLinkedChat
          session={session}
          navigation={{ ...({} as Navigation), open }}
          channelId="design"
          message={{
            id: reply,
            channelId: "design",
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
        />
      </MenuPopup>
    </MenuRoot>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  const item = await screen.findByRole("menuitem", { name: "Start Solo chat" });
  expect(item).not.toHaveAttribute("aria-haspopup");
  await user.click(item);
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
    channelId: "design",
    link: `buzz://message?channel=design&id=${reply}&thread=${root}`,
  });
  view.unmount();
});
