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
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { EventTemplate } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import { formatPublicKey } from "../../shared/identity/public-key";
import {
  createIdentity,
  nativeIdentityEnabled,
  type Identity,
  type RecoveryResult,
} from "./service";
import { IdentitySetup } from "./IdentitySetup";
import { PrivateKey } from "./PrivateKey";
import { SignOutDialog, WIPE_PHRASE } from "./SignOut";
import { Welcome } from "./Welcome";
import type { Credential } from "../../bundled/builderlab/oauth/browser";
import { createCommunities } from "../communities/service";
import { connectNativeTransport } from "../relay/native";
import { keypair, profile, signed } from "../relay/testing";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));
const viewer = "ab".repeat(32);
const key = "nsec-fixture-only";
const credential: Credential = {
  value: "private-token",
  account: {
    subject: "user",
    email: "a@example.com",
    canUseRemoteAgents: false,
  },
};
const welcomeHeading = () => screen.getByRole("heading", { name: "Buzz" });
const connectButton = () =>
  screen.getByRole("button", { name: "Connect with Builderlab" });
function titleBar() {
  const header = document.querySelector("header");
  if (!header) throw new Error("Missing native title bar");
  return header;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Welcome reads the Communities service only to join; these screens never get there. */
const noJoin: ComponentProps<typeof Welcome>["communities"] = {
  snapshot() {
    throw new Error("Welcome consulted communities before a join");
  },
  joined() {
    throw new Error("Welcome joined without a join");
  },
};
const roots: Context[] = [];
/** The production shape: the service exists at startup and hydrates once the key is ready. */
function communitiesFor(identity: Identity) {
  const ctx = new Context();
  roots.push(ctx);
  return createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    identity.ready,
    connectNativeTransport,
  );
}
afterEach(async () => {
  cleanup();
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

it("keeps native titlebar actions available throughout identity setup without dragging form controls", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const startDragging = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getCurrentWindow).mockReturnValue({
    startDragging,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  const restored = deferred<null>();
  const imported = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return restored.promise;
    if (command === "nsec_backup_available") return Promise.resolve(false);
    if (command === "identity_legacy_available") return Promise.resolve(false);
    if (command === "identity_import") return imported.promise;
    if (command === "title_bar_double_click") return Promise.resolve();
    throw new Error("Unexpected command");
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <IdentitySetup identity={identity}>
      <p>Signed in</p>
    </IdentitySetup>,
  );
  const drag = () => {
    fireEvent.mouseDown(titleBar(), {
      button: 0,
      detail: 1,
    });
  };
  drag();
  expect(startDragging).toHaveBeenCalledTimes(1);
  await act(async () => restored.resolve(null));
  drag();
  expect(startDragging).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Use an existing key" }));
  await user.type(screen.getByLabelText("Private key (nsec)"), key);
  expect(startDragging).toHaveBeenCalledTimes(2);
  drag();
  expect(startDragging).toHaveBeenCalledTimes(3);
  await user.click(
    screen.getByRole("button", { name: "Import this identity" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Saving your identity");
  drag();
  expect(startDragging).toHaveBeenCalledTimes(4);
  await user.dblClick(titleBar());
  expect(invoke).toHaveBeenCalledWith("title_bar_double_click");
  await act(async () => imported.resolve(viewer));
  expect(document.querySelector("header")).toBeNull();
  expect(screen.getByText("Signed in")).toBeVisible();
  identity.dispose();
});

it.each([
  [false, "Win32"],
  [false, "MacIntel"],
])("does not add a titlebar for native=%s on %s", (native, platform) => {
  vi.mocked(isTauri).mockReturnValue(native);
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
  const identity = createIdentity();
  render(<IdentitySetup identity={identity}>Signed in</IdentitySetup>);
  expect(document.querySelector("header")).toBeNull();
  identity.dispose();
});

it("offers alternatives, passes exactly the imported key, and keeps secrets out of snapshots", async () => {
  const imported = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "nsec_backup_available") return Promise.resolve(false);
    if (command === "identity_legacy_available") return Promise.resolve(false);
    if (command === "identity_import") return imported.promise;
    throw new Error("Unexpected command");
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <IdentitySetup identity={identity}>
      <p>Signed in</p>
    </IdentitySetup>,
  );
  const useKey = await screen.findByRole("button", {
    name: "Use an existing key",
  });
  await user.click(useKey);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    screen.getByRole("button", { name: "Use an existing key" }),
  ).toHaveFocus();
  await user.keyboard("{Enter}");
  await user.type(screen.getByLabelText("Private key (nsec)"), key);
  await user.click(
    screen.getByRole("button", { name: "Import this identity" }),
  );
  expect(invoke).toHaveBeenCalledWith("identity_import", { nsec: key });
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue("");
  expect(
    screen.getByRole("button", { name: "Import this identity" }),
  ).toBeDisabled();
  await act(async () => {
    imported.resolve(viewer);
  });
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(await identity.ready).toBe(viewer);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "nsec_backup_available",
    "identity_legacy_available",
    "identity_import",
  ]);
  identity.dispose();
});

it("brings over installed old Buzz's identity only after an explicit click", async () => {
  const imported = deferred<string>();
  const legacy = deferred<boolean>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "nsec_backup_available") return Promise.resolve(false);
    if (command === "identity_legacy_available") return legacy.promise;
    if (command === "identity_import_legacy") return imported.promise;
    throw new Error("Unexpected command");
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <IdentitySetup identity={identity}>
      <p>Signed in</p>
    </IdentitySetup>,
  );
  // A click must not reach Create before migration can be offered first.
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("identity_legacy_available"),
  );
  expect(
    screen.queryByRole("button", { name: "Create a new identity" }),
  ).toBeNull();
  await act(async () => legacy.resolve(true));
  const bringOver = await screen.findByRole("button", {
    name: "Continue with your Buzz identity",
  });
  expect(invoke).not.toHaveBeenCalledWith("identity_import_legacy", {});
  await user.click(bringOver);
  expect(invoke).toHaveBeenCalledWith("identity_import_legacy", {});
  expect(
    screen.getByRole("button", { name: "Create a new identity" }),
  ).toBeDisabled();
  await act(async () => {
    imported.resolve(viewer);
  });
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  identity.dispose();
});

const previousViewer = "cd".repeat(32);
function mountRecovery(
  result: RecoveryResult,
  override?: (command: string) => Promise<unknown> | undefined,
) {
  vi.mocked(invoke).mockImplementation((command) => {
    const overridden = override?.(command);
    if (overridden) return overridden as ReturnType<typeof invoke>;
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "nsec_backup_available") return Promise.resolve(true);
    if (command === "identity_legacy_available") return Promise.resolve(false);
    if (command === "nsec_restore_begin")
      return Promise.resolve({ attempt: "attempt" });
    if (command === "nsec_restore_wait") return Promise.resolve(result);
    if (command === "nsec_restore_cancel") return Promise.resolve();
    if (command === "nsec_restore_install" || command === "identity_create")
      return Promise.resolve(viewer);
    throw new Error("Unexpected fixture command");
  });
  const identity = createIdentity();
  const view = render(
    <IdentitySetup identity={identity}>Restored identity</IdentitySetup>,
  );
  return { identity, ...view };
}
const recovered: RecoveryResult = {
  candidates: [
    { handle: "previous", pubkey: previousViewer },
    { handle: "current", pubkey: viewer },
  ],
  currentPubkey: viewer,
  failedCount: 0,
};

it.each([false, "unavailable"])(
  "hides backup restore when availability is %s",
  async (availability) => {
    const { identity } = mountRecovery(recovered, (command) =>
      command === "nsec_backup_available"
        ? availability === false
          ? Promise.resolve(false)
          : Promise.reject("unavailable")
        : undefined,
    );
    await screen.findByRole("button", { name: "Create a new identity" });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("nsec_backup_available"),
    );
    expect(
      screen.queryByRole("button", { name: "Restore from backup" }),
    ).toBeNull();
    identity.dispose();
  },
);

it.each([
  "Secure storage is locked",
  "Secure storage is unavailable",
  "Saved identity is corrupt",
])("does not offer recovery or inspect availability when %s", async (error) => {
  const { identity } = mountRecovery(recovered, (command) =>
    command === "identity_restore" ? Promise.reject(error) : undefined,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(error);
  expect(
    screen.getByRole("button", { name: "Retry secure storage access" }),
  ).toBeEnabled();
  expect(invoke).toHaveBeenCalledTimes(1);
  identity.dispose();
});

it("prefers the associated identity, waits for explicit consent and persistence before becoming ready", async () => {
  const installed = deferred<string>();
  const { identity } = mountRecovery(recovered, (command) =>
    command === "nsec_restore_install" ? installed.promise : undefined,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  const restore = await screen.findByRole("button", {
    name: "Restore this identity",
  });
  expect(
    screen.getByRole("radio", { name: /^npub…/, checked: true }),
  ).toHaveAccessibleDescription(/Current identity/);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "nsec_restore_install"),
  ).toBe(false);
  try {
    await user.click(restore);
    expect(invoke).toHaveBeenLastCalledWith("nsec_restore_install", {
      attempt: "attempt",
      handle: "current",
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saving your identity securely",
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(identity.snapshot().status).toBe("missing");
  } finally {
    await act(async () => installed.resolve(viewer));
  }
  expect(await screen.findByText("Restored identity")).toBeVisible();
  expect(await identity.ready).toBe(viewer);
  identity.dispose();
});

it("describes a previous identity selection accurately when the current identity is also available", async () => {
  const { identity } = mountRecovery(recovered, (command) =>
    command === "nsec_restore_install"
      ? Promise.resolve(previousViewer)
      : undefined,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  await user.click(
    await screen.findByRole("radio", {
      name: (label) => label === formatPublicKey(previousViewer),
    }),
  );
  expect(
    screen.getByText("Choose the Buzz identity to restore on this device."),
  ).toBeVisible();
  expect(
    screen.getByText("This won’t change the identity linked to your account."),
  ).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Restore this identity" }),
  );
  expect(invoke).toHaveBeenCalledWith("nsec_restore_install", {
    attempt: "attempt",
    handle: "previous",
  });
  expect(await screen.findByText("Restored identity")).toBeVisible();
  identity.dispose();
});

it("requires a historical identity choice when the associated key is absent and reports partial recovery", async () => {
  const { identity } = mountRecovery({
    ...recovered,
    currentPubkey: "ef".repeat(32),
    failedCount: 1,
  });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  const restore = await screen.findByRole("button", {
    name: "Restore this identity",
  });
  expect(restore).toBeDisabled();
  expect(
    screen.getByText(/Your current identity isn’t in these backups/),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Some backups couldn’t be recovered",
  );
  await user.click(
    screen.getByRole("radio", {
      name: (label) => label === formatPublicKey(viewer),
    }),
  );
  expect(restore).toBeEnabled();
  await user.click(restore);
  expect(await screen.findByText("Restored identity")).toBeVisible();
  expect(invoke).toHaveBeenCalledWith("nsec_restore_install", {
    attempt: "attempt",
    handle: "current",
  });
  identity.dispose();
});

it.each([
  [0, "No backups were found for this account."],
  [2, "Your backups couldn’t be recovered. Try again."],
])(
  "distinguishes an empty recovery from failed backups (%s)",
  async (failedCount, message) => {
    const { identity } = mountRecovery({
      candidates: [],
      currentPubkey: null,
      failedCount,
    });
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Restore from backup" }),
    );
    expect(await screen.findByText(message)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Restore this identity" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Try recovery again" }),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([command]) => command === "nsec_restore_begin"),
      ).toHaveLength(2),
    );
    identity.dispose();
  },
);

it.each([
  ["nsec_restore_begin", "Backup recovery is unavailable. Try again later."],
  ["nsec_restore_wait", "Backup recovery is unavailable. Try again later."],
  ["nsec_restore_wait", "Could not restore your identity. Try again."],
  ["nsec_restore_wait", "Restore was canceled. Try again."],
  ["nsec_restore_install", "Could not restore your identity. Try again."],
])(
  "keeps %s failures retryable without creating or adopting an identity",
  async (operation, message) => {
    const { identity } = mountRecovery(recovered, (command) =>
      command === operation ? Promise.reject(message) : undefined,
    );
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Restore from backup" }),
    );
    if (operation === "nsec_restore_install")
      await user.click(
        await screen.findByRole("button", { name: "Restore this identity" }),
      );
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(
      screen.getByRole("button", { name: "Try recovery again" }),
    ).toBeEnabled();
    expect(identity.snapshot().status).toBe("missing");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByRole("button", { name: "Use an existing key" }),
    ).toBeEnabled();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "identity_create"),
    ).toBe(false);
    identity.dispose();
  },
);

it("keeps a failed cancellation visible and blocks key changes until Back succeeds", async () => {
  let cancellations = 0;
  const { identity } = mountRecovery(recovered, (command) => {
    if (command === "nsec_restore_cancel" && ++cancellations === 1)
      return Promise.reject(new Error("Synthetic IPC failure"));
  });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  await screen.findByRole("button", { name: "Restore this identity" });
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t cancel recovery. Try Back again.",
  );
  await identity.create();
  await identity.importKey(key);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command]) =>
          command === "identity_create" || command === "identity_import",
      ),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    await screen.findByRole("button", { name: "Use an existing key" }),
  ).toBeEnabled();
  expect(cancellations).toBe(2);
  identity.dispose();
});

it("retries a recovery error only after the prior attempt is canceled", async () => {
  const canceled = deferred<void>();
  let waits = 0;
  const { identity } = mountRecovery(recovered, (command) => {
    if (command === "nsec_restore_wait" && ++waits === 1)
      return Promise.reject("Could not restore your identity. Try again.");
    if (command === "nsec_restore_cancel") return canceled.promise;
  });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  await screen.findByRole("alert");
  try {
    await user.click(
      screen.getByRole("button", { name: "Try recovery again" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("nsec_restore_cancel", {
        attempt: "attempt",
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Canceling recovery");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "nsec_restore_begin"),
    ).toHaveLength(1);
  } finally {
    await act(async () => canceled.resolve());
  }
  expect(
    await screen.findByRole("button", { name: "Restore this identity" }),
  ).toBeEnabled();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "nsec_restore_begin"),
  ).toHaveLength(2);
  identity.dispose();
});

it("rejects an installed viewer that differs from the selected identity", async () => {
  const { identity } = mountRecovery(recovered, (command) =>
    command === "nsec_restore_install"
      ? Promise.resolve(previousViewer)
      : undefined,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Restore this identity" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The restored identity could not be verified. Restart the app.",
  );
  expect(identity.snapshot().status).toBe("missing");
  expect(screen.queryByText("Restored identity")).toBeNull();
  identity.dispose();
});

it("fences late recovery after cancellation before allowing creation", async () => {
  const waiting = deferred<RecoveryResult>();
  const cancelled = deferred<void>();
  const { identity } = mountRecovery(recovered, (command) => {
    if (command === "nsec_restore_wait") return waiting.promise;
    if (command === "nsec_restore_cancel") return cancelled.promise;
  });
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  await screen.findByText(/Sign in in your browser/);
  try {
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("nsec_restore_cancel", {
        attempt: "attempt",
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Canceling recovery");
    await identity.create();
    await identity.importKey(key);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([command]) =>
            command === "identity_create" || command === "identity_import",
        ),
    ).toBe(false);
    expect(
      screen.queryByRole("button", { name: "Create a new identity" }),
    ).toBeNull();
    await act(async () => waiting.resolve(recovered));
    expect(
      screen.queryByRole("button", { name: "Restore this identity" }),
    ).toBeNull();
  } finally {
    await act(async () => {
      waiting.resolve(recovered);
      cancelled.resolve();
    });
  }
  await user.click(
    await screen.findByRole("button", { name: "Create a new identity" }),
  );
  expect(await screen.findByText("Restored identity")).toBeVisible();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "nsec_restore_install"),
  ).toBe(false);
  identity.dispose();
});

it("retires a browser sign-in that starts after setup is unmounted", async () => {
  const begun = deferred<{ attempt: string }>();
  const { identity, unmount } = mountRecovery(recovered, (command) =>
    command === "nsec_restore_begin" ? begun.promise : undefined,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Restore from backup" }),
  );
  unmount();
  await act(async () => begun.resolve({ attempt: "late-attempt" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("nsec_restore_cancel", {
      attempt: "late-attempt",
    }),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "nsec_restore_wait"),
  ).toBe(false);
  identity.dispose();
});

it("first launch offers Builderlab, with community URL and QR scanning disabled", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  const identity = createIdentity();
  render(
    <Welcome identity={identity} communities={noJoin} connect={vi.fn()}>
      <p>Signed in</p>
    </Welcome>,
  );
  // The loading state also titles the window "Buzz"; wait for the missing state.
  expect(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  ).toBeEnabled();
  expect(welcomeHeading()).toBeVisible();
  expect(
    screen.getByText(
      "Your people, your agents, your projects — all in one place.",
    ),
  ).toBeVisible();
  const url = screen.getByRole("textbox", { name: "Community URL" });
  expect(url).toBeDisabled();
  expect(url).toHaveAttribute("placeholder", "Coming soon");
  expect(
    screen.getByRole("button", { name: "Scan a QR code — Coming soon" }),
  ).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: /existing key|new identity/ }),
  ).toBeNull();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

/** Each placeholder step waits on its own gate so the order is observable. */
function gatedDelay() {
  const gates: ReturnType<typeof deferred<void>>[] = [];
  const delay = vi.fn((_ms: number) => {
    const gate = deferred<void>();
    gates.push(gate);
    return gate.promise;
  });
  const release = (index: number) =>
    act(async () => {
      const gate = gates[index];
      if (!gate) throw new Error(`Step ${index} never started waiting`);
      gate.resolve();
    });
  return { delay, release };
}

it("Connect with Builderlab runs sign-in, creates the key mid-setup, and lands on Join a community", async () => {
  const created = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return created.promise;
    throw new Error("Unexpected command");
  });
  const released = deferred<Credential>();
  const connect = vi.fn((_signal: AbortSignal) => released.promise);
  const { delay, release } = gatedDelay();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      connect={connect}
      delay={delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  expect(connect).toHaveBeenCalledTimes(1);
  expect(connect.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish sign-in in your browser",
  );
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  await act(async () => released.resolve(credential));
  expect(
    screen.getByRole("heading", { name: "Setting up Buzz" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Downloading keys… [TODO]",
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  await release(0);
  expect(screen.getByRole("status")).toHaveTextContent("Creating keys…");
  expect(invoke).toHaveBeenCalledWith("identity_create", {});
  await act(async () => created.resolve(viewer));
  // The key is now ready, but setup keeps the app behind the onboarding screens.
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Uploading keys… [TODO]",
  );
  await release(1);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finding communities… [TODO]",
  );
  await release(2);
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  const invites = within(screen.getByRole("list", { name: "Pending invites" }));
  const rows = invites.getAllByRole("listitem");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toHaveTextContent("buzz.block.builderlab.xyz");
  for (const row of rows) {
    // Rows carry only the hostname: no subtitle, hints or status text.
    expect(row).not.toHaveTextContent(/Coming soon|Terms|18\+/);
    expect(within(row).getByRole("button", { name: "Join" })).toBeDisabled();
  }
  const url = screen.getByRole("textbox", { name: "Community URL" });
  expect(url).toBeEnabled();
  expect(url).toHaveValue("");
  // Three row Joins plus the one beside the still-empty URL field, all disabled.
  const joins = screen.getAllByRole("button", { name: "Join" });
  expect(joins).toHaveLength(4);
  for (const join of joins) expect(join).toBeDisabled();
  for (const name of [
    "Scan a QR code — Coming soon",
    "Create a community — Coming soon",
  ]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
  expect(delay.mock.calls).toEqual([[2000], [2000], [2000]]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

it("Join a community checks the typed URL, opens Finding community, and Cancel keeps the URL", async () => {
  const relayCalls: unknown[] = [];
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    if (command === "relay_http") {
      relayCalls.push(args);
      return new Promise(() => {});
    }
    throw new Error("Unexpected command");
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={vi.fn().mockResolvedValue(undefined)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await screen.findByRole("heading", { name: "Join a community" });
  const field = () => screen.getByRole("textbox", { name: "Community URL" });
  // The page remounts after Cancel, so look the list up each time.
  const join = () => {
    const invites = screen.getByRole("list", { name: "Pending invites" });
    const button = screen
      .getAllByRole("button", { name: "Join" })
      .find((candidate) => !invites.contains(candidate));
    if (!button) throw new Error("Missing the URL field's Join");
    return button;
  };
  expect(join()).toBeDisabled();
  await user.type(field(), "not a url{Enter}");
  expect(join()).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Please enter a valid community URL",
  );
  expect(field()).toHaveAccessibleDescription(
    "Please enter a valid community URL",
  );
  expect(relayCalls).toEqual([]);
  await user.clear(field());
  expect(screen.queryByRole("alert")).toBeNull();
  await user.type(field(), "Relay.Example.com:8443");
  expect(join()).toBeEnabled();
  await user.keyboard("{Enter}");
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "relay.example.com:8443",
  );
  // Both unauthenticated reads go to the canonical origin through relay_http.
  expect(relayCalls).toEqual([
    {
      community: "https://relay.example.com:8443",
      path: "/",
      method: "GET",
      body: null,
    },
    {
      community: "https://relay.example.com:8443",
      path: "/api/join-policy",
      method: "GET",
      body: null,
    },
  ]);
  expect(screen.queryByText("Signed in")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(field()).toHaveValue("Relay.Example.com:8443");
  await user.click(join());
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(relayCalls).toHaveLength(4);
  identity.dispose();
});

it("a found community shows Join Community after exactly the two unauthenticated GETs", async () => {
  const origin = "https://relay.example.com:8443";
  const relayCalls: unknown[] = [];
  const answer = (status: number, body = "") =>
    Promise.resolve({ status, headers: {}, body });
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    if (command === "relay_http") {
      relayCalls.push(args);
      const { path } = args as { path: string };
      if (path === "/")
        return answer(
          200,
          JSON.stringify({ name: "Buzz Relay", read_state_snapshot: {} }),
        );
      if (path === "/api/join-policy") return answer(404);
    }
    throw new Error("Unexpected command");
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={vi.fn().mockResolvedValue(undefined)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await screen.findByRole("heading", { name: "Join a community" });
  await user.type(
    screen.getByRole("textbox", { name: "Community URL" }),
    "relay.example.com:8443{Enter}",
  );
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(screen.getByText("relay.example.com:8443")).toHaveClass("font-mono");
  expect(screen.queryByText("Signed in")).toBeNull();
  // Nothing is signed with the key setup just created: the two unauthenticated
  // GETs are the only pre-join traffic, with no POST before the user opts in.
  expect(relayCalls).toEqual([
    { community: origin, path: "/", method: "GET", body: null },
    { community: origin, path: "/api/join-policy", method: "GET", body: null },
  ]);
  identity.dispose();
});

/**
 * A native first run against a relay that answers: the key setup creates is the
 * one the host signs with, so `identity_restore` learns it only after
 * `identity_create`. The kind-0 read waits on `query` so the pending join is
 * observable; `admitted` decides whether that read is answered or refused.
 */
function nativeRelay(member: ReturnType<typeof keypair>) {
  const relayKey = keypair();
  const origin = "https://relay.example.com:8443";
  const calls: Array<{
    community: string;
    path: string;
    method: string;
    body: unknown;
  }> = [];
  const relay = {
    origin,
    calls,
    admitted: true,
    profile: undefined as ReturnType<typeof profile> | undefined,
    query: Promise.resolve(),
  };
  let created = false;
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "get_os_idle_seconds") return 0;
    if (command === "identity_restore") return created ? member.pubkey : null;
    if (command === "identity_create") {
      created = true;
      return member.pubkey;
    }
    if (command === "relay_sign")
      return signed(member, (args as { event: EventTemplate }).event);
    if (command !== "relay_http")
      throw new Error(`Unexpected command ${command}`);
    const request = args as {
      community: string;
      path: string;
      method: string;
      body: string | null;
    };
    const body: unknown = request.body ? JSON.parse(request.body) : null;
    calls.push({ ...request, body });
    const answer = (status: number, value?: unknown) => ({
      status,
      headers: {},
      body: value === undefined ? "" : JSON.stringify(value),
    });
    if (request.path === "/")
      return answer(200, {
        name: "Buzz Relay",
        self: relayKey.pubkey,
        icon: "https://cdn.example.com/icon.png",
      });
    if (request.path === "/api/join-policy") return answer(404);
    if (request.path === "/query") {
      const filters = body as Array<{ kinds?: number[] }>;
      if (!filters.some((filter) => filter.kinds?.includes(0)))
        return answer(200, []);
      await relay.query;
      if (!relay.admitted) return answer(403, { error: "membership required" });
      return answer(200, relay.profile ? [relay.profile] : []);
    }
    return answer(404);
  });
  return relay;
}
async function joinCommunityPage(identity: Identity) {
  const communities = communitiesFor(identity);
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={communities}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={vi.fn().mockResolvedValue(undefined)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await screen.findByRole("heading", { name: "Join a community" });
  await user.type(
    screen.getByRole("textbox", { name: "Community URL" }),
    "relay.example.com:8443{Enter}",
  );
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
  return { communities, user };
}

it("Join proves admission with the signed profile read, saves the membership, and opens the app on it", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.profile = profile(member, { name: "Ada", picture: "" });
  const gate = deferred<void>();
  relay.query = gate.promise;
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  expect(relay.calls.map((call) => call.method)).toEqual(["GET", "GET"]);
  expect(screen.getByRole("button", { name: "Join" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Join" }));
  // The read is in flight: the page holds still and the app stays hidden.
  expect(screen.getByRole("status")).toHaveTextContent("Joining…");
  expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await waitFor(() => expect(relay.calls).toHaveLength(4));
  expect(relay.calls).toEqual([
    { community: relay.origin, path: "/", method: "GET", body: null },
    {
      community: relay.origin,
      path: "/api/join-policy",
      method: "GET",
      body: null,
    },
    { community: relay.origin, path: "/", method: "GET", body: null },
    {
      community: relay.origin,
      path: "/query",
      method: "POST",
      body: [
        {
          kinds: [0],
          authors: [member.pubkey],
          limit: 5,
          consistency: "strong",
        },
      ],
    },
  ]);
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(communities.snapshot().memberships).toEqual([]);
  await act(async () => gate.resolve());
  expect(await screen.findByText("Signed in")).toBeVisible();
  const membership = {
    id: relay.origin,
    name: "relay.example.com:8443",
    icon: "https://cdn.example.com/icon.png",
  };
  expect(communities.snapshot()).toMatchObject({
    status: "ready",
    viewer: member.pubkey,
    memberships: [membership],
    selected: relay.origin,
  });
  // The device record the next launch restores: the relay's existing profile
  // seeds the empty local default; nothing was published to get there.
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${member.pubkey}`) ?? ""),
  ).toEqual({
    profile: { name: "Ada", picture: "", about: "" },
    memberships: [membership],
    selected: relay.origin,
  });
  expect(relay.calls.some((call) => call.path === "/events")).toBe(false);
  identity.dispose();
});

it("a relay that refuses the read says the community needs an invite, shows the npub to send, and keeps the typed URL", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.admitted = false;
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByRole("heading", {
      name: "This community needs an invite",
    }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "relay.example.com:8443 admits members by invite, and this key has none yet. Send your public key to a community administrator so they can add you, then try again.",
  );
  // The created key, as the full npub an admin pastes; never hex.
  const npub = npubEncode(member.pubkey);
  expect(
    screen.getByRole("heading", { name: "Your public key (npub)" }),
  ).toBeVisible();
  expect(screen.getByText(npub)).toBeVisible();
  expect(screen.queryByText(member.pubkey)).toBeNull();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await user.click(screen.getByRole("button", { name: "Copy npub" }));
  expect(write).toHaveBeenCalledWith(npub);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Public key copied."),
  );
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(communities.snapshot().memberships).toEqual([]);
  expect(localStorage.getItem(`buzz-client.v1:${member.pubkey}`)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back" }));
  // Back lands on the find page, which looks the community up again.
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Community URL" })).toHaveValue(
    "relay.example.com:8443",
  );
  identity.dispose();
});

it("Try again on the invite page repeats the signed read and enters the app once the relay admits the key", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.admitted = false;
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  await user.click(screen.getByRole("button", { name: "Join" }));
  await screen.findByRole("heading", {
    name: "This community needs an invite",
  });
  expect(relay.calls).toHaveLength(4);
  // The admin has added the key in the meantime; the read is held to show the
  // page waiting on it.
  relay.admitted = true;
  const gate = deferred<void>();
  relay.query = gate.promise;
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByRole("button", { name: "Trying again…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
  await waitFor(() => expect(relay.calls).toHaveLength(6));
  expect(relay.calls.slice(4)).toEqual([
    { community: relay.origin, path: "/", method: "GET", body: null },
    {
      community: relay.origin,
      path: "/query",
      method: "POST",
      body: [
        {
          kinds: [0],
          authors: [member.pubkey],
          limit: 5,
          consistency: "strong",
        },
      ],
    },
  ]);
  expect(screen.queryByText("Signed in")).toBeNull();
  await act(async () => gate.resolve());
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relay.origin, name: "relay.example.com:8443" }],
    selected: relay.origin,
  });
  identity.dispose();
});

it("a device record that will not save names the storage failure and leaves nothing joined", async () => {
  const member = keypair();
  nativeRelay(member);
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("QuotaExceededError");
  });
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(
    await screen.findByRole("heading", { name: "Couldn’t join community" }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not save this community on this device. Try again.",
  );
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(communities.snapshot()).toMatchObject({
    memberships: [],
    selected: null,
  });
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  identity.dispose();
});

it("a key creation failure stops setup and Back returns to the first-launch screen", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce("Keychain refused to save the key");
  const connect = vi.fn().mockResolvedValue(credential);
  const { delay, release } = gatedDelay();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      connect={connect}
      delay={delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Downloading keys… [TODO]",
  );
  await release(0);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keychain refused to save the key",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  // Later placeholder steps never run after the failure.
  expect(delay).toHaveBeenCalledTimes(1);
  expect(identity.snapshot().status).toBe("missing");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(welcomeHeading()).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(connectButton()).toBeEnabled();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

it("a failed or canceled sign-in returns to the first-launch screen", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  const released = deferred<Credential>();
  let signal: AbortSignal | undefined;
  const connect = vi
    .fn()
    .mockRejectedValueOnce(new Error("Browser could not open."))
    .mockImplementationOnce((current: AbortSignal) => {
      signal = current;
      return released.promise;
    });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome identity={identity} communities={noJoin} connect={connect}>
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Browser could not open.",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t connect to Builderlab" }),
  ).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Buzz" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(welcomeHeading()).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(connectButton());
  try {
    await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(signal?.aborted).toBe(true);
    expect(connectButton()).toBeEnabled();
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    await act(async () => released.resolve(credential));
  }
  // A canceled attempt's late credential never signs the user in.
  expect(welcomeHeading()).toBeVisible();
  expect(connect).toHaveBeenCalledTimes(2);
  identity.dispose();
});

it("restore denial does not become first run or generate a replacement", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const startDragging = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getCurrentWindow).mockReturnValue({
    startDragging,
  } as unknown as ReturnType<typeof getCurrentWindow>);
  vi.mocked(invoke)
    .mockRejectedValueOnce("Keychain access was denied")
    .mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome identity={identity} communities={noJoin} connect={vi.fn()}>
      <p>Restored</p>
    </Welcome>,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keychain access was denied",
  );
  expect(
    screen.queryByRole("button", { name: "Connect with Builderlab" }),
  ).toBeNull();
  fireEvent.mouseDown(titleBar(), {
    button: 0,
    detail: 1,
  });
  expect(startDragging).toHaveBeenCalledOnce();
  await user.click(
    screen.getByRole("button", { name: "Retry secure storage access" }),
  );
  expect(await screen.findByText("Restored")).toBeVisible();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_restore",
  ]);
  identity.dispose();
});

it("import failure keeps setup open without falling through to creation", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce("Invalid nsec");
  const identity = createIdentity();
  await waitFor(() => expect(identity.snapshot().status).toBe("missing"));
  await identity.importKey(key);
  expect(identity.snapshot()).toEqual({
    status: "missing",
    busy: false,
    error: "Invalid nsec",
  });
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_import",
  ]);
  identity.dispose();
});

it("coalesces pending creation and only creates on explicit request", async () => {
  const created = deferred<string>();
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(() => created.promise);
  const identity = createIdentity();
  await waitFor(() => expect(identity.snapshot().status).toBe("missing"));
  expect(invoke).toHaveBeenCalledTimes(1);
  const first = identity.create();
  await identity.create();
  expect(invoke).toHaveBeenCalledTimes(2);
  created.resolve(viewer);
  await first;
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  identity.dispose();
});

it("fetches a private key only on interaction, masks by absence, and cancels a late reveal", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const exported = deferred<string>();
  vi.mocked(invoke).mockImplementationOnce(() => exported.promise);
  const user = userEvent.setup();
  const view = render(<PrivateKey identity={identity} />);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {
    exported.resolve(key);
  });
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  vi.mocked(invoke).mockResolvedValueOnce(key);
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(key);
  view.unmount();
  render(<PrivateKey identity={identity} />);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  identity.dispose();
});

it("copies without revealing and cancels a pending export on blur before clipboard access", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  vi.mocked(invoke).mockResolvedValueOnce(key);
  render(<PrivateKey identity={identity} />);
  await user.click(screen.getByRole("button", { name: "Copy private key" }));
  expect(write).toHaveBeenCalledWith(key);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  const exported = deferred<string>();
  vi.mocked(invoke).mockImplementationOnce(() => exported.promise);
  await user.click(screen.getByRole("button", { name: "Copy private key" }));
  fireEvent(window, new Event("blur"));
  await act(async () => {
    exported.resolve(key);
  });
  expect(write).toHaveBeenCalledTimes(1);
  identity.dispose();
});

it("enables packaged identity on desktop platforms but never in the live broker or browser", () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  for (const platform of ["MacIntel", "Win32", "Linux x86_64"]) {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    expect(nativeIdentityEnabled()).toBe(true);
  }
  vi.stubEnv("VITE_BUZZ_LIVE", "1");
  expect(nativeIdentityEnabled()).toBe(false);
  vi.stubEnv("VITE_BUZZ_LIVE", "");
  vi.mocked(isTauri).mockReturnValue(false);
  expect(nativeIdentityEnabled()).toBe(false);
  vi.mocked(isTauri).mockReturnValue(true);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("iPhone");
  expect(nativeIdentityEnabled()).toBe(false);
});

it.each(["Linux x86_64", "Win32"])(
  "keeps %s window controls available before identity restoration completes",
  (platform) => {
    vi.mocked(isTauri).mockReturnValue(true);
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
    const identity = createIdentity();
    render(
      <Welcome identity={identity} communities={noJoin} connect={vi.fn()}>
        Signed in
      </Welcome>,
    );
    expect(titleBar()).toHaveAttribute("data-tauri-drag-region", "true");
    expect(screen.getByRole("button", { name: "Close window" })).toBeEnabled();
    identity.dispose();
  },
);

it("unlocks Sign out only after a reveal or copy, the key box, and the wipe phrase when wiping", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const user = userEvent.setup();
  vi.mocked(invoke).mockResolvedValueOnce(null);
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  const confirm = () => screen.getByRole("button", { name: /^Sign out/ });
  const haveKey = screen.getByRole("checkbox", { name: "I have my key" });
  expect(haveKey).toHaveAttribute("aria-disabled", "true");
  expect(confirm()).toBeDisabled();
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  vi.mocked(invoke).mockResolvedValueOnce(key);
  await user.click(screen.getByRole("button", { name: "Copy private key" }));
  expect(confirm()).toBeDisabled();
  await user.click(haveKey);
  expect(confirm()).toBeEnabled();
  await user.click(
    screen.getByRole("checkbox", {
      name: "Also erase everything else Buzz stores on this device",
    }),
  );
  expect(confirm()).toBeDisabled();
  expect(screen.queryByText(/Erasing is unavailable/)).toBeNull();
  await user.click(
    screen.getByRole("checkbox", { name: "Also remove my agents" }),
  );
  await user.type(screen.getByLabelText(/to confirm/), WIPE_PHRASE);
  expect(confirm()).toBeEnabled();
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await user.click(confirm());
  expect(invoke).toHaveBeenLastCalledWith("sign_out", {
    wipe: true,
    removeAgents: true,
  });
  identity.dispose();
});

it("disables wipe with the native reason when the build can't wipe", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  vi.mocked(invoke).mockResolvedValueOnce(
    "Erasing is unavailable in development builds because they share agent keys with the installed Buzz",
  );
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  expect(
    await screen.findByText(/Erasing is unavailable in development builds/),
  ).toBeVisible();
  expect(invoke).toHaveBeenLastCalledWith("sign_out_wipe_refusal");
  expect(
    screen.getByRole("checkbox", {
      name: "Also erase everything else Buzz stores on this device",
    }),
  ).toHaveAttribute("aria-disabled", "true");
  identity.dispose();
});

it("keeps wipe disabled while the native answer is pending", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const answer = deferred<string | null>();
  vi.mocked(invoke).mockReturnValueOnce(answer.promise);
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  const wipe = screen.getByRole("checkbox", {
    name: "Also erase everything else Buzz stores on this device",
  });
  try {
    expect(invoke).toHaveBeenLastCalledWith("sign_out_wipe_refusal");
    expect(wipe).toHaveAttribute("aria-disabled", "true");
  } finally {
    answer.resolve(null);
  }
  await waitFor(() =>
    expect(wipe).not.toHaveAttribute("aria-disabled", "true"),
  );
  identity.dispose();
});

it("keeps wipe disabled when the native check fails", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  vi.mocked(invoke).mockRejectedValueOnce(new Error("ipc failed"));
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  expect(
    await screen.findByText(/Couldn’t check whether erasing is available/),
  ).toBeVisible();
  expect(
    screen.getByRole("checkbox", {
      name: "Also erase everything else Buzz stores on this device",
    }),
  ).toHaveAttribute("aria-disabled", "true");
  identity.dispose();
});

it("keeps the dialog open and shows the error when native sign out refuses", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const user = userEvent.setup();
  vi.mocked(invoke).mockResolvedValueOnce(null);
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  vi.mocked(invoke).mockResolvedValueOnce(key);
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  await user.click(screen.getByRole("checkbox", { name: "I have my key" }));
  vi.mocked(invoke).mockRejectedValueOnce("Agents didn't stop");
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Agents didn't stop",
  );
  expect(invoke).toHaveBeenLastCalledWith("sign_out", {
    wipe: false,
    removeAgents: false,
  });
  identity.dispose();
});

it("shows a native refusal's message and offers a retry", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(viewer);
  const identity = createIdentity();
  await identity.ready;
  const user = userEvent.setup();
  vi.mocked(invoke).mockResolvedValueOnce(null);
  render(<SignOutDialog identity={identity} onClose={() => {}} />);
  vi.mocked(invoke).mockResolvedValueOnce(key);
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  await user.click(screen.getByRole("checkbox", { name: "I have my key" }));
  vi.mocked(invoke).mockRejectedValueOnce({
    message: "Quit every other Buzz window using this sign-in.",
  });
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Quit every other Buzz window using this sign-in.",
  );
  expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  identity.dispose();
});
