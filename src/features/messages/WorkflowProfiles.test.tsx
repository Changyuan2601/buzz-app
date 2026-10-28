// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { eventDto } from "../relay/events";
import { createRelaySession } from "../relay/session";
import { keypair, message, profile } from "../relay/testing";
import { ThreadPanel } from "./ThreadPanel";
import { MediaReviewViewer } from "./MediaReviewViewer";

stubAvatarBrowserApis();
vi.mock("virtua", () => import("./virtua-testing"));
vi.mock("./MessageComposer", () => ({ MessageComposer: () => null }));
afterEach(() => cleanup());

it.each(["thread", "media"])(
  "loads a cold workflow-owner profile when opening %s directly",
  async (surface) => {
    const relay = keypair(),
      viewer = keypair(),
      workflowOwner = keypair();
    const attachment = {
      url: "https://fixture.test/image.png",
      kind: "image" as const,
    };
    const root = message(viewer, "one", "Image", 1, [
      ["imeta", `url ${attachment.url}`, "m image/png"],
    ]);
    // No p tag: the verified workflow-owner field itself must create profile demand.
    const reply = message(relay, "one", "Automated comment", 2, [
      ["e", root.id, "", "reply"],
      ["buzz:workflow", "true"],
      ["buzz:workflow-owner", workflowOwner.pubkey],
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested: string[] = [];
    const owner = createRelaySession({
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      archiveAuthority: relay.pubkey,
      media: (url) => url,
      async query(filters) {
        if (
          filters.some(
            (filter) =>
              filter.kinds?.includes(0) &&
              filter.authors?.includes(workflowOwner.pubkey),
          )
        ) {
          requested.push(workflowOwner.pubkey);
          await gate;
          return [profile(workflowOwner, { name: "Cold workflow owner" })];
        }
        return filters
          .flatMap((filter) => {
            if (filter.ids)
              return [root, reply].filter((event) =>
                filter.ids?.includes(event.id),
              );
            if (filter.depth_limit)
              return filter.thread_cursor === undefined ? [reply] : [];
            return [];
          })
          .map(eventDto);
      },
    });
    try {
      expect(owner.session.profiles.snapshot().has(workflowOwner.pubkey)).toBe(
        false,
      );
      const props = {
        session: owner.session,
        scope: "workflow-profile-test",
        channelId: "one",
        channelName: "One",
        messageId: root.id,
        close: () => {},
        onOpenLink: () => false,
      };
      render(
        surface === "thread" ? (
          <ThreadPanel {...props} />
        ) : (
          <MediaReviewViewer
            {...props}
            attachment={attachment}
            initialTime={0}
          />
        ),
      );
      await screen.findByText("Automated comment");
      await waitFor(() => expect(requested).toContain(workflowOwner.pubkey));
      expect(
        screen.queryByText(/owned by Cold workflow owner/),
      ).not.toBeInTheDocument();
      await act(async () => release());
      expect(
        await screen.findByText(/owned by Cold workflow owner/),
      ).toBeInTheDocument();
    } finally {
      release();
      cleanup();
      owner.dispose();
    }
  },
);
