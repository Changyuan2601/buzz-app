// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { Login } from "./Login";
import { federatedFixture } from "./testing";
import type { SessionSnapshot } from "./service";

afterEach(cleanup);
it("shows desktop setup guidance without invoking login", () => {
  const h = federatedFixture();
  render(<Login session={h.session} available={false} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("desktop app");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(h.service.signIn).not.toHaveBeenCalled();
});
it("signs in and out through the shared owner, including when no email is supplied", async () => {
  const h = federatedFixture("user", null);
  render(
    <StrictMode>
      <Login session={h.session} available active={() => true} />
    </StrictMode>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("button", { name: "Sign out" })).toBeEnabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Signed in to Builderlab.",
  );
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(h.service.signOut).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
});
it.each(["cancel", "unmount"])(
  "%s during sign-in preserves shared ownership",
  async (action) => {
    const h = federatedFixture();
    const held = deferred<SessionSnapshot>();
    vi.mocked(h.service.signIn).mockImplementation(() => {
      h.publish({ status: "signing-in" });
      return held.promise;
    });
    const mounted = render(
      <StrictMode>
        <Login session={h.session} available active={() => true} />
      </StrictMode>,
    );
    try {
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Sign in" }));
      expect(h.service.signIn).toHaveBeenCalledOnce();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Finish sign-in in your browser",
      );
      if (action === "cancel") {
        await user.click(
          screen.getByRole("button", { name: "Cancel sign-in" }),
        );
        expect(h.service.cancelSignIn).toHaveBeenCalledOnce();
        expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
      } else {
        mounted.unmount();
        expect(h.service.cancelSignIn).not.toHaveBeenCalled();
        expect(h.service.signOut).not.toHaveBeenCalled();
      }
    } finally {
      await act(async () => {
        held.resolve(h.service.snapshot());
        await held.promise;
      });
    }
  },
);
it("shows failures and permits retry; inactive contributions cannot start sign-in", async () => {
  const h = federatedFixture();
  vi.mocked(h.service.signIn).mockRejectedValueOnce(
    new Error("Browser could not open."),
  );
  let active = false;
  render(<Login session={h.session} available active={() => active} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(h.service.signIn).not.toHaveBeenCalled();
  active = true;
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Browser could not open",
  );
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(
    await screen.findByRole("button", { name: "Sign out" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
