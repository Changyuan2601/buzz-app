// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PanelCard } from "./PanelCard";
import type { RegisteredPanel } from "./service";
import { createDraftGuard } from "../drafts/guard";
import { DraftProtection } from "../drafts/DraftProtection";
import { useDraftState } from "../drafts/react";

afterEach(cleanup);
function Editor() {
  const [text, setText] = useState("");
  useDraftState(
    "instructions",
    { dirty: !!text, saving: false, revision: text },
    () => setText(""),
  );
  return (
    <textarea
      aria-label="Instructions"
      value={text}
      onChange={(event) => setText(event.target.value)}
    />
  );
}
const panel: RegisteredPanel = {
  id: "profile",
  key: "profiles/profile",
  pluginId: "profiles",
  revision: "1",
  title: "Profile",
  matches: () => true,
  component: Editor,
};

it.each(["button", "Escape"])(
  "preserves the exact editor after canceling a %s close",
  async (route) => {
    const guard = createDraftGuard();
    const close = vi.fn();
    render(
      <DraftProtection guard={guard}>
        <PanelCard panel={panel} target="profile:one" close={close} />
      </DraftProtection>,
    );
    const user = userEvent.setup();
    const field = screen.getByRole("textbox", { name: "Instructions" });
    await user.type(field, "Keep this");
    if (route === "button")
      await user.click(
        screen.getByRole("button", { name: "Close Profile panel" }),
      );
    else await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Instructions" })).toBe(field);
    expect(field).toHaveValue("Keep this");
    await user.click(
      screen.getByRole("button", { name: "Close Profile panel" }),
    );
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    guard.dispose();
  },
);
