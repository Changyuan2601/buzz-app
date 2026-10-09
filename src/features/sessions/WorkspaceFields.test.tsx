// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { WorkspaceFields } from "./WorkspaceFields";
import type { Workspace } from "./workspace";
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function Form() {
  const [value, setValue] = useState<Workspace>({
    folders: ["/original"],
    worktree: { location: "/worktrees", baseBranch: "main" },
    canvas: "Keep this",
  });
  return <WorkspaceFields value={value} onChange={setValue} />;
}
it("fills the source path from the native picker, preserves other fields, and leaves cancellation unchanged", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce("/chosen/repository")
    .mockResolvedValueOnce(null);
  render(<Form />);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Browse source repository" }),
  );
  expect(invoke).toHaveBeenCalledWith("workspace_pick_folder");
  expect(
    screen.getByRole("textbox", { name: "Source repository" }),
  ).toHaveValue("/chosen/repository");
  expect(screen.getByRole("textbox", { name: "Canvas" })).toHaveValue(
    "Keep this",
  );
  await user.click(
    screen.getByRole("button", { name: "Browse source repository" }),
  );
  expect(
    screen.getByRole("textbox", { name: "Source repository" }),
  ).toHaveValue("/chosen/repository");
});
it("keeps the typed path and allows retry when the picker fails", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Picker unavailable"));
  render(<Form />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Browse source repository" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Picker unavailable",
  );
  expect(
    screen.getByRole("textbox", { name: "Source repository" }),
  ).toHaveValue("/original");
  expect(
    screen.getByRole("button", { name: "Browse source repository" }),
  ).toBeEnabled();
});
