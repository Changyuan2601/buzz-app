// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentControl } from "../../features/agents/control";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { RelaySession } from "../../features/relay/session";
import { deployTeam } from "../../features/agents/team-deployment";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { TeamDeployDialog } from "./TeamDeployDialog";
vi.mock("../../features/agents/team-deployment", async (original) => ({
  ...(await original<typeof import("../../features/agents/team-deployment")>()),
  deployTeam: vi.fn(),
}));
vi.mock("../../features/channel-members/members", () => ({
  canAddMembers: () => true,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function fixture() {
  const inventory = { channels: [{ id: "channel", name: "Fixture" }] };
  const close = vi.fn();
  const view = render(
    <TeamDeployDialog
      team={{
        type: "team",
        id: "team",
        name: "Saved",
        agents: ["a".repeat(64)],
      }}
      kit={{} as ChannelKit}
      control={{} as AgentControl}
      session={
        {
          channels: { subscribeList: () => () => {}, list: () => inventory },
        } as unknown as RelaySession
      }
      close={close}
    />,
    { wrapper: ToastProvider },
  );
  return { ...view, close };
}
it.each(["cancel", "unmount"])(
  "aborts a held deployment on %s without claiming completion",
  async (method) => {
    const user = userEvent.setup();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(deployTeam).mockImplementation(async () => held);
    const view = fixture();
    expect(screen.getByText(/Attach the saved agents/)).toBeInTheDocument();
    expect(screen.queryByText(/Create and attach/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deploy 1 agent" }));
    await waitFor(() => expect(deployTeam).toHaveBeenCalledOnce());
    const signal = vi.mocked(deployTeam).mock.calls[0]?.[3];
    expect(signal?.aborted).toBe(false);
    try {
      if (method === "cancel")
        await user.click(screen.getByRole("button", { name: "Cancel" }));
      else view.unmount();
      expect(signal?.aborted).toBe(true);
    } finally {
      release();
    }
    await held;
    expect(view.close).toHaveBeenCalledTimes(method === "cancel" ? 1 : 0);
  },
);
