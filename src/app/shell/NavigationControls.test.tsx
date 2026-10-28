// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type {
  Navigation,
  NavigationSnapshot,
} from "../../features/navigation/controller";
import { NavigationControls } from "./NavigationControls";

afterEach(cleanup);

it("follows history availability from navigation snapshots", () => {
  let snapshot = {
    canGoBack: false,
    canGoForward: false,
  } as NavigationSnapshot;
  const listeners = new Set<() => void>();
  const publish = (next: Partial<NavigationSnapshot>) => {
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  };
  const navigation = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    back() {},
    forward() {},
  } as unknown as Navigation;
  render(<NavigationControls navigation={navigation} />);
  const back = screen.getByRole("button", { name: "Go back" });
  const forward = screen.getByRole("button", { name: "Go forward" });
  expect(back).toBeDisabled();
  expect(forward).toBeDisabled();
  act(() => publish({ canGoBack: true }));
  expect(back).toBeEnabled();
  expect(forward).toBeDisabled();
  act(() => publish({ canGoBack: false, canGoForward: true }));
  expect(back).toBeDisabled();
  expect(forward).toBeEnabled();
});
