// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  createEvent,
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
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
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
import { BackupError, type BackupStatus } from "./backup";
import {
  builderlabAccount,
  type FirstRunAccount,
  type OwnedCommunity,
} from "./builderlab-account";
import { createCommunities } from "../communities/service";
import { connectNativeTransport } from "../relay/native";
import { keypair, profile, signed } from "../relay/testing";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
  Channel: class {
    constructor(public onmessage: (response: unknown) => void) {}
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));
const viewer = "ab".repeat(32);
const key = "nsec-fixture-only";
/** A real key for the import journeys: native import takes the bech32 nsec as typed. */
const owned = keypair();
const ownedNsec = nsecEncode(owned.secret);
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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
/** Welcome reads the Communities service only to join; these screens never get there. */
const noJoin: ComponentProps<typeof Welcome>["communities"] = {
  snapshot() {
    throw new Error("Welcome consulted communities before a join");
  },
  joined() {
    throw new Error("Welcome joined without a join");
  },
  saveProfile() {
    throw new Error("Welcome saved a profile without a join");
  },
};
type BackupAnswers = Partial<
  Pick<FirstRunAccount, "backupOffered" | "backUp" | "declineBackup">
>;
/** Backup offered, as on the build's own portal, and every backup succeeding. */
const backupAnswers = {
  backupOffered: () => Promise.resolve(true),
  backUp: () => Promise.resolve(),
  declineBackup: () => Promise.resolve(),
} satisfies BackupAnswers;
/** The signed-in account with no key bound and nothing owned, binding through `bind`. */
const unlinkedWith =
  (
    bind: FirstRunAccount["bind"],
    backup: BackupAnswers = {},
  ): ComponentProps<typeof Welcome>["account"] =>
  () => ({
    linkedKey: () => Promise.resolve(null),
    ownedCommunities: () => Promise.resolve([]),
    bind,
    ...backupAnswers,
    ...backup,
  });
/** Today's every user: nothing bound or owned, and binding the new key succeeds. */
const unlinked = unlinkedWith(() => Promise.resolve());
const roots: Context[] = [];
/** The production shape: the service exists at startup and hydrates once the key is ready. */
function communitiesFor(identity: Identity, openRelay = "") {
  const ctx = new Context();
  roots.push(ctx);
  return createCommunities(
    ctx,
    false,
    undefined,
    openRelay,
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

it("first launch offers Builderlab and a live community URL field, with QR scanning disabled", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  const identity = createIdentity();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinked}
      connect={vi.fn()}
    >
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
  expect(url).toBeEnabled();
  expect(url).toHaveValue("");
  expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();
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

/**
 * A relay that answers the two unauthenticated reads a landing URL triggers,
 * before any key exists. `info` holds the NIP-11 answer so the page can be
 * observed waiting on it; the policy is missing, as on most deployments.
 * `created` holds key creation so "Creating keys…" can be observed.
 */
function landingRelay(
  origin = "https://relay.example.com:8443",
  created: Promise<string> = Promise.resolve(viewer),
) {
  const relayCalls: unknown[] = [];
  const info = deferred<void>();
  const answer = (status: number, body = "") => ({ status, headers: {}, body });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return null;
    if (command === "identity_create") return created;
    if (command === "identity_import") return owned.pubkey;
    if (command === "identity_export") return key;
    if (command !== "relay_http")
      throw new Error(`Unexpected command ${command}`);
    relayCalls.push(args);
    const { path } = args as { path: string };
    if (path !== "/") return answer(404);
    await info.promise;
    return answer(
      200,
      JSON.stringify({
        name: "Buzz Relay",
        icon: "https://cdn.example.com/icon.png",
      }),
    );
  });
  const get = (path: string) => ({
    community: origin,
    path,
    method: "GET",
    body: null,
  });
  return { relayCalls, info, lookup: [get("/"), get("/api/join-policy")] };
}
const urlField = () => screen.getByRole("textbox", { name: "Community URL" });
const urlJoin = () => screen.getByRole("button", { name: "Join" });
/** The key choice every Builderlab setup pauses on; Manage creates and backs up the key. */
const manageKeysForMe = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(
    await screen.findByRole("button", { name: "Manage my keys for me" }),
  );
/** The test table: relay.example.com (any subdomain, default port) signs in at tenant.example. */
const tenants = [
  { relayHost: "relay.example.com", loginOrigin: "https://tenant.example" },
];

it("a landing URL is looked up before sign-in, a tenant's relay signs in at that tenant's portal, setup then lands on Join Community, and Cancel reaches Join a community with the address kept", async () => {
  const relay = landingRelay("https://relay.example.com");
  const released = deferred<Credential>();
  const connect = vi.fn(
    (_signal: AbortSignal, _origin?: string) => released.promise,
  );
  const { delay, release } = gatedDelay();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinked}
      connect={connect}
      tenants={tenants}
      delay={delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: "Connect with Builderlab" });
  await user.type(urlField(), "Design.Relay.Example.com{Enter}");
  // Discovery: the same two unauthenticated GETs the find page sends, with
  // no sign-in and no key yet.
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent(
    "design.relay.example.com",
  );
  const lookup = relay.lookup.map((call) => ({
    ...call,
    community: "https://design.relay.example.com",
  }));
  expect(relay.relayCalls).toEqual(lookup);
  expect(connect).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  await act(async () => relay.info.resolve());
  // Found: the host matches the tenant row as a subdomain, so sign-in starts
  // at once at that tenant's portal; the landing shows it pending with the
  // typed address held in the disabled field.
  expect(connect).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledWith(
    expect.any(AbortSignal),
    "https://tenant.example",
  );
  expect(
    screen.queryByRole("heading", { name: "Finding community" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  expect(urlField()).toBeDisabled();
  expect(urlField()).toHaveValue("Design.Relay.Example.com");
  expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();
  await act(async () => released.resolve(credential));
  // The account check found no key, so the backed-up-key lookup comes next.
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking for a backed-up key… [TODO]",
    ),
  );
  await release(0);
  expect(
    screen.getByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  await manageKeysForMe(user);
  // Setup ran (the key exists) and landed on the find page for that URL, not
  // on the choices page.
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(delay.mock.calls).toEqual([[2000]]);
  expect(invoke).toHaveBeenCalledWith("identity_create", {});
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(relay.relayCalls).toEqual([...lookup, ...lookup]);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(urlField()).toHaveValue("Design.Relay.Example.com");
  // Join from the choices page looks the same address up again.
  await user.click(urlJoin());
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(relay.relayCalls).toHaveLength(6);
  identity.dispose();
});

it("a landing URL no tenant hosts skips Builderlab: setup only creates the key, then lands on Join Community", async () => {
  // The same host on a non-default port is not a tenant's relay.
  const created = deferred<string>();
  const relay = landingRelay(undefined, created.promise);
  const connect = vi.fn();
  const delay = vi.fn();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinked}
      connect={connect}
      tenants={tenants}
      delay={delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: "Connect with Builderlab" });
  await user.type(urlField(), "relay.example.com:8443{Enter}");
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(relay.relayCalls).toEqual(relay.lookup);
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  await act(async () => relay.info.resolve());
  // Found, key-only: no sign-in, no key backup placeholders, just the key.
  expect(
    screen.getByRole("heading", { name: "Setting up Buzz" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Creating keys…");
  expect(invoke).toHaveBeenCalledWith("identity_create", {});
  expect(connect).not.toHaveBeenCalled();
  expect(delay).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
  await act(async () => created.resolve(viewer));
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(connect).not.toHaveBeenCalled();
  expect(delay).not.toHaveBeenCalled();
  expect(relay.relayCalls).toEqual([...relay.lookup, ...relay.lookup]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
    "identity_create",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

it("a landing URL that cannot be reached fails before sign-in, and Cancel keeps the address", async () => {
  const relayCalls: unknown[] = [];
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "relay_http") {
      relayCalls.push(args);
      return Promise.reject(new Error("connection refused"));
    }
    throw new Error(`Unexpected command ${command}`);
  });
  const connect = vi.fn();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinked}
      connect={connect}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: "Connect with Builderlab" });
  await user.type(urlField(), "relay.example.com{Enter}");
  expect(
    await screen.findByRole("heading", { name: "Couldn’t find community" }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not reach the relay. Check your connection and try again.",
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  expect(connect).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(welcomeHeading()).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(connectButton()).toBeEnabled();
  expect(urlField()).toHaveValue("relay.example.com");
  expect(relayCalls).toHaveLength(2);
  expect(identity.snapshot().status).toBe("missing");
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

it("canceling or failing sign-in after a landing URL returns to the landing with the address kept and no second lookup", async () => {
  const relay = landingRelay("https://relay.example.com");
  relay.info.resolve();
  let signal: AbortSignal | undefined;
  const connect = vi
    .fn<(signal: AbortSignal, origin?: string) => Promise<Credential>>()
    .mockImplementationOnce((current) => {
      signal = current;
      return new Promise(() => {});
    })
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockRejectedValueOnce(new Error("Browser could not open."));
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinked}
      connect={connect}
      tenants={tenants}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: "Connect with Builderlab" });
  await user.type(urlField(), "relay.example.com{Enter}");
  await screen.findByRole("button", { name: "Cancel sign-in" });
  expect(connect).toHaveBeenCalledWith(
    expect.any(AbortSignal),
    "https://tenant.example",
  );
  expect(connect).toHaveBeenCalledTimes(1);
  expect(relay.relayCalls).toEqual(relay.lookup);
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(signal?.aborted).toBe(true);
  // Back on the landing: the typed address is editable again and discovery
  // did not restart on its own.
  expect(welcomeHeading()).toBeVisible();
  expect(connectButton()).toBeEnabled();
  expect(urlField()).toBeEnabled();
  expect(urlField()).toHaveValue("relay.example.com");
  expect(
    screen.queryByRole("heading", { name: "Finding community" }),
  ).toBeNull();
  expect(relay.relayCalls).toEqual(relay.lookup);
  // Connect without the URL: the tenant origin from the cancelled sign-in
  // must not leak into this one.
  await user.click(connectButton());
  await screen.findByRole("button", { name: "Cancel sign-in" });
  expect(connect).toHaveBeenCalledTimes(2);
  expect(connect).toHaveBeenLastCalledWith(expect.any(AbortSignal), undefined);
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(welcomeHeading()).toBeVisible();
  expect(urlField()).toHaveValue("relay.example.com");
  expect(relay.relayCalls).toEqual(relay.lookup);
  // Join again: a fresh lookup, then a sign-in that fails; Back behaves the same.
  await user.click(urlJoin());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Browser could not open.",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t connect to Builderlab" }),
  ).toBeVisible();
  expect(connect).toHaveBeenCalledTimes(3);
  expect(relay.relayCalls).toEqual([...relay.lookup, ...relay.lookup]);
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(welcomeHeading()).toBeVisible();
  expect(urlField()).toHaveValue("relay.example.com");
  expect(
    screen.queryByRole("heading", { name: "Finding community" }),
  ).toBeNull();
  expect(relay.relayCalls).toHaveLength(4);
  expect(identity.snapshot().status).toBe("missing");
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
  const gate = (index: number) => {
    const found = gates[index];
    if (!found) throw new Error(`Step ${index} never started waiting`);
    return found;
  };
  const release = (index: number) => act(async () => gate(index).resolve());
  /** The placeholder's real call failed. */
  const fail = (index: number, error: Error) =>
    act(async () => gate(index).reject(error));
  return { delay, release, fail };
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
  const linked = deferred<string | null>();
  const bound = deferred<void>();
  const bind = vi.fn((_pubkey: string) => bound.promise);
  const backedUp = deferred<void>();
  const backUp = vi.fn((_pubkey: string) => backedUp.promise);
  const account = vi.fn(() => ({
    linkedKey: () => linked.promise,
    ownedCommunities: () => Promise.resolve([]),
    bind,
    ...backupAnswers,
    backUp,
  }));
  const { delay, release } = gatedDelay();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={account}
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
  // No community URL chose a tenant, so sign-in uses the build's default origin.
  expect(connect).toHaveBeenCalledWith(expect.any(AbortSignal), undefined);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Finish sign-in in your browser",
  );
  expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeEnabled();
  await act(async () => released.resolve(credential));
  expect(
    screen.getByRole("heading", { name: "Setting up Buzz" }),
  ).toBeVisible();
  // The account check is real and runs first: it decides the lane.
  expect(account).toHaveBeenCalledWith(credential, undefined, identity);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Checking your account…",
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  await act(async () => linked.resolve(null));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Checking for a backed-up key… [TODO]",
  );
  await release(0);
  // The lookup found nothing, so setup pauses for the key choice before any
  // key exists.
  expect(
    screen.getByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  expect(screen.getByText(/backed-up key for a@example\.com/)).toBeVisible();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  expect(
    screen.getByRole("button", { name: "I already have a key" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "I want to manage my own key" }),
  ).toBeEnabled();
  await manageKeysForMe(user);
  expect(screen.getByRole("status")).toHaveTextContent("Creating keys…");
  expect(invoke).toHaveBeenCalledWith("identity_create", {});
  expect(bind).not.toHaveBeenCalled();
  await act(async () => created.resolve(viewer));
  // The key is now ready, but setup keeps the app behind the onboarding screens.
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(screen.queryByText("Signed in")).toBeNull();
  // The created key is bound to the account before anything is backed up.
  expect(screen.getByRole("status")).toHaveTextContent("Linking your key…");
  expect(bind.mock.calls).toEqual([[viewer]]);
  expect(backUp).not.toHaveBeenCalled();
  await act(async () => bound.resolve());
  // Then backed up, waiting on the native uploader's own answer.
  expect(screen.getByRole("status")).toHaveTextContent("Backing up your key…");
  expect(backUp.mock.calls).toEqual([[viewer]]);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  await act(async () => backedUp.resolve());
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  // No invite list yet: nothing serves pending invites, so the URL field is the only entry.
  expect(screen.queryByRole("list")).toBeNull();
  const url = screen.getByRole("textbox", { name: "Community URL" });
  expect(url).toBeEnabled();
  expect(url).toHaveValue("");
  expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();
  for (const name of [
    "Scan a QR code — Coming soon",
    "Create a community — Coming soon",
  ]) {
    expect(screen.getByRole("button", { name })).toBeDisabled();
  }
  expect(delay.mock.calls).toEqual([[2000]]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

it("a link that fails after the key is created stops setup before the backup, says the key is saved, and Show my key reveals it before Join a community", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    if (command === "identity_export") return Promise.resolve(key);
    throw new Error(`Unexpected command ${command}`);
  });
  const bind = vi.fn((_pubkey: string) =>
    Promise.reject(
      new Error(
        "This Builderlab account is connected to another Buzz identity.",
      ),
    ),
  );
  const backUp = vi.fn((_pubkey: string) => Promise.resolve());
  const declineBackup = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinkedWith(bind, { backUp, declineBackup })}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={vi.fn().mockResolvedValue(undefined)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await manageKeysForMe(user);
  expect(
    await screen.findByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "This Builderlab account is connected to another Buzz identity.",
  );
  expect(screen.getByText("Your key is saved on this device.")).toBeVisible();
  expect(bind.mock.calls).toEqual([[viewer]]);
  // The key is saved; the backup never ran, and the app stays hidden.
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  expect(backUp).not.toHaveBeenCalled();
  expect(screen.queryByText("Signed in")).toBeNull();
  // A key neither backed up nor seen must be shown before first run ends, and
  // a refused link is not one Try again can fix.
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Show my key" }));
  expect(
    await screen.findByRole("heading", { name: "Your private identity key" }),
  ).toBeVisible();
  expect(await screen.findByText(key)).toBeVisible();
  // Nothing turned backup on, so there is nothing to decline.
  expect(declineBackup).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("checkbox", {
      name: "I’ve saved my private key somewhere safe",
    }),
  );
  await user.click(
    screen.getByRole("button", { name: "Continue without backing up" }),
  );
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
    "identity_export",
  ]);
  identity.dispose();
});

it("a backup Builderlab does not offer for the account fails after Manage my keys for me, and Show my key turns automatic backup off before the reveal", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    if (command === "identity_export") return Promise.resolve(key);
    throw new Error(`Unexpected command ${command}`);
  });
  const backUp = vi.fn((_pubkey: string) =>
    Promise.reject(new BackupError("not_offered")),
  );
  const declined = deferred<void>();
  const declineBackup = vi.fn((_pubkey: string) => declined.promise);
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinkedWith(() => Promise.resolve(), {
        backUp,
        declineBackup,
      })}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={vi.fn().mockResolvedValue(undefined)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await manageKeysForMe(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Builderlab doesn’t offer key backup for this account yet.",
  );
  expect(screen.getByText("Your key is saved on this device.")).toBeVisible();
  expect(backUp.mock.calls).toEqual([[viewer]]);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Show my key" }));
  // The failed page stays up until consent is off.
  expect(declineBackup.mock.calls).toEqual([[viewer]]);
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  await act(async () => declined.resolve());
  expect(
    await screen.findByRole("heading", { name: "Your private identity key" }),
  ).toBeVisible();
  expect(await screen.findByText(key)).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
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
      account={unlinked}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={vi.fn().mockResolvedValue(undefined)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await manageKeysForMe(user);
  await screen.findByRole("heading", { name: "Join a community" });
  const field = () => screen.getByRole("textbox", { name: "Community URL" });
  // The page remounts after Cancel, so look the button up each time.
  const join = () => screen.getByRole("button", { name: "Join" });
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
      account={unlinked}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={vi.fn().mockResolvedValue(undefined)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await manageKeysForMe(user);
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
 * observable; `admitted` decides whether that read is answered or refused, and
 * `publish` whether a kind 0 posted to `/events` is accepted or fails with 500.
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
    publish: true,
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
    if (command === "identity_export") return key;
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
    if (request.path === "/events") {
      if (!relay.publish) return answer(500);
      relay.profile = body as ReturnType<typeof profile>;
      return answer(200, { accepted: true, event_id: relay.profile.id });
    }
    return answer(404);
  });
  return relay;
}
async function joinCommunityPage(identity: Identity, openRelay = "") {
  const communities = communitiesFor(identity, openRelay);
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={communities}
      account={unlinked}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={vi.fn().mockResolvedValue(undefined)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await manageKeysForMe(user);
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

const eventsCalls = (relay: ReturnType<typeof nativeRelay>) =>
  relay.calls.filter((call) => call.path === "/events");

it("Join proves admission with the signed profile read, saves the membership, and continues to the profile step, whose Continue publishes the kind 0 and opens the app", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
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
  // The membership is saved and selected, but the first community continues
  // to the profile step rather than into the app.
  expect(
    await screen.findByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
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
  expect(
    screen.getByText(/agent handoffs in relay\.example\.com:8443\./),
  ).toBeVisible();
  // The relay holds no profile for the new key: the Builderlab email's local
  // part is suggested, focused, and Continue needs a name.
  const name = screen.getByRole("textbox", { name: "Display name" });
  expect(name).toHaveValue("a");
  expect(name).toHaveFocus();
  await user.clear(name);
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
  await user.type(name, "Ada{Enter}");
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(eventsCalls(relay)).toEqual([
    {
      community: relay.origin,
      path: "/events",
      method: "POST",
      body: expect.objectContaining({
        kind: 0,
        pubkey: member.pubkey,
        tags: [],
        content: JSON.stringify({
          name: "Ada",
          display_name: "Ada",
          picture: "",
          about: "",
        }),
      }),
    },
  ]);
  // The device record the next launch restores carries the published name as
  // the local default for later joins.
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${member.pubkey}`) ?? ""),
  ).toEqual({
    profile: { name: "Ada", picture: "", about: "" },
    memberships: [membership],
    selected: relay.origin,
  });
  expect(communities.snapshot().selected).toBe(relay.origin);
  identity.dispose();
});

it("Skip for now enters the app with the relay's existing profile as the local default and publishes nothing", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.profile = profile(member, { name: "Ada", picture: "" });
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  await user.click(screen.getByRole("button", { name: "Join" }));
  await screen.findByRole("heading", { name: "Set up your profile" });
  // An existing relay profile is what the fields start from.
  expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
    "Ada",
  );
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  const membership = {
    id: relay.origin,
    name: "relay.example.com:8443",
    icon: "https://cdn.example.com/icon.png",
  };
  expect(communities.snapshot()).toMatchObject({
    memberships: [membership],
    selected: relay.origin,
  });
  // The relay's existing profile seeds the empty local default; nothing was
  // published to get there.
  expect(
    JSON.parse(localStorage.getItem(`buzz-client.v1:${member.pubkey}`) ?? ""),
  ).toEqual({
    profile: { name: "Ada", picture: "", about: "" },
    memberships: [membership],
    selected: relay.origin,
  });
  expect(eventsCalls(relay)).toEqual([]);
  identity.dispose();
});

it("a relay that rejects the profile publish keeps the step with the error inline, and Skip still enters the app", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  relay.publish = false;
  const identity = createIdentity();
  const { communities, user } = await joinCommunityPage(identity);
  await user.click(screen.getByRole("button", { name: "Join" }));
  await screen.findByRole("heading", { name: "Set up your profile" });
  const name = screen.getByRole("textbox", { name: "Display name" });
  await user.clear(name);
  await user.type(name, "Ada");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Community request failed (500)",
  );
  expect(
    screen.getByRole("heading", { name: "Set up your profile" }),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(name).toHaveValue("Ada");
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Skip for now" })).toBeEnabled();
  expect(eventsCalls(relay)).toHaveLength(1);
  // The membership stands; the rejected name never became the local default.
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: relay.origin }],
    selected: relay.origin,
    profile: { name: "", picture: "", about: "" },
  });
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(eventsCalls(relay)).toHaveLength(1);
  expect(communities.snapshot().profile).toEqual({
    name: "",
    picture: "",
    about: "",
  });
  identity.dispose();
});

it("a key whose device record already holds a community skips the profile step and enters the app on the new one", async () => {
  const member = keypair();
  const relay = nativeRelay(member);
  const identity = createIdentity();
  // The development seed: one membership before this join.
  const { communities, user } = await joinCommunityPage(
    identity,
    "https://other.example.com",
  );
  expect(communities.snapshot().memberships).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Join" }));
  expect(await screen.findByText("Signed in")).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Set up your profile" }),
  ).toBeNull();
  expect(communities.snapshot()).toMatchObject({
    memberships: [{ id: "https://other.example.com" }, { id: relay.origin }],
    selected: relay.origin,
  });
  expect(eventsCalls(relay)).toEqual([]);
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
  // Admitted on retry: the first community continues to the profile step.
  await user.click(await screen.findByRole("button", { name: "Skip for now" }));
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
      account={unlinked}
      connect={connect}
      delay={delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking for a backed-up key… [TODO]",
    ),
  );
  await release(0);
  await manageKeysForMe(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keychain refused to save the key",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  // Nothing runs after the failure, and no key is saved to say so of.
  expect(delay).toHaveBeenCalledTimes(1);
  expect(identity.snapshot().status).toBe("missing");
  expect(screen.queryByText("Your key is saved on this device.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
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

it("managing my own key shows the nsec on arrival with Copy, hides it on blur, and continues only once the backup box is ticked", async () => {
  const created = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return created.promise;
    if (command === "identity_export") return Promise.resolve(key);
    throw new Error(`Unexpected command ${command}`);
  });
  const { delay, release } = gatedDelay();
  const bind = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinkedWith(bind)}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await release(0);
  await user.click(
    screen.getByRole("button", { name: "I want to manage my own key" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Creating keys…");
  expect(invoke).toHaveBeenCalledWith("identity_create", {});
  // The clicked button is gone, and jsdom then aims the next focus move's
  // blur at `window`, which would hide the key. Park focus on the body first.
  act(() => {
    document.body.tabIndex = -1;
    document.body.focus();
    document.body.removeAttribute("tabindex");
  });
  await act(async () => created.resolve(viewer));
  // The reveal page fetches the key once on arrival and shows the nsec in the
  // well; the app stays hidden behind the pause.
  expect(
    await screen.findByRole("heading", { name: "Your private identity key" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  // Linked to the account on the way, like a key Builderlab manages.
  expect(bind.mock.calls).toEqual([[viewer]]);
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(await screen.findByText(key)).toHaveClass("font-mono");
  expect(screen.getByText("Private key (nsec)")).toBeVisible();
  expect(screen.queryByText(viewer)).toBeNull();
  const saved = () =>
    screen.getByRole("checkbox", {
      name: "I’ve saved my private key somewhere safe",
    });
  const proceed = () =>
    screen.getByRole("button", { name: "Continue without backing up" });
  expect(saved()).toBeEnabled();
  expect(proceed()).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Please back this up for me" }),
  ).toBeEnabled();
  // Copy reuses the shown key rather than exporting again.
  await user.click(screen.getByRole("button", { name: "Copy private key" }));
  expect(write).toHaveBeenCalledWith(key);
  expect(screen.getByRole("status")).toHaveTextContent("Private key copied.");
  expect(
    vi.mocked(invoke).mock.calls.filter(([c]) => c === "identity_export"),
  ).toHaveLength(1);
  // Window blur hides it, as everywhere else, and Reveal is offered again.
  fireEvent(window, new Event("blur"));
  expect(screen.queryByText(key)).toBeNull();
  expect(
    screen.getByRole("button", { name: "Reveal private key" }),
  ).toBeEnabled();
  await user.click(saved());
  expect(proceed()).toBeEnabled();
  await user.click(proceed());
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  // No backup ran: only the backed-up-key lookup waited.
  expect(delay.mock.calls).toEqual([[2000]]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
    "identity_export",
  ]);
  identity.dispose();
});

it("Please back this up for me on the reveal page backs the key up, Try again after a timeout re-runs only the backup, and setup lands on Join Community for a landing URL", async () => {
  const relay = landingRelay("https://relay.example.com");
  relay.info.resolve();
  const bind = vi.fn((_pubkey: string) => Promise.resolve());
  const timedOut = deferred<void>();
  const confirmed = deferred<void>();
  const backUp = vi
    .fn<FirstRunAccount["backUp"]>()
    .mockReturnValueOnce(timedOut.promise)
    .mockReturnValueOnce(confirmed.promise);
  const { delay, release } = gatedDelay();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinkedWith(bind, { backUp })}
      connect={vi.fn().mockResolvedValue(credential)}
      tenants={tenants}
      delay={delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: "Connect with Builderlab" });
  await user.type(urlField(), "relay.example.com{Enter}");
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Checking for a backed-up key… [TODO]",
  );
  await release(0);
  await user.click(
    screen.getByRole("button", { name: "I want to manage my own key" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Your private identity key" }),
  ).toBeVisible();
  expect(await screen.findByText(key)).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Please back this up for me" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Backing up your key…",
    ),
  );
  expect(screen.queryByText(key)).toBeNull();
  // Linked before the reveal; linking again sends nothing more.
  expect(bind.mock.calls).toEqual([[viewer], [viewer]]);
  await act(async () => timedOut.reject(new BackupError("timeout")));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Builderlab is taking too long to confirm your backup. Try again.",
  );
  expect(screen.getByText("Your key is saved on this device.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Show my key" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByRole("status")).toHaveTextContent("Backing up your key…");
  expect(backUp.mock.calls).toEqual([[viewer], [viewer]]);
  expect(bind).toHaveBeenCalledTimes(2);
  await act(async () => confirmed.resolve());
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(delay.mock.calls).toEqual([[2000]]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
    "identity_create",
    "identity_export",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

it("a key creation failure on the own-key path stops setup before any reveal, and Back returns to the first-launch screen", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create")
      return Promise.reject("Keychain refused to save the key");
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinked}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={vi.fn().mockResolvedValue(undefined)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "I want to manage my own key" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Keychain refused to save the key",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  expect(identity.snapshot().status).toBe("missing");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(welcomeHeading()).toBeVisible();
  expect(connectButton()).toBeEnabled();
  expect(invoke).not.toHaveBeenCalledWith("identity_export");
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

const keyField = () => screen.getByLabelText("Private key (nsec)");
const continueWithKey = () =>
  screen.getByRole("button", { name: "Continue with this key" });
const invalidKeyCopy =
  "That doesn’t look like a valid nsec. Paste an nsec1 key.";
/** Connect with the placeholders resolved, then open the import page from the choice. */
async function keyImportPage(
  user: ReturnType<typeof userEvent.setup>,
  identity: Identity,
  delay = vi.fn().mockResolvedValue(undefined),
  account = unlinked,
) {
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={account}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "I already have a key" }),
  );
  expect(
    screen.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  return delay;
}

it("I already have a key opens Enter your private key, classifies what is pasted, and Back returns to the choice with nothing created", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await keyImportPage(user, identity);
  expect(
    screen.getByText(/Paste your private key to sign in to Buzz\./),
  ).toBeVisible();
  // Masked, sensitive and focused on arrival; nothing to continue with yet.
  expect(keyField()).toHaveFocus();
  expect(keyField()).toHaveAttribute("type", "password");
  expect(keyField()).toHaveAttribute("autocomplete", "off");
  expect(keyField()).toHaveAttribute("spellcheck", "false");
  expect(continueWithKey()).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Reveal private key" }),
  ).toBeDisabled();
  expect(screen.queryByRole("alert")).toBeNull();
  await user.paste("hello");
  expect(screen.getByRole("alert")).toHaveTextContent(invalidKeyCopy);
  expect(keyField()).toHaveAccessibleDescription(invalidKeyCopy);
  expect(continueWithKey()).toBeDisabled();
  await user.clear(keyField());
  expect(screen.queryByRole("alert")).toBeNull();
  await user.paste(
    "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p",
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Password-protected backups aren’t supported here yet.",
  );
  expect(continueWithKey()).toBeDisabled();
  await user.clear(keyField());
  await user.paste(ownedNsec);
  // A valid key previews its public identity as an npub, never hex, and
  // unlocks Continue; Reveal shows the typed key and Hide masks it again.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(keyField()).toHaveAccessibleDescription(
    `Public identity: ${npubEncode(owned.pubkey)}`,
  );
  expect(screen.queryByText(owned.pubkey)).toBeNull();
  expect(continueWithKey()).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  expect(keyField()).toHaveAttribute("type", "text");
  expect(keyField()).toHaveValue(ownedNsec);
  await user.click(screen.getByRole("button", { name: "Hide private key" }));
  expect(keyField()).toHaveAttribute("type", "password");
  // Back discards the typed key and offers every choice again; no key was made.
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    screen.getByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  for (const name of [
    "Manage my keys for me",
    "I want to manage my own key",
    "I already have a key",
  ])
    expect(screen.getByRole("button", { name })).toBeEnabled();
  await user.click(
    screen.getByRole("button", { name: "I already have a key" }),
  );
  expect(keyField()).toHaveValue("");
  expect(continueWithKey()).toBeDisabled();
  expect(identity.snapshot().status).toBe("missing");
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

it("Continue with this key imports the pasted nsec behind Importing your key, links it to the new account, then lands on Join a community with no backup or reveal", async () => {
  const imported = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return imported.promise;
    throw new Error(`Unexpected command ${command}`);
  });
  const bound = deferred<void>();
  const bind = vi.fn((_pubkey: string) => bound.promise);
  const backUp = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  const delay = await keyImportPage(
    user,
    identity,
    undefined,
    unlinkedWith(bind, { backUp }),
  );
  await user.paste(ownedNsec);
  // Enter in the field submits, like the Continue button.
  await user.keyboard("{Enter}");
  expect(invoke).toHaveBeenCalledWith("identity_import", { nsec: ownedNsec });
  expect(
    screen.getByRole("heading", { name: "Setting up Buzz" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("Importing your key…");
  expect(screen.queryByLabelText("Private key (nsec)")).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(bind).not.toHaveBeenCalled();
  await act(async () => imported.resolve(owned.pubkey));
  // The account has no key, so the imported one is bound to it like a created one.
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Linking your key…"),
  );
  expect(bind.mock.calls).toEqual([[owned.pubkey]]);
  expect(screen.queryByText("Signed in")).toBeNull();
  await act(async () => bound.resolve());
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Your private identity key" }),
  ).toBeNull();
  // An imported key is already backed up wherever it came from.
  expect(backUp).not.toHaveBeenCalled();
  expect(delay.mock.calls).toEqual([[2000]]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_import",
  ]);
  identity.dispose();
});

it("a link that fails after a key is imported for a new account offers Not now, which continues to Join a community", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return Promise.resolve(owned.pubkey);
    throw new Error(`Unexpected command ${command}`);
  });
  const bind = vi.fn((_pubkey: string) =>
    Promise.reject(
      new Error(
        "This Builderlab account is connected to another Buzz identity.",
      ),
    ),
  );
  const declineBackup = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  await keyImportPage(
    user,
    identity,
    undefined,
    unlinkedWith(bind, { declineBackup }),
  );
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This Builderlab account is connected to another Buzz identity.",
  );
  expect(screen.getByText("Your key is saved on this device.")).toBeVisible();
  expect(bind.mock.calls).toEqual([[owned.pubkey]]);
  // The user already holds this key, so there is nothing to show first.
  expect(screen.queryByRole("button", { name: "Show my key" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(declineBackup).not.toHaveBeenCalled();
  expect(screen.queryByText("Signed in")).toBeNull();
  identity.dispose();
});

it("a native import refusal stays on the import page with the key kept, and Back still returns to the choice", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import")
      return Promise.reject(
        "An identity is already saved; nothing was overwritten",
      );
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await keyImportPage(user, identity);
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "An identity is already saved; nothing was overwritten",
  );
  expect(
    screen.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeNull();
  expect(keyField()).toHaveValue(ownedNsec);
  expect(continueWithKey()).toBeEnabled();
  expect(identity.snapshot().status).toBe("missing");
  // Editing the key replaces the refusal with the live classification.
  await user.type(keyField(), "x");
  expect(screen.getByRole("alert")).toHaveTextContent(invalidKeyCopy);
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(
    screen.getByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_import",
  ]);
  identity.dispose();
});

it("a dropped or chosen key file fills the field from its first line, and an oversize file is refused", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  await keyImportPage(user, identity);
  const form = screen
    .getByRole("heading", { name: "Enter your private key" })
    .closest("form");
  if (!form) throw new Error("The import page is not a form");
  const dropped = new File(
    [`\n  ${ownedNsec}  \nnot the key\n`],
    "buzz-key.txt",
    { type: "text/plain" },
  );
  fireEvent(
    form,
    createEvent.drop(form, {
      dataTransfer: { types: ["Files"], files: [dropped] },
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitFor(() => expect(keyField()).toHaveValue(ownedNsec));
  expect(keyField()).toHaveAttribute("type", "password");
  expect(keyField()).toHaveAccessibleDescription(
    `Public identity: ${npubEncode(owned.pubkey)}`,
  );
  expect(continueWithKey()).toBeEnabled();
  const picker = screen.getByLabelText("Key file");
  await user.upload(
    picker,
    new File([new Uint8Array(1025)], "big.txt", { type: "text/plain" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "That file is too large to be a private key.",
  );
  expect(keyField()).toHaveValue(ownedNsec);
  await user.upload(
    picker,
    new File(["hello\n"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(keyField()).toHaveValue("hello"));
  expect(screen.getByRole("alert")).toHaveTextContent(invalidKeyCopy);
  expect(continueWithKey()).toBeDisabled();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

it("an imported key on the tenant path lands on Join Community for the landing URL", async () => {
  const relay = landingRelay("https://relay.example.com");
  relay.info.resolve();
  const delay = vi.fn().mockResolvedValue(undefined);
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinked}
      connect={vi.fn().mockResolvedValue(credential)}
      tenants={tenants}
      delay={delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: "Connect with Builderlab" });
  await user.type(urlField(), "relay.example.com{Enter}");
  await user.click(
    await screen.findByRole("button", { name: "I already have a key" }),
  );
  await user.click(keyField());
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  // Checking for a backed-up key is the only placeholder on this path.
  expect(delay.mock.calls).toEqual([[2000]]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
    "identity_import",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

/** A real second key that is not the linked one, for the mismatch refusal. */
const stranger = keypair();
/** The signed-in account's reads once a key is bound to it. */
const linkedTo =
  (
    pubkey: string,
    communities: readonly OwnedCommunity[] = [],
    backup: BackupAnswers = {},
  ): ComponentProps<typeof Welcome>["account"] =>
  () => ({
    linkedKey: () => Promise.resolve(pubkey),
    ownedCommunities: () => Promise.resolve(communities),
    // The import accepts only the linked key: there is nothing to bind.
    bind: () => Promise.reject(new Error("Welcome bound the linked key again")),
    ...backupAnswers,
    ...backup,
  });
const linkedNpub = npubEncode(owned.pubkey);
/**
 * Connect as a linked account: the backed-up-key lookup still runs, silently
 * answering "none", and setup pauses on Welcome back instead of the choice.
 */
async function welcomeBackPage(
  user: ReturnType<typeof userEvent.setup>,
  identity: Identity,
  account: ComponentProps<typeof Welcome>["account"],
) {
  const gated = gatedDelay();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      connect={vi.fn().mockResolvedValue(credential)}
      account={account}
      delay={gated.delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking for a backed-up key… [TODO]",
    ),
  );
  await gated.release(0);
  expect(
    await screen.findByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  return gated;
}
/** Enter your private key with the linked key, through to the backup offer. */
async function importLinkedKey(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: "Enter your private key" }),
  );
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(
    await screen.findByRole("heading", { name: "Back up this key?" }),
  ).toBeVisible();
}

it("a linked account is welcomed back with its npub, accepts only the linked key, offers a backup after the import, and Not now lands on Join a community", async () => {
  const imported = deferred<string>();
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return imported.promise;
    throw new Error(`Unexpected command ${command}`);
  });
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const identity = createIdentity();
  const user = userEvent.setup();
  const { delay } = await welcomeBackPage(
    user,
    identity,
    linkedTo(owned.pubkey),
  );
  expect(screen.getByText(/already linked to a Buzz identity/)).toBeVisible();
  // The linked key in full, as an npub, never hex; no lane here creates a key.
  expect(screen.getByText(linkedNpub)).toHaveClass("font-mono");
  expect(screen.queryByText(owned.pubkey)).toBeNull();
  for (const name of [
    "Manage my keys for me",
    "I want to manage my own key",
    "I already have a key",
  ])
    expect(screen.queryByRole("button", { name })).toBeNull();
  expect(
    screen.getByRole("button", {
      name: "Recover from another device — Coming soon",
    }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "I lost this key" })).toBeEnabled();
  expect(invoke).not.toHaveBeenCalledWith("identity_create", {});
  await user.click(screen.getByRole("button", { name: "Copy npub" }));
  expect(write).toHaveBeenCalledWith(linkedNpub);
  expect(screen.getByRole("status")).toHaveTextContent("Public key copied.");
  await user.click(
    screen.getByRole("button", { name: "Enter your private key" }),
  );
  expect(
    screen.getByRole("heading", { name: "Enter your private key" }),
  ).toBeVisible();
  // Back returns to Welcome back on this lane, not to the key choice.
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await user.click(
    screen.getByRole("button", { name: "Enter your private key" }),
  );
  // A valid key that is not the linked one is refused, naming the expected npub.
  await user.paste(nsecEncode(stranger.secret));
  expect(screen.getByRole("alert")).toHaveTextContent(
    `That isn’t the key linked to this account. It expects ${linkedNpub} (the key on your other device).`,
  );
  expect(continueWithKey()).toBeDisabled();
  await user.keyboard("{Enter}");
  expect(invoke).not.toHaveBeenCalledWith("identity_import", expect.anything());
  await user.clear(keyField());
  await user.paste(ownedNsec);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(continueWithKey()).toBeEnabled();
  await user.click(continueWithKey());
  expect(invoke).toHaveBeenCalledWith("identity_import", { nsec: ownedNsec });
  expect(screen.getByRole("status")).toHaveTextContent("Importing your key…");
  await act(async () => imported.resolve(owned.pubkey));
  // Importing never uploads on its own: the backup is offered, with the app
  // still behind the pause.
  expect(
    await screen.findByRole("heading", { name: "Back up this key?" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(delay).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(screen.queryByRole("list")).toBeNull();
  expect(delay.mock.calls).toEqual([[2000]]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_import",
  ]);
  identity.dispose();
});

it("Back it up on the backup offer backs the linked key up before Join a community", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return Promise.resolve(owned.pubkey);
    throw new Error(`Unexpected command ${command}`);
  });
  const backedUp = deferred<void>();
  const backUp = vi.fn((_pubkey: string) => backedUp.promise);
  const identity = createIdentity();
  const user = userEvent.setup();
  const { delay } = await welcomeBackPage(
    user,
    identity,
    linkedTo(owned.pubkey, [], { backUp }),
  );
  await importLinkedKey(user);
  await user.click(screen.getByRole("button", { name: "Back it up" }));
  // The linked key only needs the backup: no binding step.
  expect(screen.getByRole("status")).toHaveTextContent("Backing up your key…");
  expect(backUp.mock.calls).toEqual([[owned.pubkey]]);
  await act(async () => backedUp.resolve());
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(delay.mock.calls).toEqual([[2000]]);
  identity.dispose();
});

it("a backup Builderlab refuses after the key is imported offers no Try again, and Not now turns automatic backup off and still lists the owned communities on Join a community", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return Promise.resolve(owned.pubkey);
    throw new Error(`Unexpected command ${command}`);
  });
  const backUp = vi.fn((_pubkey: string) =>
    Promise.reject(new BackupError("refused")),
  );
  const declineBackup = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(
    user,
    identity,
    linkedTo(
      owned.pubkey,
      [{ host: "design.example.com", url: "https://design.example.com" }],
      { backUp, declineBackup },
    ),
  );
  await importLinkedKey(user);
  await user.click(screen.getByRole("button", { name: "Back it up" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Builderlab refused this backup.",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  expect(screen.getByText("Your key is saved on this device.")).toBeVisible();
  // The key is on the device, so the gate must not lift into an app with no
  // community: the page offers only the fallback, never the landing.
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  // Consent stays on until the user declines.
  expect(declineBackup).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(declineBackup.mock.calls).toEqual([[owned.pubkey]]);
  expect(
    within(screen.getByRole("list", { name: "Communities you own" })).getByText(
      "design.example.com",
    ),
  ).toBeVisible();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Buzz" })).toBeNull();
  identity.dispose();
});

it("a sign-in that cannot back a key up offers neither Manage my keys for me nor a backup on the reveal page", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    if (command === "identity_export") return Promise.resolve(key);
    throw new Error(`Unexpected command ${command}`);
  });
  const backUp = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinkedWith(() => Promise.resolve(), {
        backupOffered: () => Promise.resolve(false),
        backUp,
      })}
      connect={vi.fn().mockResolvedValue(credential)}
      delay={vi.fn().mockResolvedValue(undefined)}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Manage my keys for me" }),
  ).toBeNull();
  expect(screen.queryByText(/Builderlab can keep a copy/)).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "I want to manage my own key" }),
  );
  expect(
    await screen.findByRole("heading", { name: "Your private identity key" }),
  ).toBeVisible();
  expect(await screen.findByText(key)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Please back this up for me" }),
  ).toBeNull();
  expect(backUp).not.toHaveBeenCalled();
  identity.dispose();
});

it("a linked account that cannot back its key up skips the backup offer after the import", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_import") return Promise.resolve(owned.pubkey);
    throw new Error(`Unexpected command ${command}`);
  });
  const backUp = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(
    user,
    identity,
    linkedTo(owned.pubkey, [], {
      backupOffered: () => Promise.resolve(false),
      backUp,
    }),
  );
  await user.click(
    screen.getByRole("button", { name: "Enter your private key" }),
  );
  await user.paste(ownedNsec);
  await user.click(continueWithKey());
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Back up this key?" }),
  ).toBeNull();
  expect(backUp).not.toHaveBeenCalled();
  identity.dispose();
});

it("Back it up with the real account waits on the native uploader's pass for its own handoff, past a stale failure, then hands the credential back", async () => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
  const channels: { onmessage: (status: BackupStatus) => void }[] = [];
  const at = (seq: number, pass: number, settled: object) =>
    ({ seq, pass, builderlab: true, ...settled }) as BackupStatus;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return null;
    if (command === "identity_import") return owned.pubkey;
    if (command === "nsec_backup_watch") {
      channels.push((args as { onEvent: (typeof channels)[number] }).onEvent);
      return undefined;
    }
    // The last pass, before this sign-in, could not reach Builderlab.
    if (command === "nsec_backup_state")
      return at(1, 3, { status: "failed", kind: "unreachable" });
    if (command === "nsec_backup_set_choice")
      return { available: true, pubkey: owned.pubkey, automatic: true };
    if (command === "nsec_backup_session")
      return (args as { credential: string | null }).credential ? 4 : null;
    throw new Error(`Unexpected command ${command}`);
  });
  const answer = (body: object) => ({
    status: 200,
    headers: {},
    body: JSON.stringify(body),
  });
  const request = vi.fn(async ({ url }: { url: string }) =>
    url.endsWith("/nostr-identities/current")
      ? answer({ identity: { npub: linkedNpub, pubkey_hex: owned.pubkey } })
      : answer({ communities: [] }),
  );
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(user, identity, (credential, origin, identity) =>
    builderlabAccount(credential, origin, request, identity),
  );
  await importLinkedKey(user);
  await user.click(screen.getByRole("button", { name: "Back it up" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "nsec_backup_session",
      expect.objectContaining({ credential: "private-token" }),
    ),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Backing up your key…");
  await act(async () =>
    channels[0]?.onmessage(at(2, 4, { status: "running" })),
  );
  expect(screen.getByRole("status")).toHaveTextContent("Backing up your key…");
  await act(async () =>
    channels[0]?.onmessage(at(3, 4, { status: "complete" })),
  );
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command.startsWith("nsec_backup_"))
      .map(([command, args]) =>
        args === undefined || command === "nsec_backup_watch"
          ? [command]
          : [command, args],
      ),
  ).toEqual([
    ["nsec_backup_watch"],
    ["nsec_backup_state"],
    ["nsec_backup_set_choice", { pubkey: owned.pubkey, automatic: true }],
    [
      "nsec_backup_session",
      {
        source: "builderlab",
        generation: expect.any(Number),
        credential: "private-token",
      },
    ],
    [
      "nsec_backup_session",
      {
        source: "builderlab",
        generation: expect.any(Number),
        credential: null,
      },
    ],
  ]);
  identity.dispose();
});

it("an unlink that fails before any key exists still returns to the first-launch screen from Back", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    throw new Error(`Unexpected command ${command}`);
  });
  const identity = createIdentity();
  const user = userEvent.setup();
  const { fail } = await welcomeBackPage(
    user,
    identity,
    linkedTo(owned.pubkey),
  );
  await user.click(screen.getByRole("button", { name: "I lost this key" }));
  await user.click(
    await screen.findByRole("button", { name: "Start over with a new key" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Unlinking your old key… [TODO]",
  );
  await fail(1, new Error("Builderlab unlink failed (HTTP 503)."));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Builderlab unlink failed (HTTP 503).",
  );
  expect(identity.snapshot().status).toBe("missing");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(welcomeHeading()).toBeVisible();
  expect(connectButton()).toBeEnabled();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

it("I lost this key lists the communities the old key owns, Back returns to Welcome back, and Start over unlinks it before the ordinary key choice", async () => {
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    throw new Error(`Unexpected command ${command}`);
  });
  const found = deferred<readonly OwnedCommunity[]>();
  const bind = vi.fn((_pubkey: string) => Promise.resolve());
  const identity = createIdentity();
  const user = userEvent.setup();
  const { delay, release } = await welcomeBackPage(user, identity, () => ({
    linkedKey: () => Promise.resolve(owned.pubkey),
    ownedCommunities: () => found.promise,
    bind,
    ...backupAnswers,
  }));
  await user.click(screen.getByRole("button", { name: "I lost this key" }));
  // The owned list is real and read for this page.
  expect(screen.getByRole("status")).toHaveTextContent("Finding communities…");
  await act(async () =>
    found.resolve([
      { host: "design.example.com", url: "https://design.example.com" },
      { host: "buzz.example.org", url: "https://buzz.example.org" },
    ]),
  );
  expect(
    await screen.findByRole("heading", { name: "Start over with a new key" }),
  ).toBeVisible();
  expect(
    within(screen.getByRole("list", { name: "Communities you own" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent),
  ).toEqual(["design.example.com", "buzz.example.org"]);
  expect(
    screen.getByText(/Memberships in other people’s communities/),
  ).toBeVisible();
  expect(identity.snapshot().status).toBe("missing");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "I lost this key" }));
  await user.click(
    await screen.findByRole("button", { name: "Start over with a new key" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Unlinking your old key… [TODO]",
  );
  expect(identity.snapshot().status).toBe("missing");
  await release(1);
  // Unlinked, the account takes the new user's lane from here.
  expect(
    await screen.findByRole("heading", { name: "Set up your key" }),
  ).toBeVisible();
  for (const name of [
    "Manage my keys for me",
    "I want to manage my own key",
    "I already have a key",
  ])
    expect(screen.getByRole("button", { name })).toBeEnabled();
  await manageKeysForMe(user);
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  // The new key is linked in the old one's place. Until the unlink above is
  // real, kgoose still holds the old key and would refuse this bind.
  expect(bind.mock.calls).toEqual([[viewer]]);
  // The old key's communities are not offered to the new one.
  expect(screen.queryByRole("list")).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(delay.mock.calls).toEqual([[2000], [2000]]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

it("a linked account's owned communities are offered on Join a community, and a row's Join looks that community up", async () => {
  const relay = landingRelay("https://design.example.com");
  const identity = createIdentity();
  const user = userEvent.setup();
  await welcomeBackPage(
    user,
    identity,
    linkedTo(owned.pubkey, [
      { host: "design.example.com", url: "https://design.example.com" },
    ]),
  );
  await importLinkedKey(user);
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  const rows = screen.getByRole("list", { name: "Communities you own" });
  expect(within(rows).getAllByRole("listitem")).toHaveLength(1);
  expect(within(rows).getByText("design.example.com")).toBeVisible();
  expect(urlField()).toHaveValue("");
  expect(relay.relayCalls).toEqual([]);
  // The row's Join is the typed-URL path for that host: the same lookup.
  await user.click(within(rows).getByRole("button", { name: "Join" }));
  expect(
    screen.getByRole("heading", { name: "Finding community" }),
  ).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("design.example.com");
  expect(relay.relayCalls).toEqual(relay.lookup);
  await act(async () => relay.info.resolve());
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(
    screen.getByRole("list", { name: "Communities you own" }),
  ).toBeVisible();
  expect(urlField()).toHaveValue("");
  identity.dispose();
});

it("a linked account on the tenant path is welcomed back and its imported key lands on Join Community for the landing URL", async () => {
  const relay = landingRelay("https://relay.example.com");
  relay.info.resolve();
  const account = vi.fn(linkedTo(owned.pubkey));
  const delay = vi.fn().mockResolvedValue(undefined);
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      connect={vi.fn().mockResolvedValue(credential)}
      account={account}
      tenants={tenants}
      delay={delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await screen.findByRole("button", { name: "Connect with Builderlab" });
  await user.type(urlField(), "relay.example.com{Enter}");
  expect(
    await screen.findByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  // The reads go to the tenant that signed the user in.
  expect(account).toHaveBeenCalledWith(
    credential,
    "https://tenant.example",
    identity,
  );
  await importLinkedKey(user);
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("heading", { name: "Join Community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({
    status: "ready",
    viewer: owned.pubkey,
  });
  expect(
    screen.queryByRole("heading", { name: "Join a community" }),
  ).toBeNull();
  expect(screen.queryByText("Signed in")).toBeNull();
  expect(delay.mock.calls).toEqual([[2000]]);
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "relay_http",
    "relay_http",
    "identity_import",
    "relay_http",
    "relay_http",
  ]);
  identity.dispose();
});

it("an account check that fails stops setup, and Back returns to the first-launch screen", async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  const delay = vi.fn();
  const identity = createIdentity();
  const user = userEvent.setup();
  render(
    <Welcome
      identity={identity}
      communities={noJoin}
      connect={vi.fn().mockResolvedValue(credential)}
      account={() => ({
        linkedKey: () =>
          Promise.reject(
            new Error("Builderlab account check failed (HTTP 503: not JSON)."),
          ),
        ownedCommunities: () => Promise.resolve([]),
        bind: () => Promise.resolve(),
        ...backupAnswers,
      })}
      delay={delay}
    >
      <p>Signed in</p>
    </Welcome>,
  );
  await user.click(
    await screen.findByRole("button", { name: "Connect with Builderlab" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Builderlab account check failed (HTTP 503: not JSON).",
  );
  expect(
    screen.getByRole("heading", { name: "Couldn’t finish setup" }),
  ).toBeVisible();
  // Nothing after the check ran, and no key was made.
  expect(delay).not.toHaveBeenCalled();
  expect(identity.snapshot().status).toBe("missing");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(welcomeHeading()).toBeVisible();
  expect(connectButton()).toBeEnabled();
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

it("the development seed answers the account reads in place of kgoose", async () => {
  vi.stubEnv(
    "VITE_BUZZ_FIRST_RUN_ACCOUNT",
    JSON.stringify({ npub: linkedNpub, communities: ["design.example.com"] }),
  );
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    throw new Error(`Unexpected command ${command}`);
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
  expect(
    await screen.findByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  expect(screen.getByText(linkedNpub)).toBeVisible();
  // No host request went anywhere: the seed replaced both reads.
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
  ]);
  identity.dispose();
});

it("the development seed links and backs up a created key without a request, a native signature or a native backup command", async () => {
  vi.stubEnv("VITE_BUZZ_FIRST_RUN_ACCOUNT", "unlinked");
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    throw new Error(`Unexpected command ${command}`);
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
  await manageKeysForMe(user);
  expect(
    await screen.findByRole("heading", { name: "Join a community" }),
  ).toBeVisible();
  expect(identity.snapshot()).toEqual({ status: "ready", viewer });
  // Neither kgoose (`plugin_host_request`), the binding signer nor the native
  // backup uploader (`nsec_backup_*`) was reached.
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "identity_restore",
    "identity_create",
  ]);
  identity.dispose();
});

it("a development seed's backup kind fails the backup with that kind's page, still without a native backup command", async () => {
  vi.stubEnv("VITE_BUZZ_FIRST_RUN_ACCOUNT", '{"backup":"unreachable"}');
  vi.mocked(invoke).mockImplementation((command) => {
    if (command === "identity_restore") return Promise.resolve(null);
    if (command === "identity_create") return Promise.resolve(viewer);
    throw new Error(`Unexpected command ${command}`);
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
  await manageKeysForMe(user);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t reach Builderlab to back up your key. Check your connection and try again.",
  );
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "Show my key" })).toBeEnabled();
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
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinked}
      connect={connect}
    >
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
    <Welcome
      identity={identity}
      communities={noJoin}
      account={unlinked}
      connect={vi.fn()}
    >
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
      <Welcome
        identity={identity}
        communities={noJoin}
        account={unlinked}
        connect={vi.fn()}
      >
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
