// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { useState } from "react";
import { Tooltip } from "./Tooltip";

afterEach(cleanup);

it("retains hover hints and click dismissal by default", async () => {
  const user = userEvent.setup();
  render(
    <Tooltip content="A hint">
      <button type="button">Action</button>
    </Tooltip>,
  );
  const action = screen.getByRole("button", { name: "Action" });
  await user.hover(action);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("A hint");
  await user.click(action);
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
});

function Feedback({ follow = "trigger" }: { follow?: "trigger" | "pointer" }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <span id="original">Original description</span>
      <Tooltip
        follow={follow}
        open={open}
        onOpenChange={setOpen}
        closeOnClick={false}
        content={copied ? "Copied" : "Copy value"}
      >
        <button
          type="button"
          aria-describedby="original"
          onClick={() => {
            setCopied(true);
            setOpen(true);
          }}
        >
          Copy
        </button>
      </Tooltip>
    </>
  );
}

it.each(["trigger", "pointer"] as const)(
  "shows %s feedback without losing descriptions and dismisses with Escape",
  async (follow) => {
    const user = userEvent.setup();
    render(<Feedback follow={follow} />);
    const action = screen.getByRole("button", { name: "Copy" });
    await user.click(action);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Copied");
    expect(action).toHaveAccessibleDescription("Original description Copied");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
    expect(action).toHaveAccessibleDescription("Original description");
  },
);
