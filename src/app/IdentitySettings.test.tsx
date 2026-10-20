// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import type { Identity } from "../features/identity/service";
import { IdentitySettings } from "./IdentitySettings";
const viewer = "ab".repeat(32);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("shows exact public identity formats and copies either value", async () => {
  const writeText = vi.fn(async () => {});
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<IdentitySettings viewer={viewer} />, {
    wrapper: ToastProvider,
  });

  expect(screen.getByText(viewer, { exact: true })).toHaveTextContent(viewer);
  expect(
    screen.getByText(npubEncode(viewer), { exact: true }),
  ).toHaveTextContent(npubEncode(viewer));

  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(writeText).toHaveBeenLastCalledWith(viewer);
  expect(screen.getByText("Public key copied.")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Copy nostr address" }));
  expect(writeText).toHaveBeenLastCalledWith(npubEncode(viewer));
  expect(screen.getByText("Nostr address copied.")).toBeVisible();
});

it("keeps copy feedback bound to the latest identity action", async () => {
  let finishPublicKey: (() => void) | undefined;
  const publicKeyWrite = new Promise<void>((resolve) => {
    finishPublicKey = resolve;
  });
  const writeText = vi
    .fn()
    .mockReturnValueOnce(publicKeyWrite)
    .mockResolvedValueOnce(undefined);
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<IdentitySettings viewer={viewer} />, {
    wrapper: ToastProvider,
  });

  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  await user.click(screen.getByRole("button", { name: "Copy nostr address" }));
  expect(screen.getByText("Nostr address copied.")).toBeVisible();

  finishPublicKey?.();
  await publicKeyWrite;
  expect(screen.getByText("Nostr address copied.")).toBeVisible();
  expect(screen.queryByText("Public key copied.")).not.toBeInTheDocument();
});

it("keeps the identity selectable and explains manual recovery when copy fails", async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async () => Promise.reject(new Error("denied"))),
    },
  });
  render(<IdentitySettings viewer={viewer} />, {
    wrapper: ToastProvider,
  });

  const publicKey = screen.getByText(viewer, { exact: true });
  await user.click(screen.getByRole("button", { name: "Copy public key" }));
  expect(screen.getByText(/Select it and copy manually\./)).toBeVisible();

  // Native text selection is exercised in both browser engines.
  expect(publicKey.tagName).toBe("CODE");
  expect(publicKey).toHaveTextContent(viewer);
  expect(
    screen.queryByRole("textbox", { name: "Public key (hex)" }),
  ).toBeNull();
});

it("clears a revealed key when leaving identity settings and starts masked on return", async () => {
  const exportKey = vi.fn().mockResolvedValue("nsec-public-test-fixture");
  const identity = { exportKey } as unknown as Identity;
  const user = userEvent.setup();
  const view = render(<IdentitySettings viewer={viewer} identity={identity} />);
  expect(exportKey).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "nsec-public-test-fixture",
  );
  view.rerender(<div />);
  expect(screen.queryByLabelText("Private key (nsec)")).toBeNull();
  view.rerender(<IdentitySettings viewer={viewer} identity={identity} />);
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  expect(exportKey).toHaveBeenCalledTimes(1);
});
