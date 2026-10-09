// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  AgentControl,
  AgentControlState,
} from "../../features/agents/control";
import type { AgentPublication } from "../../features/agents/catalog-protocol";
import type { RelaySession } from "../../features/relay/session";
import { controlFixture } from "../../features/agents/control-testing";
import { rememberAdded } from "./CommunityCatalog";
import { AgentCreateDialog } from "./AgentCreateDialog";

const publication: AgentPublication = {
  kind: 30175,
  eventId: "first",
  owner: "a".repeat(64),
  d: "helper",
  createdAt: 1,
  agent: {
    displayName: "Helper",
    systemPrompt: "Original instructions",
    sessionPolicy: "thread",
  },
};
const scope = "wss://catalog.example.test:viewer";
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function fixture() {
  const native = controlFixture();
  native.data.createAvailable = true;
  native.data.defaultWorkspace = "/fixture/workspace";
  let state: AgentControlState = {
    status: "ready",
    data: native.data,
    busy: false,
    error: null,
  };
  const listeners = new Set<() => void>();
  const publish = (agents: readonly AgentPublication[]) => {
    snapshot = { status: "ready" as const, agents, teams: [] };
    for (const listener of listeners) listener();
  };
  let snapshot = {
    status: "ready" as const,
    agents: [publication] as readonly AgentPublication[],
    teams: [],
  };
  const session = {
    viewer: "viewer",
    scope,
    communityCatalog: {
      available: () => true,
      retain: () => () => {},
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      snapshot: () => snapshot,
    },
  } as unknown as RelaySession;
  const created: typeof native.agent = {
    ...native.agent,
    id: "copy",
    name: "Helper",
    status: "stopped",
    profilePending: true,
  };
  const create = vi.fn<NonNullable<AgentControl["create"]>>(
    async (_request, _destination, _owner, _edit) => {
      native.data.agents.push(created);
      return created;
    },
  );
  const action = vi.fn(async () => {
    created.status = "running";
    return native.data;
  });
  const profile = vi.fn(async () => {
    created.profilePending = false;
    return native.data;
  });
  const control = {
    snapshot: () => state,
    create,
    action,
    publishProfile: profile,
    refresh: vi.fn(async () => {}),
  } as unknown as AgentControl;
  const close = vi.fn();
  const view = render(
    <AgentCreateDialog
      control={control}
      state={state}
      destination="https://catalog.example.test"
      owner="viewer"
      onClose={close}
      catalogSession={session}
    />,
  );
  const select = () =>
    fireEvent.click(screen.getByRole("button", { name: "Helper" }));
  return {
    native,
    control,
    create,
    action,
    profile,
    close,
    view,
    select,
    publish,
    setState: (next: AgentControlState) => {
      state = next;
      view.rerender(
        <AgentCreateDialog
          control={control}
          state={next}
          destination="https://catalog.example.test"
          owner="viewer"
          onClose={close}
          catalogSession={session}
        />,
      );
    },
  };
}

it("resolves the current head and refuses a withdrawn or already adopted agent, but permits re-add after deletion", async () => {
  const f = fixture();
  f.select();
  const add = () => screen.getByRole("button", { name: "Add agent" });
  expect(
    within(screen.getByRole("region", { name: "Helper" })).getByText(
      "Original instructions",
    ),
  ).toBeVisible();
  const replacement = {
    ...publication,
    eventId: "second",
    createdAt: 2,
    agent: { ...publication.agent, systemPrompt: "Replacement instructions" },
  };
  act(() => f.publish([replacement]));
  expect(screen.getByText("Replacement instructions")).toBeVisible();
  act(() => f.publish([]));
  expect(screen.getByText(/no longer shared/)).toBeVisible();
  expect(add()).toBeDisabled();
  act(() => f.publish([replacement]));
  rememberAdded(scope, "viewer", replacement, "copy");
  f.native.data.agents.push({ ...f.native.agent, id: "copy" });
  f.setState({ ...f.control.snapshot() });
  expect(
    screen.getByRole("button", { name: "Added to My Agents" }),
  ).toBeDisabled();
  f.native.data.agents.pop();
  f.setState({ ...f.control.snapshot() });
  expect(add()).toBeEnabled();
  fireEvent.click(add());
  await waitFor(() => expect(f.create).toHaveBeenCalledOnce());
  expect(f.create.mock.calls[0]?.[3]).toMatchObject({
    systemPrompt: "Replacement instructions",
  });
});

it.each(["start", "profile"])(
  "recovers a saved catalog identity after %s failure without recreating it",
  async (failure) => {
    const f = fixture();
    if (failure === "start")
      f.action.mockRejectedValueOnce(Error("start refused"));
    else f.profile.mockRejectedValueOnce(Error("profile refused"));
    f.select();
    fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
    const retry = failure === "start" ? "Start agent" : "Finish profile";
    await waitFor(() =>
      expect(screen.getByRole("button", { name: retry })).toBeEnabled(),
    );
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
    expect(f.create).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: retry }));
    await waitFor(() => expect(f.close).toHaveBeenCalledOnce());
    expect(f.create).toHaveBeenCalledOnce();
  },
);

it("keeps catalog status recovery and Close available when Create cannot be confirmed", async () => {
  const f = fixture();
  f.create.mockRejectedValueOnce(Error("create timed out"));
  f.select();
  fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
  await waitFor(() => expect(f.control.refresh).toHaveBeenCalledOnce());
  f.setState({ ...f.control.snapshot(), status: "error" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Retry status" })).toBeEnabled(),
  );
  expect(screen.getByRole("button", { name: "Add agent" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Start agent" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
  expect(f.control.refresh).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(f.close).toHaveBeenCalledOnce();
});

it("allows Close during deferred catalog Create without late dismissal", async () => {
  const f = fixture();
  let complete!: (
    agent: Awaited<ReturnType<NonNullable<AgentControl["create"]>>>,
  ) => void;
  f.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  f.select();
  fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
  expect(screen.getByRole("status", { name: "" })).toHaveTextContent(
    "Adding agent…",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(f.close).toHaveBeenCalledOnce();
  f.view.unmount();
  await act(async () => complete(f.native.agent));
  expect(f.close).toHaveBeenCalledOnce();
});

it("does not admit the viewer's own publication", () => {
  const f = fixture();
  act(() => f.publish([{ ...publication, owner: "viewer" }]));
  f.select();
  expect(
    screen.getByRole("button", { name: "Added to My Agents" }),
  ).toBeDisabled();
});
