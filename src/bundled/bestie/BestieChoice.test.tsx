// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { BestieChoice } from "./BestieChoice";
import type { BestieAgent } from "./state";

afterEach(cleanup);

const pollen: BestieAgent = {
  pubkey: "b".repeat(64),
  name: "Pollen",
  managed: false,
};
const fizz: BestieAgent = {
  pubkey: "c".repeat(64),
  name: "Fizz",
  managed: false,
};
const open = async (
  props: Partial<Parameters<typeof BestieChoice>[0]> = {},
) => {
  const onChoose = vi.fn();
  const user = userEvent.setup();
  render(
    <StrictMode>
      <BestieChoice
        agents={[pollen, fizz]}
        trigger={<Button>Choose your Bestie</Button>}
        onChoose={onChoose}
        {...props}
      />
    </StrictMode>,
  );
  await user.click(screen.getByRole("button", { name: /Bestie/ }));
  return { user, onChoose };
};

test("the first pick takes effect without a confirmation", async () => {
  const { user, onChoose } = await open();
  // Keyboard and pointer share the one selection owner.
  await user.keyboard("{ArrowDown}{Enter}");
  expect(onChoose).toHaveBeenCalledWith(pollen);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

test("the Bestie in place is marked, and reselecting it changes nothing", async () => {
  const { user, onChoose } = await open({ current: pollen });
  const chosen = await screen.findByRole("menuitemradio", { name: /Pollen/ });
  expect(chosen).toBeChecked();
  expect(
    await screen.findByRole("menuitemradio", { name: /Fizz/ }),
  ).not.toBeChecked();
  await user.click(chosen);
  expect(onChoose).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

test("replacing a Bestie names what moves and keeps the current one by default", async () => {
  const { user, onChoose } = await open({ current: pollen });
  await user.click(await screen.findByRole("menuitemradio", { name: /Fizz/ }));
  const confirm = await screen.findByRole("alertdialog");
  expect(confirm).toHaveAccessibleName("Make Fizz your Bestie?");
  expect(confirm).toHaveAccessibleDescription(
    /Fizz replaces Pollen here.*new chats are addressed to Fizz.*chat with Pollen stays/s,
  );
  // Nothing has moved yet, and focus rests on keeping the current Bestie.
  expect(onChoose).not.toHaveBeenCalled();
  const keep = screen.getByRole("button", { name: "Keep Pollen" });
  await waitFor(() => expect(keep).toHaveFocus());
  await user.click(keep);
  expect(onChoose).not.toHaveBeenCalled();
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

test("confirming the replacement chooses the new agent", async () => {
  const { user, onChoose } = await open({ current: pollen });
  await user.click(await screen.findByRole("menuitemradio", { name: /Fizz/ }));
  await user.click(await screen.findByRole("button", { name: "Make Bestie" }));
  expect(onChoose).toHaveBeenCalledWith(fizz);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

test("a community with no agents says so instead of showing an empty list", async () => {
  await open({ agents: [] });
  expect(
    await screen.findByText("No agents to choose from in this community."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
});
