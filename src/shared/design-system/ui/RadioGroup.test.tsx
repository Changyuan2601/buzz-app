// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { Field } from "./Field";
import { useState } from "react";
import { Radio, RadioGroup, RadioWriteIn } from "./RadioGroup";

afterEach(cleanup);

it("keeps text-only tiles keyboard-selectable, labelled and form-associated", async () => {
  const user = userEvent.setup();
  render(
    <form aria-label="Choices">
      <Field label="Delivery" nativeLabel={false}>
        <RadioGroup name="delivery" defaultValue="all">
          <Radio value="all" label="All updates" variant="tile" />
          <Radio value="mentions" label="Mentions only" variant="tile" />
          <Radio value="none" label="Unavailable" variant="tile" disabled />
        </RadioGroup>
      </Field>
    </form>,
  );
  await user.tab();
  expect(screen.getByRole("radio", { name: "All updates" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("radio", { name: "Mentions only" })).toBeChecked();
  expect(screen.getByRole("radio", { name: "Mentions only" })).toHaveFocus();
  expect(
    new FormData(screen.getByRole("form") as HTMLFormElement).get("delivery"),
  ).toBe("mentions");
  await user.click(screen.getByText("All updates"));
  expect(screen.getByRole("radio", { name: "All updates" })).toBeChecked();
  await user.click(screen.getByText("Unavailable"));
  expect(screen.getByRole("radio", { name: "All updates" })).toBeChecked();
});

it("lets a write-in tile take over from the tiles while its owner selects it", async () => {
  const user = userEvent.setup();
  function Tone() {
    const [tone, setTone] = useState<string | null>("Warm");
    return (
      <>
        <Field label="Tone" nativeLabel={false}>
          <RadioGroup<string | null> value={tone} onValueChange={setTone}>
            <Radio value="Warm" label="Warm" variant="tile" />
            <Radio value="Direct" label="Direct" variant="tile" />
          </RadioGroup>
        </Field>
        <RadioWriteIn
          aria-label="Write your own"
          selected={tone === null}
          onFocus={() => setTone(null)}
        />
      </>
    );
  }
  render(<Tone />);
  const own = screen.getByRole("textbox", { name: "Write your own" });
  expect(own).not.toHaveAttribute("data-checked");
  await user.click(own);
  expect(own).toHaveAttribute("data-checked");
  expect(screen.getByRole("radio", { name: "Warm" })).not.toBeChecked();
  await user.click(screen.getByText("Direct"));
  expect(screen.getByRole("radio", { name: "Direct" })).toBeChecked();
  expect(own).not.toHaveAttribute("data-checked");
});
