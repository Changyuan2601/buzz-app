// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { InlineUiCard } from "./InlineUiCard";
import { InlineUiHost } from "./host";

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
  expect(screen.getByRole("radio", { name: "Short" })).not.toBeChecked();
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
  expect(screen.getByRole("textbox", { name: "Write your own" })).toHaveValue(
    "Something else",
  );
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
