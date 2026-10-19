// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import type {
  DecisionProviderStatus,
  RegisteredProvider,
} from "../features/decisions/service";
import { DecisionsSettings } from "./DecisionsSettings";

afterEach(cleanup);

/** The decisions service as Settings uses it, choosing as the service does:
 * the saved choice, else the first ready provider, else the first. */
function fake(
  entries: { key: string; status: DecisionProviderStatus }[],
  chosen?: string,
) {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const statuses = new Map(entries.map((entry) => [entry.key, entry.status]));
  const providers: RegisteredProvider[] = entries.map(({ key }) => ({
    key,
    id: key,
    pluginId: key,
    revision: "one",
    label: `Provider ${key}`,
    description: `About ${key}.`,
    status: () => statuses.get(key) ?? "needs-setup",
    subscribe: () => () => {},
    decide: async () => ({ outcome: "failed", reason: "unavailable" }),
    Settings: () => <p>Settings for {key}</p>,
  }));
  const backend = () =>
    providers.find((provider) => provider.key === chosen)?.key ??
    providers.find((provider) => provider.status() === "ready")?.key ??
    providers[0]?.key;
  return {
    providers: () => providers,
    backend,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setBackend(key: string) {
      chosen = key;
      notify();
    },
    chosen: () => chosen,
    setStatus(key: string, status: DecisionProviderStatus) {
      statuses.set(key, status);
      notify();
    },
  };
}

it("says to turn a provider on when none is", () => {
  render(<DecisionsSettings decisions={fake([])} active={() => true} />);
  expect(screen.getByRole("heading", { name: "Decisions API" })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Settings > Plugins");
});

it("shows a lone provider's settings, with no provider choice", () => {
  render(
    <DecisionsSettings
      decisions={fake([{ key: "typesafe", status: "needs-setup" }])}
      active={() => true}
    />,
  );
  expect(screen.queryByRole("radio")).toBeNull();
  expect(
    screen.getByRole("heading", { name: "Provider typesafe" }),
  ).toBeVisible();
  expect(screen.getByText("Settings for typesafe")).toBeVisible();
});

it("says once, above every provider's settings, that the provider receives message text", () => {
  render(
    <DecisionsSettings
      decisions={fake([
        { key: "a", status: "ready" },
        { key: "b", status: "needs-setup" },
      ])}
      active={() => true}
    />,
  );
  expect(
    screen.getAllByText(/provider receives the message text/),
  ).toHaveLength(1);
  const disclosure = screen.getByText(/provider receives the message text/);
  expect(disclosure).toHaveTextContent("private channels");
  expect(
    disclosure.compareDocumentPosition(screen.getByText("Settings for a")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("chooses a ready provider at once", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: "a", status: "ready" },
    { key: "b", status: "ready" },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  expect(screen.getByRole("radio", { name: /Provider a/ })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  expect(decisions.chosen()).toBe("b");
  expect(screen.getByRole("radio", { name: /Provider b/ })).toBeChecked();
  expect(screen.getByText("Settings for b")).toBeVisible();
});

it("shows the settings of one picked before it is ready, and saves the choice once it is", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: "a", status: "ready" },
    { key: "b", status: "needs-setup" },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  // The working provider keeps answering until b is set up.
  expect(decisions.chosen()).toBeUndefined();
  expect(decisions.backend()).toBe("a");
  expect(screen.getByRole("radio", { name: /Provider b/ })).toBeChecked();
  expect(screen.getByText("Settings for b")).toBeVisible();
  act(() => decisions.setStatus("b", "ready"));
  expect(decisions.chosen()).toBe("b");
  expect(screen.getByRole("radio", { name: /Provider b/ })).toBeChecked();
});

it("changes nothing while hidden", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: "a", status: "ready" },
    { key: "b", status: "ready" },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => false} />);
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  expect(decisions.chosen()).toBeUndefined();
});
