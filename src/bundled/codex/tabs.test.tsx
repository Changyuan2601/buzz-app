// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentViewProps } from "../../features/agents/service";
import type { HostProcessOptions } from "../../features/host/service";
import { defaults, type Config } from "./config";
import { createTabs } from "./tabs";
import { CodexRuntime } from "./runtime";
import { CodexSetup } from "./setup";
import type { Wire } from "./rpc";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(cleanup);
function fixture(machine = { installed: true, signedIn: true }) {
  const processes: {
    id: string;
    options: HostProcessOptions | undefined;
    end: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    finish(code: number): void;
  }[] = [];
  const spawn = vi.fn(async (id: string, options?: HostProcessOptions) => {
    // Like the native host, reject with the error string, not an Error.
    if (id === "codex-app-server" && !machine.installed)
      return Promise.reject("Could not start codex: No such file or directory");
    const exit = deferred<number | null>();
    const process = {
      id,
      options,
      finish: exit.resolve,
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        if (wire.id == null) return;
        let result: unknown = {};
        if (wire.method === "account/read")
          result = {
            account: machine.signedIn
              ? { type: "chatgpt", email: "test@example.com" }
              : null,
          };
        if (wire.method === "model/list")
          result = {
            data: [
              {
                id: "a",
                model: "model-a",
                displayName: "Model A",
                isDefault: true,
                defaultReasoningEffort: "low",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "high" },
                ],
              },
              {
                id: "b",
                model: "model-b",
                displayName: "Model B",
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
              },
            ],
            nextCursor: null,
          };
        options?.onStdout?.(`${JSON.stringify({ id: wire.id, result })}\n`);
      },
      end: vi.fn(async () => {
        exit.resolve(0);
      }),
      kill: vi.fn(async () => {
        exit.resolve(null);
      }),
      exited: exit.promise,
    };
    processes.push(process);
    return process;
  });
  const runtime = new CodexRuntime(spawn, () => undefined, {} as Storage);
  const reauthorize = vi.spyOn(runtime, "reauthorize");
  const tabs = createTabs(React, spawn, runtime, new CodexSetup(spawn));
  const props = (settings = defaults, save = vi.fn(async () => {})) =>
    ({
      agent: { pubkey: "a".repeat(64), config: settings },
      save,
    }) as unknown as AgentViewProps<Config>;
  const step = (id: string) => {
    const found = processes.find((process) => process.id === id);
    if (!found) throw new Error(`No ${id} process`);
    return found;
  };
  return { machine, spawn, processes, step, tabs, props, reauthorize };
}
it("installs a missing Codex, streaming the installer, then checks again", async () => {
  const f = fixture({ installed: false, signedIn: true });
  render(<f.tabs.CodexTab {...f.props()} />);
  await screen.findByText("Codex is not installed.");
  fireEvent.click(screen.getByRole("button", { name: "Install Codex" }));
  await waitFor(() =>
    expect(f.spawn).toHaveBeenCalledWith(
      "install",
      expect.objectContaining({ env: { CODEX_NON_INTERACTIVE: "1" } }),
    ),
  );
  const install = f.step("install");
  try {
    act(() => install.options?.onStdout?.("Installing Codex\n"));
    expect(screen.getByRole("log", { name: "Setup output" })).toHaveTextContent(
      "Installing Codex",
    );
    expect(
      screen.getByRole("button", { name: "Install Codex" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    f.machine.installed = true;
  } finally {
    install.finish(0);
  }
  // Hold the check that follows the install: Install must not run again.
  const original = f.spawn.getMockImplementation();
  if (!original) throw new Error("Missing spawn fixture");
  const checking = deferred<void>();
  const release = deferred<void>();
  f.spawn.mockImplementationOnce(async (id, options) => {
    checking.resolve();
    await release.promise;
    return original(id, options);
  });
  await checking.promise;
  try {
    await screen.findByText("Checking Codex…");
    const again = screen.getByRole("button", { name: "Install Codex" });
    expect(again).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(again);
    expect(f.spawn.mock.calls.filter(([id]) => id === "install")).toHaveLength(
      1,
    );
    expect(f.reauthorize).not.toHaveBeenCalled();
  } finally {
    release.resolve();
  }
  await screen.findByText("Codex is ready (test@example.com).");
  // Agents' shared server learns of the new credentials.
  expect(f.reauthorize).toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Install Codex" }),
  ).not.toBeInTheDocument();
});
it("offers sign-in without an account and cancels a running sign-in", async () => {
  const f = fixture({ installed: true, signedIn: false });
  render(<f.tabs.SettingsTab {...f.props()} />);
  expect(
    await screen.findByText(
      "Codex needs you to sign in. Sign in from the Codex tab.",
    ),
  ).toBeInTheDocument();
  cleanup();
  render(<f.tabs.CodexTab {...f.props()} />);
  await screen.findByText("Codex needs you to sign in.");
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() =>
    expect(f.spawn).toHaveBeenCalledWith("login", expect.anything()),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(f.step("login").kill).toHaveBeenCalled();
  await screen.findByText(/Sign-in ended \(stopped\)\./);
  await screen.findByRole("button", { name: "Check again" });
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
});
it("leaves Linux sign-in to a terminal, where the browser it opens is safe", async () => {
  const platform = vi
    .spyOn(navigator, "platform", "get")
    .mockReturnValue("Linux x86_64");
  try {
    const f = fixture({ installed: true, signedIn: false });
    render(<f.tabs.CodexTab {...f.props()} />);
    await screen.findByText("Codex needs you to sign in.");
    // A terminal without ~/.local/bin on its PATH still has a command to run.
    expect(screen.getByText("codex login").closest("p")).toHaveTextContent(
      "Run codex login in a terminal, then check again. If the terminal cannot find codex, run ~/.local/bin/codex login.",
    );
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    expect(f.spawn).not.toHaveBeenCalledWith("login", expect.anything());
  } finally {
    platform.mockRestore();
  }
});
it("loads model/effort choices and saves only after a validated workspace, holding the saving state", async () => {
  const f = fixture();
  const saving = deferred<void>();
  const save = vi.fn(() => saving.promise);
  render(<f.tabs.SettingsTab {...f.props(defaults, save)} />);
  await screen.findByRole("option", { name: "Model A" });
  await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "model-b" },
  });
  expect(screen.getByLabelText("Thinking")).toHaveValue("medium");
  expect(
    screen.queryByRole("option", { name: "High" }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "relative" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "/tmp/codex" },
  });
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Custom instructions" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  try {
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        ...defaults,
        model: "model-b",
        effort: "medium",
        workspace: "/tmp/codex",
        instructions: "Custom instructions",
      }),
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByLabelText("Workspace")).toBeDisabled();
  } finally {
    saving.resolve();
  }
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  expect(f.processes[0]?.end).toHaveBeenCalled();
});
it("preserves unavailable saved choices and closes a process returned after unmount", async () => {
  const f = fixture();
  const saved = {
    ...defaults,
    model: "retired-model",
    effort: "high",
    workspace: "/tmp/codex",
  };
  const view = render(<f.tabs.SettingsTab {...f.props(saved)} />);
  await screen.findByRole("option", { name: "retired-model (unavailable)" });
  await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled());
  expect(screen.getByLabelText("Model")).toHaveValue("retired-model");
  expect(screen.getByLabelText("Thinking")).toHaveValue("high");
  view.unmount();
  const late = deferred<Awaited<ReturnType<typeof f.spawn>>>();
  const started = deferred<void>();
  const original = f.spawn.getMockImplementation();
  if (!original) throw new Error("Missing spawn fixture");
  let process!: Awaited<ReturnType<typeof f.spawn>>;
  f.spawn.mockImplementationOnce(async (id, options) => {
    process = await original(id, options);
    started.resolve();
    return late.promise;
  });
  const pending = render(<f.tabs.CodexTab {...f.props(saved)} />);
  await started.promise;
  pending.unmount();
  late.resolve(process);
  await waitFor(() => expect(process.end).toHaveBeenCalled());
});

it("shows the default workspace and restores it when the field is cleared", async () => {
  const f = fixture();
  const save = vi.fn(async () => {});
  render(<f.tabs.SettingsTab {...f.props(defaults, save)} />);
  expect(screen.getByLabelText("Workspace")).toHaveValue("~/.buzz");
  await screen.findByRole("option", { name: "Model A" });
  fireEvent.change(screen.getByLabelText("Instructions"), {
    target: { value: "Test instructions" },
  });
  const expected = { ...defaults, instructions: "Test instructions" };
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expected));
  await waitFor(() => expect(screen.getByLabelText("Workspace")).toBeEnabled());
  save.mockClear();
  fireEvent.change(screen.getByLabelText("Workspace"), {
    target: { value: "   " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expected));
});
