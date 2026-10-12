// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostRequest, HostResponse } from "../../../features/host/service";
import { createOAuthSession } from "../oauth/session";
import { deferred } from "../test-helpers";
import { createAgentClient } from "./client";
import { RemoteAgents } from "./RemoteAgents";
import { enrollmentFixture } from "./enrollment-testing";
import { PublishRejected } from "../../../features/relay/outbox";
import { StrictMode } from "react";

const enrollments: ReturnType<typeof enrollmentFixture>[] = [];

beforeEach(() => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: unknown,
        work: () => Promise<void>,
      ) => work(),
    },
  });
});
afterEach(async () => {
  cleanup();
  for (const fixture of enrollments.splice(0)) await fixture.dispose();
  vi.restoreAllMocks();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "locks");
});
const row = {
  agent_id: "one",
  agent_name: "Helper",
  agent_pubkey: "ab".repeat(32),
  status: 2,
};
const response = (agents: unknown[], status = 200): HostResponse => ({
  status,
  headers: {},
  body: JSON.stringify({ status: 1, agents }),
});
async function fixture(
  selected: string | null = null,
  kinds?: readonly number[],
) {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const session = createOAuthSession(async () => ({
    value: "secret",
    account: { subject: "user", email: "a@example.com" },
  }));
  await session.signIn();
  const community = enrollmentFixture(session, selected, kinds);
  enrollments.push(community);
  const request = vi.fn(async (_input: HostRequest) => response([row]));
  const authorize = vi.fn(
    async () => ["auth", community.viewer, "", "ef".repeat(64)] as const,
  );
  const client = createAgentClient(
    {
      request,
      fetch: vi.fn(),
      runCommand: vi.fn(),
      prepareRemoteAgentAuthorization: authorize,
    },
    session,
    () => undefined,
  );
  return {
    session,
    client,
    request,
    authorize,
    community,
    enrollment: community.enrollment,
  };
}
afterEach(() => vi.unstubAllEnvs());
it.each(["unsupported relay", "storage failure"])(
  "restores Finish setup when deletion preflight fails: %s",
  async (failure) => {
    const h = await fixture(
      "https://community.example",
      failure === "unsupported relay" ? [30177] : undefined,
    );
    h.request.mockResolvedValue(response([{ ...row, status: 1 }]));
    render(<RemoteAgents {...h} active={() => true} />);
    await screen.findByText("Helper · Unattested");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Finish setup" }),
      ).toBeEnabled(),
    );
    if (failure === "storage failure")
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("storage full");
      });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      failure === "storage failure" ? "storage full" : "Connect",
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Finish setup" }),
      ).toBeEnabled(),
    );
    expect(
      screen.queryByText("Deletion pending. Retry Delete."),
    ).not.toBeInTheDocument();
    expect(h.community.publish).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledTimes(1);
  },
);
it("confirms deletion, waits for the relay, and keeps a failed backend deletion retryable", async () => {
  const h = await fixture("https://community.example");
  let deleted = false;
  let attempts = 0;
  h.request.mockImplementation(async (input) => {
    if (!input.url.endsWith("/delete-agent"))
      return response(deleted ? [] : [row]);
    attempts++;
    if (attempts === 1) return response([], 503);
    deleted = true;
    return { status: 200, headers: {}, body: '{"status":1}' };
  });
  const publication = deferred<void>();
  const publish = h.community.publish.getMockImplementation();
  if (!publish) throw new Error("Missing publisher");
  h.community.publish.mockImplementationOnce(async (event) => {
    await publication.promise;
    return publish(event);
  });
  render(
    <StrictMode>
      <RemoteAgents {...h} active={() => true} />
    </StrictMode>,
  );
  await screen.findByText("Helper · Active");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh agents" }),
    ).toBeEnabled(),
  );
  const user = userEvent.setup();
  const confirm = async () => {
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Helper?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
  };
  try {
    await confirm();
    await waitFor(() => expect(h.community.publish).toHaveBeenCalledTimes(1));
    expect(attempts).toBe(0);
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Refresh agents" }),
    ).toBeDisabled();
    await act(async () => publication.resolve());
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 503");
    expect(screen.getByText("Helper · Active")).toBeInTheDocument();
    expect(
      screen.getByText("Deletion pending. Retry Delete."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled(),
    );
    await confirm();
    expect(
      await screen.findByText("No remote agents yet."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Refresh agents" }),
      ).toBeEnabled(),
    );
    expect(attempts).toBe(2);
  } finally {
    await act(async () => publication.resolve());
  }
});

it("allows canceling confirmation and deletes directly from Builderlab in Personal space", async () => {
  const h = await fixture();
  render(<RemoteAgents {...h} active={() => true} />);
  await screen.findByText("Helper · Active");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh agents" }),
    ).toBeEnabled(),
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Delete" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  expect(h.request).toHaveBeenCalledTimes(1);
  h.request
    .mockResolvedValueOnce({
      status: 200,
      headers: {},
      body: '{"status":"DELETE_AGENT_STATUS_NOT_FOUND"}',
    })
    .mockResolvedValue(response([]));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  await user.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Delete",
    }),
  );
  expect(await screen.findByText("No remote agents yet.")).toBeInTheDocument();
  // Complete the list refresh before asserting no relay work happened.
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh agents" }),
    ).toBeEnabled(),
  );
  expect(h.community.sign).not.toHaveBeenCalled();
  expect(h.community.publish).not.toHaveBeenCalled();
});
it("loads automatically, refreshes and hides account data on sign-out", async () => {
  const h = await fixture();
  render(<RemoteAgents {...h} active={() => true} />);
  expect(await screen.findByText("Helper · Active")).toBeInTheDocument();
  expect(screen.getByText(row.agent_pubkey)).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent("secret");
  h.request.mockResolvedValue(response([]));
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Refresh agents" }));
  expect(await screen.findByText("No remote agents yet.")).toBeInTheDocument();
  act(() => h.session.signOut());
  expect(
    screen.queryByRole("region", { name: "Remote agents" }),
  ).not.toBeInTheDocument();
});
it("edits listed instructions, preserves a dirty draft across refresh, cancels and clears", async () => {
  const h = await fixture();
  let instructions = "Original instructions.";
  const second = {
    ...row,
    agent_id: "two",
    agent_name: "Second",
    agent_pubkey: "bc".repeat(32),
    status: 3,
  };
  h.request.mockImplementation(async (input) => {
    if (input.url.endsWith("/update-agent")) {
      instructions = JSON.parse(input.body ?? "{}").agent_instructions;
      return { status: 200, headers: {}, body: "{}" };
    }
    return response([{ ...row, agent_instructions: instructions }, second]);
  });
  render(
    <StrictMode>
      <RemoteAgents {...h} active={() => true} />
    </StrictMode>,
  );
  const user = userEvent.setup();
  const edit = await screen.findByRole("button", { name: "Edit" });
  await waitFor(() => expect(edit).toBeEnabled());
  await user.click(edit);
  const draft = screen.getByRole("textbox", {
    name: "Agent instructions for Helper",
  });
  expect(draft).toHaveValue(instructions);
  expect(
    screen.getByRole("button", { name: "Save instructions" }),
  ).toBeDisabled();
  await user.clear(draft);
  await user.type(draft, "Unsaved draft.");
  await user.click(screen.getByRole("button", { name: "Refresh agents" }));
  await waitFor(() => expect(draft).toBeEnabled());
  expect(draft).toHaveValue("Unsaved draft.");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Edit" }));
  const restored = screen.getByRole("textbox", {
    name: "Agent instructions for Helper",
  });
  expect(restored).toHaveValue("Original instructions.");
  expect(
    h.request.mock.calls.every(([input]) => input.url.endsWith("/list-agents")),
  ).toBe(true);
  await user.clear(restored);
  await user.type(restored, "   ");
  expect(
    screen.getByRole("button", { name: "Save instructions" }),
  ).toBeDisabled();
  await user.clear(restored);
  await user.click(screen.getByRole("button", { name: "Save instructions" }));
  await screen.findByRole("button", { name: "Edit" });
  expect(
    screen
      .getAllByRole("listitem")
      .map((item) => within(item).getByText(/ · /).textContent),
  ).toEqual(["Helper · Active", "Second · Revoked"]);
  await user.click(screen.getByRole("button", { name: "Edit" }));
  expect(
    screen.getByRole("textbox", { name: "Agent instructions for Helper" }),
  ).toHaveValue("");
  expect(
    h.request.mock.calls.filter(([input]) =>
      input.url.endsWith("/update-agent"),
    ),
  ).toHaveLength(1);
  expect(h.community.publish).not.toHaveBeenCalled();
  expect(h.authorize).not.toHaveBeenCalled();
});
it.each(["new login", "deletion"])(
  "fences a held instruction save after %s",
  async (cause) => {
    const h = await fixture();
    render(<RemoteAgents {...h} active={() => true} />);
    const user = userEvent.setup();
    const edit = await screen.findByRole("button", {
      name: "Edit",
    });
    await waitFor(() => expect(edit).toBeEnabled());
    await user.click(edit);
    await user.type(
      screen.getByRole("textbox", { name: "Agent instructions for Helper" }),
      "Private draft.",
    );
    const held = deferred<HostResponse>();
    h.request.mockReturnValueOnce(held.promise);
    try {
      await user.click(
        screen.getByRole("button", { name: "Save instructions" }),
      );
      await waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
      if (cause === "new login") {
        act(() => h.session.signOut());
        await act(async () => h.session.signIn());
        await screen.findByRole("button", { name: "Edit" });
        await act(async () => held.resolve(response([], 503)));
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(
          screen.queryByRole("textbox", {
            name: "Agent instructions for Helper",
          }),
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Edit" }));
        expect(
          screen.getByRole("textbox", {
            name: "Agent instructions for Helper",
          }),
        ).toHaveValue("");
      } else {
        // Another window deletes this identity while the update is in transport.
        await h.enrollment.remove(
          {
            id: row.agent_id,
            name: row.agent_name,
            pubkey: row.agent_pubkey,
            status: "Active",
          },
          { delete: vi.fn(async () => {}) },
          new AbortController().signal,
          () => true,
        );
        await act(async () =>
          held.resolve({ status: 200, headers: {}, body: "{}" }),
        );
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Agent deletion has started",
        );
        expect(
          screen.getByRole("textbox", {
            name: "Agent instructions for Helper",
          }),
        ).toHaveValue("Private draft.");
        await user.click(
          screen.getByRole("button", { name: "Save instructions" }),
        );
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled(),
        );
        expect(h.request).toHaveBeenCalledTimes(2);
      }
    } finally {
      await act(async () => held.resolve(response([], 503)));
    }
  },
);
it("shows a held loading state and retries a failed read", async () => {
  const h = await fixture();
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  render(<RemoteAgents {...h} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading remote agents");
  expect(
    screen.getByRole("button", { name: "Refresh agents" }),
  ).toHaveAttribute("aria-disabled", "true");
  await act(async () => held.resolve(response([], 503)));
  expect(screen.getByRole("alert")).toHaveTextContent("HTTP 503");
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Helper · Active")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it.each(["sign-out", "unmount"])(
  "ignores held reads after %s",
  async (action) => {
    const h = await fixture();
    const held = deferred<HostResponse>();
    h.request.mockReturnValue(held.promise);
    const mounted = render(<RemoteAgents {...h} active={() => true} />);
    if (action === "sign-out") act(() => h.session.signOut());
    else mounted.unmount();
    await act(async () => held.resolve(response([row])));
    expect(screen.queryByText("Helper · Active")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  },
);

it("creates with instructions, locks controls through setup and retries a failed save without recreating", async () => {
  const h = await fixture("https://community.example");
  const update = vi.spyOn(h.client, "updateInstructions");
  h.request.mockResolvedValueOnce(response([]));
  render(<RemoteAgents {...h} active={() => true} />);
  await screen.findByText("No remote agents yet.");
  const held = deferred<HostResponse>();
  const attestation = deferred<HostResponse>();
  const publication = deferred<void>();
  const instructionsSave = deferred<HostResponse>();
  const publish = h.community.publish.getMockImplementation();
  if (!publish) throw new Error("Missing publisher");
  h.community.publish.mockImplementationOnce(async (event) => {
    await publication.promise;
    return publish(event);
  });
  h.request
    .mockReturnValueOnce(held.promise)
    .mockReturnValueOnce(attestation.promise)
    .mockReturnValueOnce(instructionsSave.promise);
  const user = userEvent.setup();
  const registered = {
    status: 200,
    headers: {},
    body: JSON.stringify({
      status: 1,
      agent_id: row.agent_id,
      agent_pubkey: row.agent_pubkey,
    }),
  };
  try {
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Agent name" })).toBeEnabled(),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Agent name" }),
      "Helper",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Agent instructions (optional)" }),
      "Review carefully.",
    );
    await user.click(screen.getByRole("button", { name: "Create agent" }));
    expect(screen.getByRole("textbox", { name: "Agent name" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "Agent instructions (optional)" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Refresh agents" }),
    ).toBeDisabled();
    await act(async () => held.resolve(registered));
    await waitFor(() => expect(h.request).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Helper · Unattested")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Agent name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Finish setup" })).toBeDisabled();
    await act(async () =>
      attestation.resolve({ status: 200, headers: {}, body: '{"status":1}' }),
    );
    await waitFor(() => expect(h.community.publish).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Helper · Active")).toBeInTheDocument();
    expect(
      screen.getByText("Community registration pending."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Agent name" })).toBeDisabled();
    await act(async () => publication.resolve());
    expect(
      await screen.findByText("Registration confirmed in this community."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ pubkey: row.agent_pubkey, status: "Active" }),
        "Review carefully.",
        expect.any(AbortSignal),
      ),
    );
    expect(
      screen.getByRole("textbox", { name: "Agent instructions for Helper" }),
    ).toBeDisabled();
    await act(async () =>
      instructionsSave.resolve({ status: 503, headers: {}, body: "{}" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 503");
    expect(
      screen.getByRole("textbox", { name: "Agent instructions for Helper" }),
    ).toHaveValue("Review carefully.");
    h.request.mockResolvedValueOnce({ status: 200, headers: {}, body: "{}" });
    await user.click(screen.getByRole("button", { name: "Save instructions" }));
    await screen.findByRole("button", { name: "Edit" });
    expect(
      h.request.mock.calls.filter(([input]) =>
        input.url.endsWith("/register-agent"),
      ),
    ).toHaveLength(1);
    expect(update).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => {
      held.resolve(registered);
      attestation.resolve({ status: 200, headers: {}, body: '{"status":1}' });
      publication.resolve();
      instructionsSave.resolve({ status: 200, headers: {}, body: "{}" });
    });
  }
  expect(screen.getByRole("textbox", { name: "Agent name" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Agent name" })).toBeEnabled();
  expect(
    screen.getByRole("textbox", { name: "Agent instructions (optional)" }),
  ).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Edit" }));
  expect(
    screen.getByRole("textbox", { name: "Agent instructions for Helper" }),
  ).toHaveValue("Review carefully.");
  expect(screen.getByRole("button", { name: "Refresh agents" })).toBeEnabled();
  expect(JSON.stringify(h.community.publish.mock.calls)).not.toContain(
    "Review carefully.",
  );
  expect(JSON.stringify(Object.values(localStorage))).not.toContain(
    "Review carefully.",
  );
});

it.each(["Active", "Revoked"])(
  "retries only the selected agent and rechecks a previously Active agent now %s",
  async (status) => {
    const h = await fixture("https://community.example");
    const second = {
      ...row,
      agent_id: "two",
      agent_name: "Second",
      agent_pubkey: "bc".repeat(32),
    };
    h.request.mockResolvedValue(response([row, second]));
    for (const agent of [row, second])
      h.enrollment.remember(h.enrollment.capture(), {
        id: agent.agent_id,
        name: agent.agent_name,
        pubkey: agent.agent_pubkey,
        status: "Active",
      });
    let refused = true;
    const publish = h.community.publish.getMockImplementation();
    if (!publish) throw new Error("Missing publisher");
    h.community.publish.mockImplementation(async (event) => {
      if (
        refused &&
        event.tags.some(
          ([key, value]) => key === "d" && value === row.agent_pubkey,
        )
      )
        throw new PublishRejected("registration refused");
      return publish(event);
    });
    render(<RemoteAgents {...h} active={() => true} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "registration refused",
    );
    expect(screen.getByText("Helper · Active")).toBeInTheDocument();
    const user = userEvent.setup();
    const secondRow = screen.getByText("Second · Active").closest("li");
    if (!secondRow) throw new Error("Missing second agent row");
    if (status === "Active") {
      await user.click(within(secondRow).getByRole("button", { name: "Edit" }));
      await user.type(
        within(secondRow).getByRole("textbox", {
          name: "Agent instructions for Second",
        }),
        "Unsaved edit.",
      );
    }
    await user.click(
      within(secondRow).getByRole("button", { name: "Retry community setup" }),
    );
    expect(
      await screen.findByText("Registration confirmed in this community."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Community registration pending."),
    ).toBeInTheDocument();
    if (status === "Active")
      expect(
        screen.getByRole("textbox", { name: "Agent instructions for Second" }),
      ).toHaveValue("Unsaved edit.");
    refused = false;
    h.request.mockResolvedValue(
      response([{ ...row, status: status === "Active" ? 2 : 3 }, second]),
    );
    await user.click(
      screen.getByRole("button", { name: "Retry community setup" }),
    );
    if (status === "Active") {
      await waitFor(() =>
        expect(
          screen.getAllByText("Registration confirmed in this community."),
        ).toHaveLength(2),
      );
      expect(
        screen.queryByText("Community registration pending."),
      ).not.toBeInTheDocument();
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Agent is no longer Active",
      );
      expect(screen.getByText("Helper · Revoked")).toBeInTheDocument();
      expect(
        screen.getByText("Community registration pending."),
      ).toBeInTheDocument();
    }
    expect(
      h.request.mock.calls.every(([input]) =>
        input.url.endsWith("/list-agents"),
      ),
    ).toBe(true);
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(h.community.publish).toHaveBeenCalledTimes(
      status === "Active" ? 3 : 2,
    );
  },
);
it.each(["attestation", "enrollment storage"])(
  "keeps the registered identity after %s failure and finishes without registering again",
  async (failure) => {
    const h = await fixture(
      failure === "enrollment storage" ? "https://community.example" : null,
    );
    h.request.mockResolvedValueOnce(response([]));
    render(<RemoteAgents {...h} active={() => true} />);
    await screen.findByText("No remote agents yet.");
    const registered = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        status: 1,
        agent_id: row.agent_id,
        agent_pubkey: row.agent_pubkey,
      }),
    };
    const registration = deferred<HostResponse>();
    h.request.mockReturnValueOnce(registration.promise);
    if (failure === "attestation")
      h.request.mockResolvedValueOnce(response([], 503));
    const user = userEvent.setup();
    try {
      await waitFor(() =>
        expect(
          screen.getByRole("textbox", { name: "Agent name" }),
        ).toBeEnabled(),
      );
      await user.type(
        screen.getByRole("textbox", { name: "Agent name" }),
        "Helper",
      );
      await user.type(
        screen.getByRole("textbox", { name: "Agent instructions (optional)" }),
        "Keep this draft.",
      );
      await user.click(screen.getByRole("button", { name: "Create agent" }));
      await waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
      if (failure === "enrollment storage")
        vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
          throw new Error("storage unavailable");
        });
      await act(async () => registration.resolve(registered));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        failure === "attestation" ? "HTTP 503" : "storage unavailable",
      );
      expect(screen.getByText("Helper · Unattested")).toBeInTheDocument();
      if (failure === "enrollment storage") {
        expect(h.authorize).not.toHaveBeenCalled();
        expect(h.community.publish).not.toHaveBeenCalled();
        vi.restoreAllMocks();
      }
      const update = vi.spyOn(h.client, "updateInstructions");
      h.request.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: '{"status":1}',
      });
      await user.click(screen.getByRole("button", { name: "Finish setup" }));
      expect(await screen.findByText("Helper · Active")).toBeInTheDocument();
      if (failure === "enrollment storage")
        expect(
          await screen.findByText("Registration confirmed in this community."),
        ).toBeInTheDocument();
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith(
          expect.objectContaining({
            pubkey: row.agent_pubkey,
            status: "Active",
          }),
          "Keep this draft.",
          expect.any(AbortSignal),
        ),
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled(),
      );
      expect(
        h.request.mock.calls.filter(([input]) =>
          input.url.endsWith("/register-agent"),
        ),
      ).toHaveLength(1);
    } finally {
      await act(async () => registration.resolve(registered));
    }
  },
);
it("does not attest or show a held registration after sign-out", async () => {
  const h = await fixture();
  render(<RemoteAgents {...h} active={() => true} />);
  await screen.findByText("Helper · Active");
  const held = deferred<HostResponse>();
  h.request.mockReturnValueOnce(held.promise);
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("textbox", { name: "Agent name" }),
    "Another",
  );
  await user.click(screen.getByRole("button", { name: "Create agent" }));
  act(() => h.session.signOut());
  await act(async () =>
    held.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({
        status: 1,
        agent_id: "two",
        agent_pubkey: row.agent_pubkey,
      }),
    }),
  );
  expect(h.authorize).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("region", { name: "Remote agents" }),
  ).not.toBeInTheDocument();
});

it.each([
  { stage: "registration", cause: "ownership loss" },
  { stage: "signing", cause: "ownership loss" },
  { stage: "signing", cause: "deletion" },
])(
  "does not continue creation after $cause during $stage",
  async ({ stage, cause }) => {
    const h = await fixture();
    let active = true;
    render(<RemoteAgents {...h} active={() => active} />);
    await screen.findByText("Helper · Active");
    const registered = {
      status: 200,
      headers: {},
      body: JSON.stringify({
        status: 1,
        agent_id: "two",
        agent_pubkey: row.agent_pubkey,
      }),
    };
    const registration = deferred<HostResponse>();
    const signing = deferred<Awaited<ReturnType<typeof h.authorize>>>();
    const proof = ["auth", "cd".repeat(32), "", "ef".repeat(64)] as const;
    if (stage === "registration")
      h.request.mockReturnValueOnce(registration.promise);
    else {
      h.request.mockResolvedValueOnce(registered);
      h.authorize.mockReturnValueOnce(signing.promise);
    }
    try {
      const user = userEvent.setup();
      await user.type(
        screen.getByRole("textbox", { name: "Agent name" }),
        "Another",
      );
      await user.click(screen.getByRole("button", { name: "Create agent" }));
      await waitFor(() => {
        expect(h.request).toHaveBeenCalledTimes(2);
        expect(h.authorize).toHaveBeenCalledTimes(
          stage === "registration" ? 0 : 1,
        );
      });
      if (cause === "deletion") {
        // A different window deletes the already-registered identity while this
        // window is waiting for owner authorization.
        await h.enrollment.remove(
          {
            id: "two",
            name: "Another",
            pubkey: row.agent_pubkey,
            status: "Unattested",
          },
          { delete: vi.fn(async () => {}) },
          new AbortController().signal,
          () => true,
        );
      } else {
        // Revoke ownership before effect cleanup: the signal is still live.
        active = false;
      }
      await act(async () => {
        registration.resolve(registered);
        signing.resolve(proof);
      });
      expect(h.request).toHaveBeenCalledTimes(2);
      expect(h.authorize).toHaveBeenCalledTimes(
        stage === "registration" ? 0 : 1,
      );
      expect(screen.queryAllByText("Another · Unattested")).toHaveLength(
        stage === "registration" ? 0 : 1,
      );
      expect(screen.queryByText("Another · Active")).not.toBeInTheDocument();
      if (cause === "deletion")
        expect(screen.getByRole("alert")).toBeInTheDocument();
      else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      registration.resolve(registered);
      signing.resolve(proof);
    }
  },
);
