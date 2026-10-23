// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it } from "vitest";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import type { Credential } from "../oauth/browser";
import { createCreatePanel } from "./Create";

afterEach(cleanup);

it("offers Cancel sign-in only while sign-in is pending, then restores the provider copy", async () => {
  const login = deferred<Credential>();
  let aborted = false;
  const session = createOAuthSession((signal) => {
    signal.addEventListener("abort", () => (aborted = true));
    return login.promise;
  });
  const Create = createCreatePanel(session);
  render(<Create config={{}} disabled={false} onChange={() => {}} />, {
    wrapper: StrictMode,
  });
  expect(screen.getByText(/Its provider keeps its key/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).not.toBeInTheDocument();

  await act(async () => {
    void session.signIn();
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish sign-in in your browser",
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(aborted).toBe(true);
  expect(session.snapshot().status).toBe("signed-out");
  expect(screen.getByText(/Its provider keeps its key/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Cancel sign-in" }),
  ).not.toBeInTheDocument();
});
