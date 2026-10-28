// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { TerminalPanel } from "./TerminalPanel";
import type { TerminalSessions, TerminalSession } from "./sessions";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test.each(["button", "native menu"])(
  "terminal input owns Escape and %s close detaches without ending the shell",
  async (closeAction) => {
    const user = userEvent.setup();
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Terminal input");
    const inputKey = vi.fn();
    input.addEventListener("keydown", inputKey);
    const detach = vi.fn(() => input.remove());
    const context = {
      scope: "test",
      viewer: "viewer",
      channelId: "alpha",
      channelName: "Alpha",
      relayUrl: "wss://example.test",
    };
    const entry: TerminalSession = {
      context,
      status: "running",
      screen: {
        mount: (host) => {
          host.append(input);
          return detach;
        },
        output: async () => {},
        dispose: vi.fn(),
      },
    };
    const sessions: TerminalSessions = {
      available: true,
      get: () => entry,
      snapshot: () => 0,
      subscribe: () => () => {},
      ensure: vi.fn(() => entry),
      end: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
    const close = vi.fn();
    const view = render(
      <PanelWorkspace
        value="terminal"
        select={() => {}}
        items={[
          {
            id: "terminal",
            label: "Terminal",
            close,
            content: (
              <TerminalPanel
                target="alpha"
                channelContext={context}
                sessions={sessions}
                close={close}
              />
            ),
          },
        ]}
      />,
    );
    expect(sessions.ensure).toHaveBeenCalledWith(context, true);
    await user.click(input);
    await user.keyboard("{Escape}");
    expect(inputKey).toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    if (closeAction === "button") {
      await user.click(
        screen.getByRole("button", { name: "Close Terminal tab" }),
      );
    } else {
      vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
        { width: 500, height: 500 },
      ] as unknown as DOMRectList);
      const request = new Event("buzz:close-active-tab", { cancelable: true });
      act(() => window.dispatchEvent(request));
      expect(request.defaultPrevented).toBe(true);
    }
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
    expect(detach).toHaveBeenCalledOnce();
    expect(sessions.end).not.toHaveBeenCalled();
    expect(entry.screen?.dispose).not.toHaveBeenCalled();
  },
);
