// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SoloTitle } from "./SoloPresentation";

afterEach(cleanup);

it("keeps management actions after archival without exposing active-only actions", () => {
  const props = {
    channel: { name: "Solo chat", private: true as const },
    actions: <button type="button">Manage</button>,
    children: <button type="button">Share</button>,
  };
  const view = render(<SoloTitle {...props} />);
  expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
  view.rerender(
    <SoloTitle {...props} channel={{ ...props.channel, archived: true }} />,
  );
  expect(screen.getByText("Archived")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Share" }),
  ).not.toBeInTheDocument();
});
