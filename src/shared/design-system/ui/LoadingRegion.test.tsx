// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LoadingRegion } from "./LoadingRegion";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("keeps content mounted, announces only sustained loading, and never holds up completion", async () => {
  vi.useFakeTimers();
  const content = (pending: boolean) => (
    <LoadingRegion pending={pending} label="Loading profile…">
      <button type="button">Existing content</button>
    </LoadingRegion>
  );
  const view = render(content(true));
  const button = screen.getByRole("button");
  expect(button.parentElement).toHaveAttribute("aria-busy", "true");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(screen.queryByRole("status")).toBeNull();
  view.rerender(content(false));
  expect(screen.getByRole("button")).toBe(button);
  expect(button.parentElement).toHaveAttribute("aria-busy", "false");
  view.rerender(content(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByRole("status")).toHaveTextContent("Loading profile…");
  view.rerender(content(false));
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button")).toBe(button);
  view.rerender(
    <LoadingRegion
      pending={false}
      label="Loading profile…"
      feedback={<p role="alert">Read failed. Retry.</p>}
    >
      <button type="button">Existing content</button>
    </LoadingRegion>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Read failed. Retry.");
  expect(screen.getByRole("button")).toBe(button);
});
