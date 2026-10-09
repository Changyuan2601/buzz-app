// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../../features/relay/session";
import type { TeamPublication } from "../../features/agents/catalog-protocol";
import type { ChannelKit } from "../../features/channel-templates/capability";
import type { Team } from "../../features/channel-templates/model";
import { rememberAdded } from "../agents/CommunityCatalog";
import { ChannelTemplatesDialog } from "./ChannelTemplatesDialog";

const listed: TeamPublication = {
  kind: 30178,
  eventId: "first",
  owner: "a".repeat(64),
  d: "crew",
  createdAt: 1,
  name: "Crew",
  members: [],
};
const initial: Team = { type: "team", id: "draft", name: "", agents: [] };
afterEach(() => {
  cleanup();
  localStorage.clear();
});
function fixture() {
  let snapshot = {
    status: "ready" as const,
    agents: [],
    teams: [listed] as readonly TeamPublication[],
  };
  const listeners = new Set<() => void>();
  const session = {
    viewer: "viewer",
    scope: "scope:viewer",
    media: undefined,
    communityCatalog: {
      available: () => true,
      retain: () => () => {},
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  } as unknown as RelaySession;
  const copies: string[] = [];
  const kitSnapshot = {
    status: "ready" as const,
    entries: [] as { record: { value: Team; deleted: boolean } }[],
  };
  const updateCopies = () => {
    kitSnapshot.entries = copies.map((id) => ({
      record: {
        value: { type: "team" as const, id, name: "Copy", agents: [] },
        deleted: false,
      },
    }));
  };
  const kit = {
    available: true,
    snapshot: () => kitSnapshot,
    subscribe: () => () => {},
    ensure: vi.fn(),
  } as unknown as ChannelKit;
  let resolve!: (id: string) => void;
  let reject!: (error: Error) => void;
  const adopt = vi.fn(
    () =>
      new Promise<string>((ok, fail) => {
        resolve = ok;
        reject = fail;
      }),
  );
  const close = vi.fn();
  let active = true;
  const dialog = () => (
    <ChannelTemplatesDialog
      open
      onOpenChange={close}
      kit={kit}
      agents={[]}
      initial={initial}
      active={() => active}
      catalogSession={session}
      onAddCatalogTeam={adopt}
    />
  );
  const view = render(dialog());
  return {
    session,
    copies,
    updateCopies,
    view,
    close,
    adopt,
    dialog,
    publish: (teams: readonly TeamPublication[]) => {
      snapshot = { ...snapshot, teams };
      for (const listener of listeners) listener();
    },
    resolve: (id: string) => resolve(id),
    reject: (error: Error) => reject(error),
    deactivate: () => {
      active = false;
    },
  };
}

it("uses the latest team head, fences withdrawn entries and owner/copy admission", async () => {
  const f = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Crew" }));
  const add = () => screen.getByRole("button", { name: /^Add team$/ });
  const replacement = {
    ...listed,
    eventId: "second",
    createdAt: 2,
    description: "New details",
  };
  act(() => f.publish([replacement]));
  expect(screen.getByText("New details")).toBeVisible();
  act(() => f.publish([]));
  expect(screen.getByText(/no longer shared/)).toBeVisible();
  expect(add()).toBeDisabled();
  act(() => f.publish([replacement]));
  rememberAdded(f.session.scope, f.session.viewer ?? "", replacement, "copy");
  f.copies.push("copy");
  f.updateCopies();
  f.view.rerender(f.dialog());
  expect(
    screen.getByRole("button", { name: "Added to my teams" }),
  ).toBeDisabled();
  f.copies.pop();
  f.updateCopies();
  f.view.rerender(f.dialog());
  expect(add()).toBeEnabled();
  fireEvent.click(add());
  expect(f.adopt).toHaveBeenCalledWith(replacement);
  await act(async () => f.resolve("new-copy"));
  expect(f.close).toHaveBeenCalledWith(false);
});

it("prevents every dismissal during adoption and ignores a late result after ownership loss", async () => {
  const f = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Crew" }));
  fireEvent.click(screen.getByRole("button", { name: /^Add team$/ }));
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Close templates" }),
  ).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(f.close).not.toHaveBeenCalled();
  f.deactivate();
  await act(async () => f.resolve("late-copy"));
  expect(f.close).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
});

it("keeps the catalog editor open and reports an adoption error for retry", async () => {
  const f = fixture();
  fireEvent.click(screen.getByRole("button", { name: "Crew" }));
  fireEvent.click(screen.getByRole("button", { name: /^Add team$/ }));
  await act(async () => f.reject(Error("host unavailable")));
  expect(screen.getByRole("alert")).toHaveTextContent("host unavailable");
  expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(f.close).not.toHaveBeenCalled();
});

it("cannot add the viewer's own team", () => {
  const f = fixture();
  act(() => f.publish([{ ...listed, owner: "viewer" }]));
  fireEvent.click(screen.getByRole("button", { name: "Crew" }));
  expect(
    screen.getByRole("button", { name: "Added to my teams" }),
  ).toBeDisabled();
});
