// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  DecisionProviderStatus,
  RegisteredProvider,
} from "../features/decisions/service";
import { DecisionsSettings } from "./DecisionsSettings";

afterEach(cleanup);

/** The decisions service as Settings uses it, choosing as the service does:
 * the saved choice, else the default, which here is the first entry. A
 * choice that is not registered answers nothing. */
function fake(
  entries: ({
    key: string;
    status: DecisionProviderStatus;
    /** Replaces the status read, for a provider whose status throws. */
    readStatus?: RegisteredProvider["status"];
  } & Partial<Pick<RegisteredProvider, "Settings">>)[],
  chosen?: string,
) {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const statuses = new Map(entries.map((entry) => [entry.key, entry.status]));
  const providers: RegisteredProvider[] = entries.map(({ key, ...entry }) => ({
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
    ...(entry.Settings ? { Settings: entry.Settings } : {}),
    ...(entry.readStatus ? { status: entry.readStatus } : {}),
  }));
  const backend = () =>
    providers.find((provider) => provider.key === (chosen ?? entries[0]?.key))
      ?.key;
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

it("keeps a provider's failing settings inside its own part, even while hidden", async () => {
  const user = userEvent.setup();
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const decisions = fake([
    {
      key: "a",
      status: "ready",
      Settings: () => {
        throw new Error("broken plugin");
      },
    },
    { key: "b", status: "ready" },
  ]);
  let selected = "plugins";
  // Settings mounts the Decisions section while another one is shown.
  const page = () => (
    <>
      <button type="button">Turn plugin off</button>
      <div hidden={selected !== "decisions"}>
        <DecisionsSettings
          decisions={decisions}
          active={() => selected === "decisions"}
        />
      </div>
    </>
  );
  const { rerender } = render(page());
  expect(screen.getByRole("button", { name: "Turn plugin off" })).toBeVisible();
  selected = "decisions";
  rerender(page());
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Provider a settings are unavailable. You can turn its plugin off in Settings > Plugins.",
  );
  // The rest of the section still works.
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  expect(decisions.chosen()).toBe("b");
  expect(screen.getByText("Settings for b")).toBeInTheDocument();
  consoleError.mockRestore();
});

it("treats a provider whose status throws as not ready", async () => {
  const user = userEvent.setup();
  const decisions = fake([
    { key: "a", status: "ready" },
    {
      key: "b",
      status: "ready",
      readStatus: () => {
        throw new Error("broken status");
      },
    },
  ]);
  render(<DecisionsSettings decisions={decisions} active={() => true} />);
  await user.click(screen.getByRole("radio", { name: /Provider b/ }));
  // Shown, as one picked before it is ready, but not chosen.
  expect(screen.getByText("Settings for b")).toBeVisible();
  expect(decisions.chosen()).toBeUndefined();
  expect(decisions.backend()).toBe("a");
});
