// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentControl } from "../../features/agents/control";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { Team } from "../../features/channel-templates/model";
import type { TeamSnapshot } from "../../features/agents/team-bundles";
import { TeamExportDialog } from "./TeamExportDialog";

const team: Team = {
  type: "team",
  id: "fixture",
  name: "Controlled team",
  agents: [],
};
const portable: TeamSnapshot = {
  format: "buzz-team-snapshot",
  version: 1,
  team: { name: team.name },
  members: [],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture(exported: Promise<TeamSnapshot> = Promise.resolve(portable)) {
  const exportTeam = vi.fn(() => exported);
  const control = {
    previewTeam: vi.fn(async () => portable),
    exportTeam,
  } as unknown as AgentControl;
  const kit = {
    loadTeam: vi.fn(async () => portable),
  } as unknown as ChannelKit;
  const close = vi.fn();
  const create = vi.fn(() => "blob:fixture");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = vi.fn();
    },
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return {
    tree: (
      <TeamExportDialog
        team={team}
        control={control}
        kit={kit}
        community="https://relay.example"
        close={close}
      />
    ),
    exportTeam,
    create,
    close,
  };
}

it("exports config-only by default", async () => {
  const h = fixture();
  render(h.tree);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(h.close).toHaveBeenCalledOnce());
  expect(h.exportTeam).toHaveBeenCalledExactlyOnceWith(
    portable,
    [],
    "https://relay.example",
    "none",
  );
});

it("requires explicit plaintext memory confirmation and resets it on a level change", async () => {
  const h = fixture();
  render(h.tree);
  const user = userEvent.setup();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Memories" }), {
    key: "ArrowDown",
  });
  await user.click(
    await screen.findByRole("option", { name: "Team + core memory" }),
  );
  expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  expect(h.exportTeam).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("checkbox", {
      name: "I confirm that I want to include memory in this snapshot.",
    }),
  );
  expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Memories" }), {
    key: "ArrowDown",
  });
  await user.click(
    await screen.findByRole("option", { name: "Team + all memories" }),
  );
  expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  expect(h.exportTeam).not.toHaveBeenCalled();
});

it("does not download or close a replacement after export resolves beyond unmount", async () => {
  let resolve!: (value: TeamSnapshot) => void;
  const pending = new Promise<TeamSnapshot>((done) => {
    resolve = done;
  });
  const h = fixture(pending);
  const mounted = render(h.tree);
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(h.exportTeam).toHaveBeenCalledOnce());
  mounted.unmount();
  resolve(portable);
  await pending;
  // Await the exporting continuation, not elapsed wall time.
  await Promise.resolve();
  expect(h.create).not.toHaveBeenCalled();
  expect(h.close).not.toHaveBeenCalled();
});
