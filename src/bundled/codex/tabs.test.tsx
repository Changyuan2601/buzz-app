// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentViewProps } from "../../features/agents2/service";
import type { HostProcessOptions } from "../../features/host/service";
import { defaults, type Config } from "./config";
import { createTabs } from "./tabs";
import { CodexRuntime } from "./runtime";
import type { Wire } from "./rpc";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(cleanup);
function fixture() {
  const processes: { end: ReturnType<typeof vi.fn> }[] = [];
  const spawn = vi.fn(async (_id: string, options?: HostProcessOptions) => {
    const exit = deferred<number | null>();
    const process = {
      write: async (text: string) => {
        const wire: Wire = JSON.parse(text);
        if (wire.id == null) return;
        let result: unknown = {};
        if (wire.method === "account/read")
          result = { account: { type: "chatgpt", email: "test@example.com" } };
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
  const tabs = createTabs(React, spawn, runtime);
  const props = (settings = defaults, save = vi.fn(async () => {})) =>
    ({
      agent: { pubkey: "a".repeat(64), config: settings },
      save,
    }) as unknown as AgentViewProps<Config>;
  return { spawn, processes, tabs, props };
}
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
