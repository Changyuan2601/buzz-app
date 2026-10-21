// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { InlineUiCard } from "./InlineUiCard";
import { InlineUiHost } from "./host";

afterEach(cleanup);

it("freezes a retired choice on the owner's reply, and hides one the chat moved past", () => {
  const ui = { pattern: "choice" as const, options: ["Short", "Detailed"] };
  const view = render(
    <InlineUiCard
      ui={ui}
      agent="a"
      live={false}
      reply="Detailed"
      onReply={() => {}}
    />,
  );
  expect(screen.getByRole("radio", { name: "Detailed" })).toBeChecked();
  // Options not chosen are closed away, out of reach.
  expect(screen.queryByRole("radio", { name: "Short" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Write your own" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  view.rerender(
    <InlineUiCard
      ui={ui}
      agent="a"
      live={false}
      reply="Something else"
      onReply={() => {}}
    />,
  );
  // A written answer shows whole, as a chosen option, not in a field.
  expect(screen.getByRole("radio", { name: "Something else" })).toBeChecked();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("radio", { name: "Detailed" })).toBeNull();
  view.rerender(
    <InlineUiCard ui={ui} agent="a" live={false} onReply={() => {}} />,
  );
  expect(screen.queryByRole("form")).toBeNull();
});

it("freezes a saved profile on the agent's chosen name, without Shuffle or Submit", () => {
  const ui = { pattern: "profile" as const, options: ["Juniper", "Atlas"] };
  const author = { text: "Juniper", picture: "https://example.test/j.png" };
  const view = render(
    <InlineUiCard ui={ui} agent="a" live author={author} onReply={() => {}} />,
  );
  expect(screen.queryByRole("radio")).toBeNull();
  view.rerender(
    <InlineUiHost.Provider value={{ profileSaved: true }}>
      <InlineUiCard ui={ui} agent="a" live author={author} onReply={() => {}} />
    </InlineUiHost.Provider>,
  );
  expect(screen.getByRole("radio", { name: "Juniper" })).toBeChecked();
  expect(screen.queryByRole("button", { name: "Shuffle" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
});

it("closes the options not chosen when a live choice is answered, keeping the card mounted", async () => {
  const ui = { pattern: "choice" as const, options: ["Short", "Detailed"] };
  const view = render(
    <InlineUiCard ui={ui} agent="a" live onReply={() => {}} />,
  );
  const card = within(view.container).getByRole("form");
  expect(
    within(view.container).getByRole("button", { name: "Submit" }),
  ).toBeVisible();
  view.rerender(
    <InlineUiCard
      ui={ui}
      agent="a"
      live={false}
      reply="Short"
      onReply={() => {}}
    />,
  );
  expect(within(view.container).getByRole("form")).toBe(card);
  expect(
    within(view.container).getByRole("radio", { name: "Short" }),
  ).toBeChecked();
  expect(
    within(view.container).queryByRole("radio", { name: "Detailed" }),
  ).toBeNull();
  expect(
    within(view.container).queryByRole("button", { name: "Submit" }),
  ).toBeNull();
  // After fading they are gone, so the card shrinks to just the answer.
  await vi.waitFor(() =>
    expect(
      within(view.container).queryAllByRole("radio", {
        hidden: true,
        name: "Detailed",
      }),
    ).toHaveLength(0),
  );
});

it("keeps a name card usable until it is saved, even after later messages", () => {
  const ui = { pattern: "profile" as const, options: ["Juniper", "Atlas"] };
  render(
    <InlineUiHost.Provider value={{ saveProfile: async () => {} }}>
      <InlineUiCard ui={ui} agent="a" live={false} onReply={() => {}} />
    </InlineUiHost.Provider>,
  );
  expect(screen.getByRole("radio", { name: "Juniper" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Submit" })).toBeVisible();
});

it("hands focus on when a choice is submitted, so it isn't lost with the closing controls", async () => {
  const ui = { pattern: "choice" as const, options: ["Short", "Detailed"] };
  const answered = vi.fn();
  const onReply = vi.fn();
  render(
    <InlineUiHost.Provider value={{ answered }}>
      <InlineUiCard ui={ui} agent="a" live onReply={onReply} />
    </InlineUiHost.Provider>,
  );
  await userEvent.click(screen.getByRole("radio", { name: "Short" }));
  screen.getByRole("button", { name: "Submit" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(onReply).toHaveBeenCalledWith("Short");
  expect(answered).toHaveBeenCalledOnce();
});

it("hands focus on only after a name is saved, and keeps it in the card if the save fails", async () => {
  const ui = { pattern: "profile" as const, options: ["Juniper", "Atlas"] };
  const answered = vi.fn();
  let reject: (reason: Error) => void = () => {};
  const saveProfile = vi.fn(
    () => new Promise<void>((_, fail) => (reject = fail)),
  );
  render(
    <InlineUiHost.Provider value={{ saveProfile, answered }}>
      <InlineUiCard ui={ui} agent="a" live onReply={() => {}} />
    </InlineUiHost.Provider>,
  );
  await userEvent.click(screen.getByRole("radio", { name: "Juniper" }));
  screen.getByRole("button", { name: "Submit" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(saveProfile).toHaveBeenCalledOnce();
  expect(answered).not.toHaveBeenCalled();
  reject(new Error("Couldn't save."));
  expect(await screen.findByText("Couldn't save.")).toBeVisible();
  expect(answered).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Submit" })).toHaveFocus(),
  );
});
