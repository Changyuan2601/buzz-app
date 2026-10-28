// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { memo } from "react";
import { afterEach, expect, it } from "vitest";
import { useIdentityNames } from "./react";
import type { IdentityNameView } from "./service";

afterEach(cleanup);

function namesView(initial: string) {
  let name = initial;
  let revision = 0;
  const listeners = new Set<() => void>();
  const view: IdentityNameView = {
    lookup: () => undefined,
    scope: () => () => undefined,
    resolve: () => name,
    snapshot: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    view,
    rename(next: string) {
      name = next;
      revision++;
      for (const listener of listeners) listener();
    },
  };
}

// Memoized rows re-render for a name change only because the resolver changes.
const Label = memo(function Label({
  resolve,
}: {
  resolve: (pubkey: string, fallback: string) => string;
}) {
  return <span>{resolve("a".repeat(64), "fallback")}</span>;
});

function Names({ names }: { names: IdentityNameView }) {
  const resolve = useIdentityNames(names);
  return <Label resolve={resolve} />;
}

it("gives memoized labels a new resolver when names change", () => {
  const names = namesView("Ada");
  render(<Names names={names.view} />);
  expect(screen.getByText("Ada")).toBeInTheDocument();
  act(() => names.rename("Grace"));
  expect(screen.getByText("Grace")).toBeInTheDocument();
});
