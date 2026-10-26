// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelBody } from "./ChannelBody";

const fixture = vi.hoisted(() => {
  let snapshot = {
    status: "ready",
    rows: [{ id: "root" }],
    error: undefined as string | undefined,
  };
  const listeners = new Set<() => void>();
  return {
    session: {
      channels: {
        ensure: () => {},
        window: () => snapshot,
        subscribeWindow: (_id: string, listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    update(status: string, rows: { id: string }[], error?: string) {
      snapshot = { status, rows, error };
      for (const listener of listeners) listener();
    },
  };
});
// Isolate ChannelBody's ownership from the independent message renderers. The
// sheet, subscription, focus boundary and editor DOM lifetime remain real.
vi.mock("../../features/conversation/Conversation", () => ({
  useConversation: () => ({
    session: fixture.session,
    channelId: "alpha",
    ownSoloConversation: false,
  }),
  ConversationTimeline: ({
    onOpenThread,
  }: {
    onOpenThread(messageId: string, rootId: string): void;
  }) => (
    <button type="button" onClick={() => onOpenThread("root", "root")}>
      Open reply
    </button>
  ),
  ConversationThread: () => <textarea aria-label="Thread draft" />,
}));
vi.mock("../../features/relay/RecoveryNotice", () => ({
  useRecoveryShown: () => false,
}));

afterEach(cleanup);

it("keeps the focused thread and draft mounted through channel loading and recovery", () => {
  fixture.update("ready", [{ id: "root" }]);
  const view = render(
    <div>
      <ChannelBody cached={false} onOpenThread={() => {}} />
      <form data-message-composer style={{ borderRadius: "12px" }} />
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "Open reply" });
  trigger.focus();
  fireEvent.click(trigger);
  const editor = screen.getByRole("textbox", { name: "Thread draft" });
  fireEvent.change(editor, { target: { value: "Unfinished reply" } });
  editor.focus();
  for (const status of ["loading", "error", "ready"]) {
    act(() =>
      fixture.update(
        status,
        status === "ready" ? [{ id: "new" }] : [],
        "Refresh failed",
      ),
    );
    expect(screen.getByRole("dialog", { name: "Thread" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Thread draft" })).toBe(editor);
    expect(editor).toHaveValue("Unfinished reply");
    expect(editor).toHaveFocus();
  }
  fireEvent.click(screen.getByRole("button", { name: "Close thread" }));
  view.unmount();
});
