// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { Login } from "./Login";
import { federatedFixture } from "../../../features/federated-identity/testing";
import { createBuilderlabSession } from "../session";

afterEach(cleanup);
function fixture(email: string | null = "a@example.com") {
  const federated = federatedFixture("user", email);
  return { ...federated, session: createBuilderlabSession(federated.session) };
}
it("shows a desktop requirement in the browser", () => {
  const h = fixture();
  render(<Login session={h.session} available={false} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("desktop app");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(h.service.signIn).not.toHaveBeenCalled();
});
it("signs in and out through the native session", async () => {
  const h = fixture();
  render(
    <StrictMode>
      <Login session={h.session} available active={() => true} />
    </StrictMode>,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(await screen.findByRole("button", { name: "Sign out" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Signed in as a@example.com.",
  );
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(
    await screen.findByRole("button", { name: "Sign in with Builderlab" }),
  ).toBeEnabled();
  expect(() => h.session.credential()).toThrow("Sign in");
});
it("shows a signed-in confirmation when email is unavailable", async () => {
  const h = fixture(null);
  render(<Login session={h.session} available active={() => true} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Sign in with Builderlab" }));
  expect(await screen.findByRole("button", { name: "Sign out" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Signed in to Builderlab.",
  );
});
it.each(["cancel", "unmount"])(
  "%s cancels a pending native sign-in",
  async (action) => {
    const h = fixture();
    vi.mocked(h.service.signIn).mockImplementationOnce(async () => {
      h.publish({ status: "signing-in" });
      return h.service.snapshot();
    });
    const mounted = render(
      <Login session={h.session} available active={() => true} />,
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Sign in with Builderlab" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Finish sign-in in your browser",
    );
    if (action === "cancel")
      await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    else mounted.unmount();
    expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
  },
);
it("shows failures and permits retry; inactive contributions cannot start sign-in", async () => {
  const h = fixture();
  vi.mocked(h.service.signIn).mockRejectedValueOnce(
    new Error("Browser could not open."),
  );
  let active = false;
  render(<Login session={h.session} available active={() => active} />);
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(h.service.signIn).not.toHaveBeenCalled();
  active = true;
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Browser could not open",
  );
  await user.click(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  );
  expect(
    await screen.findByRole("button", { name: "Sign out" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
