// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createElement, type ComponentType } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserViewProps } from "../../../features/browser/api";
import type { PanelProps } from "../../../features/panels/service";
import { createOAuthSession } from "../oauth/session";
import { applyApps } from "./index";
import { deferred } from "../test-helpers";
import type { Credential } from "../oauth/browser";

const APP = "https://counter--workspace.apps.example/report/42";
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

function setup(loginAvailable = true) {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://login.example");
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_APPS_DOMAIN", "apps.example");
  const acquire = vi.fn(async () => ({
    value: "first-private-token",
    account: {
      subject: "first",
      email: "first@example.com",
      canUseRemoteAgents: false,
    },
  }));
  const revoke = vi.fn();
  const session = createOAuthSession(acquire, revoke);
  const viewed = vi.fn((_props: BrowserViewProps) =>
    createElement("div", { "aria-label": "App website" }),
  );
  const register = vi.fn();
  const ctx = {
    browser: { available: true, View: viewed },
    panels: {
      register,
      requestOpen: vi.fn(() => true),
    },
    agents: { addTool: vi.fn() },
    host: {},
  };
  applyApps(ctx as never, session, loginAvailable);
  const panel = register.mock.calls[0]?.[0] as {
    matches(target: string): boolean;
    component: ComponentType<PanelProps>;
  };
  return { session, acquire, revoke, viewed, panel };
}

it("app links and apps_open use the Settings account and replace its guest lifetime on account change", async () => {
  const { session, acquire, revoke, viewed, panel } = setup();
  await session.signIn();
  expect(panel.matches(APP)).toBe(true);
  render(createElement(panel.component, { target: APP } as PanelProps));
  expect(screen.getByLabelText("App website")).toBeInTheDocument();
  const first = viewed.mock.lastCall?.[0].builderlab;
  expect(first?.credential).toBe("first-private-token");
  expect(viewed.mock.lastCall?.[0].url).toBe(APP);
  act(() => session.signOut());
  expect(first?.signal.aborted).toBe(true);
  expect(screen.queryByLabelText("App website")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Sign in with Builderlab" }),
  ).toBeInTheDocument();
  acquire.mockResolvedValueOnce({
    value: "second-private-token",
    account: {
      subject: "second",
      email: "second@example.com",
      canUseRemoteAgents: false,
    },
  });
  await act(() => session.signIn());
  expect(viewed.mock.lastCall?.[0].builderlab?.credential).toBe(
    "second-private-token",
  );
  expect(viewed.mock.lastCall?.[0].builderlab?.storage).not.toBe(
    first?.storage,
  );
  expect(revoke).toHaveBeenCalledTimes(1);
  session.dispose();
});

it("closing an observing app panel does not cancel Settings' pending login", async () => {
  const { session, acquire, viewed, panel } = setup();
  const held = deferred<Credential>();
  acquire.mockImplementationOnce(() => held.promise);
  const first = render(
    createElement(panel.component, { target: APP } as PanelProps),
  );
  const second = render(
    createElement(panel.component, { target: APP } as PanelProps),
  );
  let login!: Promise<void>;
  act(() => {
    login = session.signIn();
  });
  expect(session.snapshot().status).toBe("pending");
  first.unmount();
  expect(session.snapshot().status).toBe("pending");
  await act(async () => {
    held.resolve({
      value: "private",
      account: { subject: "owner", email: "", canUseRemoteAgents: false },
    });
    await login;
  });
  expect(viewed.mock.lastCall?.[0].builderlab?.credential).toBe("private");
  second.unmount();
  session.dispose();
});

it("an app from a different tenant never receives the Settings credential", async () => {
  const { session, viewed, panel } = setup();
  await session.signIn();
  render(
    createElement(panel.component, {
      target: "https://counter.apps.other.example/",
    } as PanelProps),
  );
  expect(
    screen.getByText("Open this app with its Builderlab environment"),
  ).toBeInTheDocument();
  expect(viewed).not.toHaveBeenCalled();
  session.dispose();
});

it("an unconfigured native exchange keeps the account-isolated browser-login path", async () => {
  const { session, viewed, panel } = setup();
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_APPS_DOMAIN", "");
  const target = "https://counter--workspace.apps.builderlab.xyz/report";
  await session.signIn();
  expect(panel.matches(target)).toBe(true);
  render(createElement(panel.component, { target } as PanelProps));
  expect(screen.getByLabelText("App website")).toBeInTheDocument();
  const lifetime = viewed.mock.lastCall?.[0].builderlab;
  expect(lifetime?.storage).toBeTruthy();
  act(() => session.signOut());
  expect(lifetime?.signal.aborted).toBe(true);
  expect(screen.queryByLabelText("App website")).not.toBeInTheDocument();
  session.dispose();
});

it("opens the app for its own browser login when Settings login is unavailable", () => {
  const { session, acquire, viewed, panel } = setup(false);
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "");
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_APPS_DOMAIN", "");
  render(createElement(panel.component, { target: APP } as PanelProps));
  expect(screen.getByLabelText("App website")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Sign in with Builderlab" }),
  ).not.toBeInTheDocument();
  const props = viewed.mock.lastCall?.[0];
  expect(props?.builderlab).toBeUndefined();
  expect(props?.storage).toBe("builderlab-apps");
  expect(acquire).not.toHaveBeenCalled();
  session.dispose();
});
