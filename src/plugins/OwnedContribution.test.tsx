// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { OwnedContribution } from "./OwnedContribution";
import { ContributionBoundary } from "../features/conversation/ContributionBoundary";

afterEach(cleanup);
it("revokes captured callbacks when an exact registration or its presentation retires", () => {
  const first = { id: "templates", revision: "bundled" };
  let entries = [first];
  const registry = { snapshot: () => entries };
  const captured: (() => boolean)[] = [];
  const view = (entry: typeof first) => (
    <StrictMode>
      <OwnedContribution entry={entry} registry={registry}>
        {(_entry, active) => {
          captured.push(active);
          return null;
        }}
      </OwnedContribution>
    </StrictMode>
  );
  const mounted = render(view(first));
  const original = captured.at(-1);
  assert.exists(original);
  expect(original()).toBe(true);
  // Revocation is synchronous even before React processes the removal.
  entries = [];
  expect(original()).toBe(false);
  const replacement = { ...first };
  entries = [replacement];
  act(() => mounted.rerender(view(replacement)));
  expect(original()).toBe(false);
  const current = captured.at(-1);
  assert.exists(current);
  expect(current()).toBe(true);
  mounted.unmount();
  expect(current()).toBe(false);
});

it("reports a failed contribution boundary when a reset restores its children", () => {
  const changes: boolean[] = [];
  const report = (failed: boolean) => changes.push(failed);
  let broken = true;
  function Contribution() {
    if (broken) throw new Error("broken contribution");
    return <p>Contribution restored</p>;
  }
  const view = (resetIdentity: number) => (
    <StrictMode>
      <ContributionBoundary
        resetIdentity={resetIdentity}
        onFailedChange={report}
        fallback={<p role="alert">Contribution unavailable</p>}
      >
        <Contribution />
      </ContributionBoundary>
    </StrictMode>
  );
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const mounted = render(view(0));
    expect(screen.getByRole("alert").textContent).toBe(
      "Contribution unavailable",
    );
    expect(changes).toContain(true);
    expect(changes.at(-1)).toBe(true);
    const reportsBeforeReset = [...changes];

    broken = false;
    mounted.rerender(view(1));

    expect(screen.getByText("Contribution restored").textContent).toBe(
      "Contribution restored",
    );
    expect(changes).toEqual([...reportsBeforeReset, false]);
  } finally {
    error.mockRestore();
  }
});
