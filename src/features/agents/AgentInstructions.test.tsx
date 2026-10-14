// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentInstructions } from "./AgentInstructions";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({
  initial = "",
  disabled = false,
  onChange,
}: {
  initial?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <AgentInstructions
      value={value}
      disabled={disabled}
      description="Added to every session."
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

it("is a plain labelled field outside the card", async () => {
  const user = userEvent.setup();
  render(<Harness initial="Be kind." />);
  const field = screen.getByLabelText("Instructions");
  expect(field).toHaveValue("Be kind.");
  expect(field).toHaveAccessibleDescription("Added to every session.");
  expect(
    screen.queryByRole("button", { name: /^(Add|Edit) instructions$/ }),
  ).not.toBeInTheDocument();
  await user.type(field, " Really.");
  expect(field).toHaveValue("Be kind. Really.");
});

it("disables the plain field", () => {
  render(<Harness disabled />);
  expect(screen.getByLabelText("Instructions")).toBeDisabled();
});
