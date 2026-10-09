// @vitest-environment jsdom
import { deflateSync } from "node:zlib";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { controlFixture } from "../../features/agents/control-testing";
import {
  createAgentControl,
  type AgentControl,
} from "../../features/agents/control";
import {
  buildAgentSnapshot,
  encodeAgentSnapshot,
  parseAgentSnapshot,
  snapshotPngArtwork,
} from "../../features/agents/snapshot";
import { AgentSnapshotExport, AgentSnapshotImport } from "./AgentSnapshots";
import { uploadAvatar } from "../../features/profiles/avatar-upload";

vi.mock("../../features/profiles/avatar-upload", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../features/profiles/avatar-upload")
  >()),
  uploadAvatar: vi.fn(),
}));
vi.mock("../../features/communities/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../features/communities/api")>()),
  communityRequest: vi.fn(async () => ({ auth: [] })),
}));

const portableAgent = () => {
  const { agent } = controlFixture();
  agent.harness.command = "buzz-agent";
  agent.sessionPolicy = "thread";
  agent.harness.environmentKeys = [];
  return agent;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function file(level: "none" | "core" = "none") {
  const snapshot = buildAgentSnapshot(portableAgent(), level, [
    { slug: "core", body: "private fixture memory" },
  ]);
  return new File(
    [Uint8Array.from(encodeAgentSnapshot(snapshot, "json"))],
    "agent.json",
    { type: "application/json" },
  );
}
function importControl() {
  const create = vi.fn(
    async (
      _requestId: string,
      _destination: string,
      _owner: string,
      _edit: unknown,
    ) => ({ ...controlFixture().agent, id: "new-id", pubkey: "cd".repeat(32) }),
  );
  const writeSnapshotMemory = vi.fn(
    async (): Promise<{
      written: number;
      total: number;
      errors: string[];
    }> => ({ written: 1, total: 1, errors: [] }),
  );
  const refresh = vi.fn(async () => {});
  const control = {
    create,
    writeSnapshotMemory,
    refresh,
    snapshot: () => ({
      status: "ready",
      data: {
        harnessOptions: [
          { command: "buzz-agent", defaultArgs: [], available: true },
        ],
        defaultWorkspace: "/local",
      },
    }),
  } as unknown as AgentControl;
  return { control, create, writeSnapshotMemory, refresh };
}
function choose(fileToRead: File) {
  fireEvent.change(screen.getByLabelText("Agent snapshot"), {
    target: { files: [fileToRead] },
  });
}

it.each(["json", "png"] as const)(
  "previews received %s bytes in the existing import dialog without a file picker or creation",
  async (format) => {
    const h = importControl();
    const close = vi.fn();
    const receivedBytes = encodeAgentSnapshot(
      buildAgentSnapshot(portableAgent()),
      format,
    );
    render(
      <AgentSnapshotImport
        control={h.control}
        destination="https://relay.example.test"
        owner={"ef".repeat(32)}
        receivedBytes={receivedBytes}
        onClose={close}
      />,
    );
    expect(await screen.findByText("Help with the project.")).toBeVisible();
    expect(screen.queryByLabelText("Agent snapshot")).not.toBeInTheDocument();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledOnce();
    expect(h.create).not.toHaveBeenCalled();
  },
);

it("refuses malformed received bytes before import and cannot create", async () => {
  const h = importControl();
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={new TextEncoder().encode("not a snapshot")}
      onClose={() => {}}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Invalid snapshot JSON.",
  );
  expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  expect(screen.queryByLabelText("Agent snapshot")).not.toBeInTheDocument();
  expect(h.create).not.toHaveBeenCalled();
});

it("imports received bytes only after the explicit Import click", async () => {
  const h = importControl();
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={encodeAgentSnapshot(
        buildAgentSnapshot(portableAgent(), "core", [
          { slug: "core", body: "private fixture memory" },
        ]),
        "json",
      )}
      onClose={() => {}}
    />,
  );
  expect(await screen.findByText("Help with the project.")).toBeVisible();
  expect(
    screen.getByRole("checkbox", { name: /Restore memory/ }),
  ).not.toBeChecked();
  expect(h.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
});

it("uploads an embedded reference avatar before native creation and saves its local URL", async () => {
  const h = importControl();
  vi.mocked(uploadAvatar).mockResolvedValueOnce(
    "https://relay.example.test/media/avatar.png",
  );
  const snapshot = buildAgentSnapshot(portableAgent());
  snapshot.profile.avatarDataUrl = "data:image/png;base64,iVBORw0KGgo=";
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  choose(new File([encodeAgentSnapshot(snapshot, "json")], "agent.json"));
  expect(await screen.findByText("Help with the project.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(uploadAvatar).toHaveBeenCalledWith(
    expect.objectContaining({ type: "image/png" }),
    "https://relay.example.test",
    expect.any(AbortSignal),
  );
  expect(h.create.mock.calls[0]?.[3]).toEqual(
    expect.objectContaining({
      picture: "https://relay.example.test/media/avatar.png",
    }),
  );
});

it("previews instructions without creating, cancels, then creates an independent stopped identity without memory", async () => {
  const h = importControl();
  const close = vi.fn();
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={close}
    />,
  );
  choose(file());
  expect(await screen.findByText("Help with the project.")).toBeVisible();
  expect(screen.getByText("No memory included — config only.")).toBeVisible();
  expect(h.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(h.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(h.create.mock.calls[0]?.[3]).toEqual(
    expect.objectContaining({
      environment: {},
      workspace: "/local",
      systemPrompt: "Help with the project.",
    }),
  );
  expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
});

it("publishes opted-in memory only after a fresh identity has been created", async () => {
  const h = importControl();
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  choose(file("core"));
  expect(await screen.findByText("Help with the project.")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("plaintext");
  expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Restore memory/ }));
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() =>
    expect(h.writeSnapshotMemory).toHaveBeenCalledWith("new-id", [
      { slug: "core", body: "private fixture memory" },
    ]),
  );
  expect(h.create.mock.invocationCallOrder[0]).toBeLessThan(
    h.writeSnapshotMemory.mock.invocationCallOrder[0] ?? 0,
  );
});

it.each([
  [
    {
      written: 0,
      total: 1,
      errors: ["core: memory restore failed; retry this agent"],
    },
    "0 of 1",
  ],
  [{ written: 1, total: 2, errors: [] }, "1 of 1"],
])(
  "reports incomplete native memory confirmation after creating the identity",
  async (receipt, count) => {
    const h = importControl();
    h.writeSnapshotMemory.mockResolvedValueOnce(receipt);
    render(
      <AgentSnapshotImport
        control={h.control}
        destination="https://relay.example.test"
        owner={"ef".repeat(32)}
        onClose={() => {}}
      />,
    );
    choose(file("core"));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Restore memory/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(h.writeSnapshotMemory).toHaveBeenCalledOnce());
    expect(await screen.findByRole("alert")).toHaveTextContent(count);
    expect(h.create).toHaveBeenCalledOnce();
  },
);

it.each(["partial", "rejected"] as const)(
  "retries %s memory restoration against the created identity without creating again",
  async (failure) => {
    const h = importControl();
    if (failure === "partial") {
      h.writeSnapshotMemory.mockResolvedValueOnce({
        written: 0,
        total: 1,
        errors: ["core: retry this agent"],
      });
    } else {
      h.writeSnapshotMemory.mockRejectedValueOnce(
        new Error("relay unavailable"),
      );
    }
    let finishRetry:
      | ((receipt: {
          written: number;
          total: number;
          errors: string[];
        }) => void)
      | undefined;
    h.writeSnapshotMemory.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRetry = resolve;
        }),
    );
    render(
      <AgentSnapshotImport
        control={h.control}
        destination="https://relay.example.test"
        owner={"ef".repeat(32)}
        onClose={() => {}}
      />,
    );
    choose(file("core"));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Restore memory/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    const retry = await screen.findByRole("button", {
      name: "Retry memory restore",
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      failure === "partial"
        ? "Memory partially restored"
        : "Memory restoration unconfirmed",
    );
    fireEvent.click(retry);
    await waitFor(() => expect(h.writeSnapshotMemory).toHaveBeenCalledTimes(2));
    expect(retry).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      failure === "partial"
        ? "Memory partially restored"
        : "Memory restoration unconfirmed",
    );
    expect(h.writeSnapshotMemory).toHaveBeenNthCalledWith(2, "new-id", [
      { slug: "core", body: "private fixture memory" },
    ]);
    expect(h.create).toHaveBeenCalledOnce();
    await act(async () => finishRetry?.({ written: 1, total: 1, errors: [] }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Retry memory restore" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(h.create).toHaveBeenCalledOnce();
  },
);

it("keeps the memory retry available after another incomplete confirmation", async () => {
  const h = importControl();
  h.writeSnapshotMemory.mockResolvedValueOnce({
    written: 0,
    total: 1,
    errors: [],
  });
  h.writeSnapshotMemory.mockResolvedValueOnce({
    written: 1,
    total: 2,
    errors: [],
  });
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  choose(file("core"));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Restore memory/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry memory restore" }),
  );
  await waitFor(() => expect(h.writeSnapshotMemory).toHaveBeenCalledTimes(2));
  expect(
    screen.getByRole("button", { name: "Retry memory restore" }),
  ).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "1 of 1 entries confirmed",
  );
  expect(h.create).toHaveBeenCalledOnce();
});

it("recovers controller error before retrying memory on the same identity", async () => {
  const fixture = controlFixture();
  const agent = { ...portableAgent(), id: "new-id", pubkey: "cd".repeat(32) };
  const hostCreate = vi.fn(async () => {
    fixture.data.agents.push(agent);
    return structuredClone(fixture.data);
  });
  const hostWrite = vi
    .fn()
    .mockRejectedValueOnce("relay unavailable")
    .mockResolvedValueOnce({ written: 1, total: 1, errors: [] });
  const control = createAgentControl({
    ...fixture.host,
    prepareCreate: vi.fn(async () => ({ id: agent.id, pubkey: agent.pubkey })),
    commitCreate: hostCreate,
    writeSnapshotMemory: hostWrite,
  });
  await control.refresh();
  render(
    <AgentSnapshotImport
      control={control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  choose(file("core"));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Restore memory/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  const retry = await screen.findByRole("button", {
    name: "Retry memory restore",
  });
  expect(control.snapshot().status).toBe("error");
  fireEvent.click(retry);
  await waitFor(() => expect(hostWrite).toHaveBeenCalledTimes(2));
  expect(hostCreate).toHaveBeenCalledOnce();
  expect(hostWrite).toHaveBeenNthCalledWith(2, agent.id, [
    { slug: "core", body: "private fixture memory" },
  ]);
  await waitFor(() => expect(retry).not.toBeInTheDocument());
  expect(control.snapshot().status).toBe("ready");
  control.dispose();
});

it("does not write when controller recovery cannot confirm status", async () => {
  const h = importControl();
  let status: "ready" | "error" = "ready";
  const control = {
    ...h.control,
    snapshot: () => ({ status, data: h.control.snapshot().data }),
    writeSnapshotMemory: vi.fn(
      async (...args: Parameters<typeof h.writeSnapshotMemory>) => {
        status = "error";
        return h.writeSnapshotMemory(...args);
      },
    ),
    refresh: vi.fn(async () => {}),
  } as unknown as AgentControl;
  h.writeSnapshotMemory.mockRejectedValueOnce(new Error("relay unavailable"));
  render(
    <AgentSnapshotImport
      control={control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  choose(file("core"));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Restore memory/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry memory restore" }),
  );
  await waitFor(() => expect(control.refresh).toHaveBeenCalledOnce());
  expect(h.writeSnapshotMemory).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Retry memory restore" }),
  ).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not confirm local agent status",
  );
  expect(h.create).toHaveBeenCalledOnce();
});

it("keeps memory failure visible after profile publication succeeds", async () => {
  const h = importControl();
  const publishProfile = vi.fn(async () => controlFixture().data);
  render(
    <AgentSnapshotImport
      control={{ ...h.control, publishProfile } as AgentControl}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  h.writeSnapshotMemory.mockResolvedValueOnce({
    written: 0,
    total: 1,
    errors: [],
  });
  choose(file("core"));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Restore memory/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByRole("button", { name: "Retry memory restore" });
  fireEvent.click(screen.getByRole("button", { name: "Publish profile" }));
  await waitFor(() => expect(publishProfile).toHaveBeenCalledOnce());
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Profile published",
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Memory partially restored",
  );
});

it("keeps profile failure visible after memory retry succeeds", async () => {
  const h = importControl();
  const publishProfile = vi.fn(async () => {
    throw new Error("publication failed");
  });
  h.writeSnapshotMemory.mockResolvedValueOnce({
    written: 0,
    total: 1,
    errors: [],
  });
  render(
    <AgentSnapshotImport
      control={{ ...h.control, publishProfile } as AgentControl}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  choose(file("core"));
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Restore memory/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByRole("button", { name: "Retry memory restore" });
  fireEvent.click(screen.getByRole("button", { name: "Publish profile" }));
  expect(
    await screen.findByText(/Profile publication unconfirmed/),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry memory restore" }));
  await waitFor(() => expect(h.writeSnapshotMemory).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Profile publication unconfirmed",
  );
  expect(
    screen.queryByText(/Memory partially restored/),
  ).not.toBeInTheDocument();
  expect(h.create).toHaveBeenCalledOnce();
});

it("imports configuration without a memory writer and disables restoration", async () => {
  const h = importControl();
  const control = {
    ...h.control,
    writeSnapshotMemory: undefined,
  } as AgentControl;
  render(
    <AgentSnapshotImport
      control={control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={encodeAgentSnapshot(
        buildAgentSnapshot(portableAgent(), "core", [
          { slug: "core", body: "private fixture memory" },
        ]),
        "png",
      )}
      onClose={() => {}}
    />,
  );
  expect(await screen.findByText("Help with the project.")).toBeVisible();
  expect(
    screen.getByRole("checkbox", { name: /Restore memory/ }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
});

it("clears memory consent when a different file is selected", async () => {
  const h = importControl();
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  choose(file("core"));
  const consent = await screen.findByRole("checkbox", {
    name: /Restore memory/,
  });
  fireEvent.click(consent);
  expect(consent).toBeChecked();
  choose(file("core"));
  expect(
    await screen.findByRole("checkbox", { name: /Restore memory/ }),
  ).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
});

it("does not publish memory if identity creation fails", async () => {
  const h = importControl();
  h.create.mockRejectedValueOnce(new Error("creation failed"));
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      onClose={() => {}}
    />,
  );
  choose(file("core"));
  fireEvent.click(await screen.findByRole("button", { name: "Import" }));
  await waitFor(() =>
    expect(
      screen
        .getAllByRole("alert")
        .some((node) => node.textContent?.includes("creation failed")),
    ).toBe(true),
  );
  expect(h.writeSnapshotMemory).not.toHaveBeenCalled();
});

it.each([1, 4])(
  "imports reference worker count %i through native edit and portable re-export",
  async (workers) => {
    const h = importControl();
    const reference = buildAgentSnapshot(portableAgent());
    reference.definition.parallelism = workers;
    render(
      <AgentSnapshotImport
        control={h.control}
        destination="https://relay.example.test"
        owner={"ef".repeat(32)}
        receivedBytes={encodeAgentSnapshot(reference, "json")}
        onClose={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
    const edit = h.create.mock.calls[0]?.[3] as {
      environment: Record<string, string>;
    };
    expect(edit.environment).toEqual({ BUZZ_ACP_AGENTS: String(workers) });
    // The controller's native projection test checks this saved edit reaches
    // AgentView.launchParallelism; no environment value is exposed to JS.
    const native = portableAgent();
    native.harness.environmentKeys = Object.keys(edit.environment);
    native.launchParallelism = Number(edit.environment.BUZZ_ACP_AGENTS);
    const exported = parseAgentSnapshot(
      encodeAgentSnapshot(buildAgentSnapshot(native), "png"),
    );
    expect(exported.definition.parallelism).toBe(workers);
  },
);

it("binds export approval to configuration and source across native refreshes", () => {
  const agent = portableAgent();
  const props = {
    agent,
    defaultSessionPolicy: "thread" as const,
    destination: "https://relay.example.test",
    onClose: vi.fn(),
  };
  const mounted = render(<AgentSnapshotExport {...props} />);
  const exportButton = () => screen.getByRole("button", { name: "Export" });
  const approval = () =>
    screen.getByRole("checkbox", {
      name: /I reviewed the portable configuration/,
    });
  fireEvent.click(approval());
  expect(exportButton()).toBeEnabled();
  mounted.rerender(<AgentSnapshotExport {...props} agent={{ ...agent }} />);
  expect(approval()).toBeChecked();
  expect(exportButton()).toBeEnabled();

  const changed = { ...agent, systemPrompt: "New private fixture" };
  mounted.rerender(<AgentSnapshotExport {...props} agent={changed} />);
  expect(approval()).not.toBeChecked();
  expect(exportButton()).toBeDisabled();
  fireEvent.click(approval());
  expect(exportButton()).toBeEnabled();
  mounted.rerender(
    <AgentSnapshotExport
      {...props}
      agent={{ ...changed, picture: "https://images.example.test/new.png" }}
    />,
  );
  expect(exportButton()).toBeDisabled();
  fireEvent.click(approval());
  mounted.rerender(
    <AgentSnapshotExport
      {...props}
      agent={{ ...changed, sessionPolicy: null }}
      defaultSessionPolicy="channel"
    />,
  );
  expect(exportButton()).toBeDisabled();
  fireEvent.click(approval());
  mounted.rerender(
    <AgentSnapshotExport
      {...props}
      agent={{ ...changed, pubkey: "ab".repeat(32) }}
    />,
  );
  expect(exportButton()).toBeDisabled();
  fireEvent.click(approval());
  mounted.rerender(
    <AgentSnapshotExport
      {...props}
      agent={changed}
      destination="https://other.example.test"
    />,
  );
  expect(exportButton()).toBeDisabled();
});

it("invalidates export approval when omitted avatar artwork changes", () => {
  const agent = portableAgent();
  agent.picture = "https://images.example.test/avatar.png?version=1#old";
  const props = {
    agent,
    destination: "https://relay.example.test",
    onClose: vi.fn(),
  };
  const mounted = render(<AgentSnapshotExport {...props} />);
  const approval = screen.getByRole("checkbox", {
    name: /I reviewed the portable configuration/,
  });
  const exportButton = () => screen.getByRole("button", { name: "Export" });
  expect(buildAgentSnapshot(agent).profile.avatarUrl).toBeUndefined();
  fireEvent.click(screen.getByText("Review portable configuration"));
  expect(screen.getByText(`Artwork source: ${agent.picture}`)).toBeVisible();
  fireEvent.click(approval);
  expect(exportButton()).toBeEnabled();
  mounted.rerender(
    <AgentSnapshotExport
      {...props}
      agent={{
        ...agent,
        picture: "https://images.example.test/avatar.png?version=2#new",
      }}
    />,
  );
  expect(approval).not.toBeChecked();
  expect(exportButton()).toBeDisabled();
});

it("aborts a pending artwork export when an omitted avatar URL changes and returns", async () => {
  const agent = portableAgent();
  agent.picture = "https://images.example.test/avatar.png?version=1";
  let release!: () => void;
  class HeldImage {
    crossOrigin = "";
    src = "";
    decode() {
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  }
  vi.stubGlobal("Image", HeldImage);
  const download = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = download;
      static revokeObjectURL = vi.fn();
    },
  );
  const props = {
    agent,
    destination: "https://relay.example.test",
    onClose: vi.fn(),
  };
  const mounted = render(<AgentSnapshotExport {...props} />);
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I reviewed the portable configuration/,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(release).toBeDefined());
  mounted.rerender(
    <AgentSnapshotExport
      {...props}
      agent={{
        ...agent,
        picture: "https://images.example.test/avatar.png?version=2",
      }}
    />,
  );
  mounted.rerender(<AgentSnapshotExport {...props} />);
  await act(async () => {
    release();
  });
  expect(download).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
});

it("aborts a pending export if the source changes and then returns to its old value", async () => {
  const agent = portableAgent();
  let release!: () => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const dispose = vi.fn();
  const session = {
    agentMemories: {
      open: vi.fn(() => ({
        refresh,
        dispose,
        snapshot: () => ({
          status: "ready",
          listing: { partial: false, entries: [] },
        }),
      })),
    },
  } as never;
  const download = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = download;
      static revokeObjectURL = vi.fn();
    },
  );
  const props = {
    agent,
    session,
    destination: "https://relay.example.test",
    onClose: vi.fn(),
  };
  const mounted = render(<AgentSnapshotExport {...props} />);
  fireEvent.change(screen.getByLabelText("Memories"), {
    target: { value: "core" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I reviewed the portable configuration/,
    }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I confirm that I want to include memory/,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  mounted.rerender(
    <AgentSnapshotExport
      {...props}
      agent={{ ...agent, systemPrompt: "changed" }}
    />,
  );
  mounted.rerender(<AgentSnapshotExport {...props} />);
  await act(async () => {
    release();
  });
  await waitFor(() => expect(dispose).toHaveBeenCalledOnce());
  expect(download).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(
    screen
      .getAllByRole("alert")
      .some((node) => node.textContent?.includes("configuration changed")),
  ).toBe(true);
  expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
});

it("retires an in-flight memory export on unmount and leaves a replacement export open", async () => {
  const source = portableAgent();
  let release!: () => void;
  const dispose = vi.fn();
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const session = {
    agentMemories: {
      open: vi.fn(() => ({
        refresh,
        dispose,
        snapshot: () => ({
          status: "ready",
          listing: {
            partial: false,
            entries: [{ slug: "core", body: "inert memory" }],
          },
        }),
      })),
    },
  } as never;
  const download = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = download;
      static revokeObjectURL = vi.fn();
    },
  );
  const closeOld = vi.fn();
  const mounted = render(
    <AgentSnapshotExport
      agent={source}
      session={session}
      destination="https://relay.example.test"
      onClose={closeOld}
    />,
  );
  fireEvent.change(screen.getByLabelText("Memories"), {
    target: { value: "core" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I reviewed the portable configuration/,
    }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I confirm that I want to include memory/,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  mounted.unmount(); // Inventory removed the old source while the read was pending.
  expect(dispose).toHaveBeenCalledOnce();
  const closeNew = vi.fn();
  render(
    <AgentSnapshotExport
      agent={{ ...source, id: "replacement", name: "Replacement" }}
      destination="https://relay.example.test"
      onClose={closeNew}
    />,
  );
  await act(async () => {
    release();
  });
  await waitFor(() =>
    expect(screen.getByText("Export Replacement")).toBeVisible(),
  );
  expect(download).not.toHaveBeenCalled();
  expect(closeOld).not.toHaveBeenCalled();
  expect(closeNew).not.toHaveBeenCalled();
});

it("retires an in-flight artwork export on unmount without downloading or closing its replacement", async () => {
  const source = portableAgent();
  source.picture = "https://images.example.test/inert.png";
  let release!: () => void;
  class HeldImage {
    crossOrigin = "";
    src = "";
    decode() {
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  }
  vi.stubGlobal("Image", HeldImage);
  const download = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = download;
      static revokeObjectURL = vi.fn();
    },
  );
  const closeOld = vi.fn();
  const mounted = render(
    <AgentSnapshotExport
      agent={source}
      destination="https://relay.example.test"
      onClose={closeOld}
    />,
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /I reviewed the portable configuration/,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(release).toBeDefined());
  mounted.unmount();
  const closeNew = vi.fn();
  render(
    <AgentSnapshotExport
      agent={{ ...source, id: "replacement", name: "Replacement" }}
      destination="https://relay.example.test"
      onClose={closeNew}
    />,
  );
  await act(async () => {
    release();
  }); // A missing canvas takes the existing placeholder path after decode.
  await waitFor(() =>
    expect(screen.getByText("Export Replacement")).toBeVisible(),
  );
  expect(download).not.toHaveBeenCalled();
  expect(closeOld).not.toHaveBeenCalled();
  expect(closeNew).not.toHaveBeenCalled();
});

it("reviews the exact portable configuration including avatar URL and effective selectors", () => {
  const agent = portableAgent();
  agent.picture =
    "https://images.example.test/INERT_PRIVATE_ARTIFACT/avatar.png";
  agent.harness.model = "";
  agent.harness.provider = "";
  agent.launchModel = "resolved-model";
  agent.launchProvider = "resolved-provider";
  agent.launchParallelism = 4;
  render(
    <AgentSnapshotExport
      agent={agent}
      destination="https://relay.example.test"
      onClose={() => {}}
    />,
  );
  const serialized = screen.getByText(/INERT_PRIVATE_ARTIFACT/).textContent;
  expect(JSON.parse(serialized ?? "")).toEqual(buildAgentSnapshot(agent));
  expect(serialized).toContain("resolved-model");
  expect(serialized).toContain("resolved-provider");
  expect(serialized).toContain('"parallelism": 4');
});

it("exports without reading memory by default and requires confirmation to read memory", async () => {
  const agent = portableAgent();
  const download = vi.fn(() => "blob:fixture");
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = download;
      static revokeObjectURL = vi.fn();
    },
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const refresh = vi.fn(async () => {});
  const dispose = vi.fn();
  const open = vi.fn(() => ({
    refresh,
    dispose,
    snapshot: () => ({
      status: "ready",
      listing: {
        partial: false,
        entries: [{ slug: "core", body: "private fixture memory" }],
      },
    }),
  }));
  const session = { agentMemories: { open } } as never;
  try {
    const mounted = render(
      <AgentSnapshotExport
        agent={agent}
        session={session}
        destination="https://relay.example.test/"
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText("Memories")).toBeEnabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I reviewed the portable configuration/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(open).not.toHaveBeenCalled();
    mounted.unmount();
    render(
      <AgentSnapshotExport
        agent={agent}
        session={session}
        destination="https://relay.example.test"
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Memories"), {
      target: { value: "core" },
    });
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I reviewed the portable configuration/,
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I confirm that I want to include memory/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    click.mockRestore();
  }
});

it("does not read a different community's memory while exporting local config", async () => {
  const agent = portableAgent();
  const open = vi.fn();
  const session = { agentMemories: { open } } as never;
  render(
    <AgentSnapshotExport
      agent={agent}
      session={session}
      destination="https://another.example.test"
      onClose={() => {}}
    />,
  );
  expect(screen.getByLabelText("Memories")).toBeDisabled();
  expect(open).not.toHaveBeenCalled();
});

it.each(["json", "png"] as const)(
  "imports ordinary reference %s with explicit worker count through native create",
  async (format) => {
    const h = importControl();
    const snapshot = buildAgentSnapshot(portableAgent());
    snapshot.definition.sourceIsBuiltin = false;
    snapshot.definition.parallelism = 1;
    render(
      <AgentSnapshotImport
        control={h.control}
        destination="https://relay.example.test"
        owner={"ef".repeat(32)}
        receivedBytes={encodeAgentSnapshot(snapshot, format)}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("Help with the project.")).toBeVisible();
    expect(h.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
    expect(h.create.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ environment: { BUZZ_ACP_AGENTS: "1" } }),
    );
  },
);

it("preserves absent parallelism and blocks counts outside native worker range", async () => {
  const h = importControl();
  const snapshot = buildAgentSnapshot(portableAgent());
  snapshot.definition.parallelism = 33;
  const { rerender } = render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={encodeAgentSnapshot(snapshot, "json")}
      onClose={() => {}}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "native supports 1–32 workers",
  );
  expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  expect(h.create).not.toHaveBeenCalled();
  delete snapshot.definition.parallelism;
  rerender(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={encodeAgentSnapshot(snapshot, "json")}
      onClose={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(h.create.mock.calls[0]?.[3]).toEqual(
    expect.objectContaining({ environment: {} }),
  );
});

it("blocks divergent definition and profile names rather than silently losing one", async () => {
  const h = importControl();
  const snapshot = buildAgentSnapshot(portableAgent());
  snapshot.definition.name = "Different source name";
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={encodeAgentSnapshot(snapshot, "json")}
      onClose={() => {}}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "definition and profile names disagree",
  );
  expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  expect(h.create).not.toHaveBeenCalled();
});

it("previews valid but unsupported reference settings and blocks creation", async () => {
  const h = importControl();
  const snapshot = buildAgentSnapshot(portableAgent());
  snapshot.definition.parallelism = 33;
  snapshot.definition.respondTo = "allowlist";
  snapshot.definition.respondToAllowlist = ["source-identity"];
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={encodeAgentSnapshot(snapshot, "json")}
      onClose={() => {}}
    />,
  );
  expect(
    await screen.findByText(/Import is blocked:.*response policy.*parallelism/),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  expect(h.create).not.toHaveBeenCalled();
});

it("defaults a reference snapshot with omitted session policy to channel", async () => {
  const h = importControl();
  const snapshot = buildAgentSnapshot(portableAgent());
  delete snapshot.definition.sessionPolicy;
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={encodeAgentSnapshot(snapshot, "json")}
      onClose={() => {}}
    />,
  );
  expect(await screen.findByText("Help with the project.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(h.create.mock.calls[0]?.[3]).toEqual(
    expect.objectContaining({ sessionPolicy: "channel" }),
  );
});

it("uploads portable PNG artwork before creation but gives inline avatar precedence", async () => {
  vi.mocked(uploadAvatar).mockClear();
  const pixels = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=",
    ),
    (char) => char.charCodeAt(0),
  );
  const snapshot = buildAgentSnapshot({
    ...portableAgent(),
    picture: "https://cdn.example.test/a.png?v=1",
  });
  const h = importControl();
  vi.mocked(uploadAvatar).mockResolvedValue(
    "https://relay.example.test/media/avatar.png",
  );
  const { unmount } = render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={encodeAgentSnapshot(snapshot, "png", pixels)}
      onClose={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  const uploaded = vi.mocked(uploadAvatar).mock.calls[0]?.[0];
  expect(uploaded?.type).toBe("image/png");
  expect(uploaded).toBeDefined();
  if (!uploaded) throw new Error("PNG artwork was not uploaded");
  expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(
    encodeAgentSnapshot(snapshot, "png", pixels),
  );
  expect(h.create.mock.calls[0]?.[3]).toEqual(
    expect.objectContaining({
      picture: "https://relay.example.test/media/avatar.png",
    }),
  );
  unmount();
  vi.mocked(uploadAvatar).mockClear();
  const inline = {
    ...snapshot,
    profile: {
      ...snapshot.profile,
      avatarDataUrl: "data:image/png;base64,aW5saW5l",
    },
  };
  const second = importControl();
  render(
    <AgentSnapshotImport
      control={second.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={encodeAgentSnapshot(inline, "png", pixels)}
      onClose={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Import" }));
  await waitFor(() => expect(second.create).toHaveBeenCalledOnce());
  const inlineFile = vi.mocked(uploadAvatar).mock.calls[0]?.[0];
  expect(inlineFile).toBeDefined();
  if (!inlineFile) throw new Error("Inline avatar was not uploaded");
  expect(new TextDecoder().decode(await inlineFile.arrayBuffer())).toBe(
    "inline",
  );
});

// The container is structurally valid but its animated ICC pixels cannot be
// sanitized. Only the selected inline avatar should reach the uploader.
function animatedIccSnapshot(snapshot: ReturnType<typeof buildAgentSnapshot>) {
  const png = encodeAgentSnapshot(snapshot, "png");
  const chunk = (kind: string, payload: Uint8Array) => {
    const bytes = new Uint8Array(payload.length + 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, payload.length);
    bytes.set(new TextEncoder().encode(kind), 4);
    bytes.set(payload, 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, -4)) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    view.setUint32(payload.length + 8, (crc ^ 0xffffffff) >>> 0);
    return bytes;
  };
  const frame = chunk("acTL", new Uint8Array(8));
  const icc = chunk("iCCP", new Uint8Array([1]));
  const headerLength = 8 + 25; // PNG signature and IHDR chunk.
  return new Uint8Array([
    ...png.subarray(0, headerLength),
    ...frame,
    ...icc,
    ...png.subarray(headerLength),
  ]);
}

it.each(["file", "received"] as const)(
  "uses inline avatar despite rejected unused animated artwork on %s import",
  async (source) => {
    vi.mocked(uploadAvatar).mockReset();
    vi.mocked(uploadAvatar).mockResolvedValue(
      "https://relay.example.test/inline.png",
    );
    const snapshot = buildAgentSnapshot(portableAgent());
    snapshot.profile.avatarDataUrl = "data:image/png;base64,aW5saW5l";
    const bytes = animatedIccSnapshot(snapshot);
    const h = importControl();
    const props = {
      control: h.control,
      destination: "https://relay.example.test",
      owner: "ef".repeat(32),
      onClose: () => {},
    };
    render(
      <AgentSnapshotImport
        {...props}
        {...(source === "received" ? { receivedBytes: bytes } : {})}
      />,
    );
    if (source === "file")
      choose(
        new File([Uint8Array.from(bytes)], "agent.png", { type: "image/png" }),
      );
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
    expect(uploadAvatar).toHaveBeenCalledOnce();
    const uploaded = vi.mocked(uploadAvatar).mock.calls[0]?.[0];
    if (!uploaded) throw new Error("Inline avatar was not uploaded");
    expect(new TextDecoder().decode(await uploaded.arrayBuffer())).toBe(
      "inline",
    );
    expect(h.create.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        picture: "https://relay.example.test/inline.png",
      }),
    );
    cleanup();
    vi.mocked(uploadAvatar).mockClear();
    delete snapshot.profile.avatarDataUrl;
    const rejected = animatedIccSnapshot(snapshot);
    const withoutInline = importControl();
    render(
      <AgentSnapshotImport
        {...props}
        control={withoutInline.control}
        {...(source === "received" ? { receivedBytes: rejected } : {})}
      />,
    );
    if (source === "file")
      choose(
        new File([Uint8Array.from(rejected)], "agent.png", {
          type: "image/png",
        }),
      );
    expect(await screen.findByRole("alert")).toHaveTextContent("ICC profile");
    expect(withoutInline.create).not.toHaveBeenCalled();
    expect(uploadAvatar).not.toHaveBeenCalled();
  },
);

it("retains the source avatar URL for a differently compressed transparent PNG", async () => {
  vi.mocked(uploadAvatar).mockClear();
  const snapshot = buildAgentSnapshot({
    ...portableAgent(),
    picture: "https://cdn.example.test/source.png",
  });
  const original = encodeAgentSnapshot(snapshot, "png");
  const idat = deflateSync(new Uint8Array(5));
  const replacement = new Uint8Array(12 + idat.length);
  const header = new DataView(replacement.buffer);
  header.setUint32(0, idat.length);
  replacement.set(new TextEncoder().encode("IDAT"), 4);
  replacement.set(idat, 8);
  let checksum = 0xffffffff;
  for (const byte of replacement.subarray(4, -4)) {
    checksum ^= byte;
    for (let i = 0; i < 8; i++)
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
  }
  header.setUint32(8 + idat.length, (checksum ^ 0xffffffff) >>> 0);
  // Walk the container to find the full IDAT chunk rather than its incidental payload bytes.
  let offset = 8;
  while (offset < original.length) {
    const length = new DataView(original.buffer).getUint32(offset);
    if (
      new TextDecoder().decode(original.subarray(offset + 4, offset + 8)) ===
      "IDAT"
    )
      break;
    offset += length + 12;
  }
  const oldLength = new DataView(original.buffer).getUint32(offset) + 12;
  const changed = new Uint8Array(
    original.length - oldLength + replacement.length,
  );
  changed.set(original.subarray(0, offset));
  changed.set(replacement, offset);
  changed.set(
    original.subarray(offset + oldLength),
    offset + replacement.length,
  );
  const h = importControl();
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={changed}
      onClose={() => {}}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  await waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(uploadAvatar).not.toHaveBeenCalled();
  expect(h.create.mock.calls[0]?.[3]).toEqual(
    expect.objectContaining({ picture: "https://cdn.example.test/source.png" }),
  );
});

it("does not create when opted-in memory exceeds the reader payload budget", async () => {
  const source = buildAgentSnapshot(portableAgent());
  const body = "\\".repeat(40_000);
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      ...source,
      memory: { level: "core", entries: [{ slug: "core", body }] },
    }),
  );
  const h = importControl();
  render(
    <AgentSnapshotImport
      control={h.control}
      destination="https://relay.example.test"
      owner={"ef".repeat(32)}
      receivedBytes={bytes}
      onClose={() => {}}
    />,
  );
  expect(await screen.findByText("Invalid snapshot manifest.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  expect(h.create).not.toHaveBeenCalled();
});

it("routes source-community PNG artwork through authenticated media and embeds its pixels", async () => {
  const agent = portableAgent();
  agent.picture = `https://relay.example.test/media/${"ab".repeat(32)}`;
  const sources: string[] = [];
  class LoadedImage {
    crossOrigin = "";
    set src(value: string) {
      sources.push(value);
    }
    decode() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("Image", LoadedImage);
  const pixels = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=",
    ),
    (char) => char.charCodeAt(0),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
    (callback) => {
      callback(new Blob([Uint8Array.from(pixels)], { type: "image/png" }));
    },
  );
  let exported: Blob | undefined;
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn((blob: Blob) => {
        exported = blob;
        return "blob:fixture";
      });
      static revokeObjectURL = vi.fn();
    },
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  try {
    render(
      <AgentSnapshotExport
        agent={agent}
        destination="https://other.example.test"
        onClose={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I reviewed the portable configuration/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(exported).toBeDefined());
    expect(sources).toEqual([
      `/api/relay/${encodeURIComponent("https://relay.example.test")}/media?url=${encodeURIComponent(agent.picture)}`,
    ]);
    if (!exported) throw new Error("Missing PNG export");
    const bytes = new Uint8Array(await (exported as Blob).arrayBuffer());
    expect(await snapshotPngArtwork(bytes)).toEqual(bytes);
    expect(parseAgentSnapshot(bytes).profile.avatarUrl).toBe(agent.picture);
  } finally {
    click.mockRestore();
    vi.restoreAllMocks();
  }
});
