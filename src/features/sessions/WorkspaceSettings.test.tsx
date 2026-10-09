// @vitest-environment jsdom
import { createChannelKit } from "../channel-templates/capability";
import { keypair, signed } from "../relay/testing";
import { matchesEvent } from "../relay/projection";
import type { RelayEvent } from "../relay/events";
import type { Outbox } from "../relay/outbox";
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { readWorkspace, sectionTemplateId, workspaceCanvas } from "./workspace";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("edits a session's workspace and Canvas with its exact loaded revision", async () => {
  const save = vi.fn(
    async (_channel: string, _content: string, _revision?: string) => ({}),
  );
  const close = vi.fn();
  const session = {
    canvas: {
      read: async () => ({
        id: "revision-one",
        content: workspaceCanvas({
          folders: ["/repo"],
          canvas: "Keep this context",
        }),
      }),
      save,
    },
  } as unknown as RelaySession;
  render(
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "session", id: "session", name: "Plan" }}
      close={close}
    />,
  );
  const folders = await screen.findByRole("textbox", {
    name: "Project folders",
  });
  expect(folders).toHaveValue("/repo");
  fireEvent.change(folders, { target: { value: "/other\n/repo" } });
  fireEvent.click(
    screen.getByRole("switch", { name: "Work in a new worktree" }),
  );
  expect(screen.queryByRole("textbox", { name: "Project folders" })).toBeNull();
  expect(
    screen.getByRole("textbox", { name: "Source repository 1" }),
  ).toHaveValue("/other");
  expect(
    screen.getByRole("textbox", { name: "Source repository 2" }),
  ).toHaveValue("/repo");
  fireEvent.change(screen.getByRole("textbox", { name: "Base branch" }), {
    target: { value: "develop" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(save).toHaveBeenCalledWith(
    "session",
    expect.stringContaining("origin/develop"),
    "revision-one",
  );
  expect(
    readWorkspace(save.mock.calls[0]?.[1] as unknown as string).canvas,
  ).toBe("Keep this context");
});

it("retains a conflicted draft and never silently reloads over it", async () => {
  const save = vi.fn(async () => {
    throw new Error("Canvas changed elsewhere");
  });
  const close = vi.fn();
  const session = {
    canvas: { read: async () => ({ id: "old", content: "Original" }), save },
  } as unknown as RelaySession;
  const view = () => (
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "session", id: "session", name: "Plan" }}
      close={close}
    />
  );
  const mounted = render(view());
  fireEvent.change(await screen.findByRole("textbox", { name: "Canvas" }), {
    target: { value: "My draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Canvas changed elsewhere",
  );
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Canvas" })).toHaveValue(
    "My draft",
  );
  mounted.unmount();
  render(view());
  expect(await screen.findByRole("textbox", { name: "Canvas" })).toHaveValue(
    "My draft",
  );
});

it("saves section defaults as an existing relay template without writing section placement", async () => {
  const save = vi.fn(async () => {});
  const close = vi.fn();
  const session = {
    channelKit: {
      refresh: async () => {},
      snapshot: () => ({ status: "ready", entries: [] }),
      save,
    },
  } as unknown as RelaySession;
  render(
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "section", id: "work", name: "Work" }}
      close={close}
    />,
  );
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Project folders" }),
    { target: { value: "~/Development/project" } },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Canvas" }), {
    target: { value: "Work carefully" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "template",
      id: await sectionTemplateId("work"),
      canvas: expect.stringContaining("Work carefully"),
    }),
    undefined,
  );
});

it("recreates deleted section defaults using the tombstone revision", async () => {
  const viewer = keypair();
  const events: RelayEvent[] = [];
  let time = 1_700_000_000;
  const send = vi.fn((value: Parameters<Outbox["send"]>[0]) => {
    const event = signed(viewer, { ...value, created_at: time++ });
    events.push(event);
    return event.id;
  });
  const kit = createChannelKit({
    viewer: viewer.pubkey,
    community: "https://relay.example.test",
    signal: new AbortController().signal,
    ready: Promise.resolve(),
    canWrite: () => true,
    delivered: async () => {},
    local: undefined,
    outbox: { send, supports: () => true } as unknown as Outbox,
    reader: {
      read: async (filters) =>
        events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
    },
    host: {
      prepare: async (record) => JSON.stringify(record),
      decode: async (rows) =>
        rows.map((event) => ({
          eventId: event.id,
          record: JSON.parse(event.content),
        })),
    },
  });
  const session = { channelKit: kit.capability } as unknown as RelaySession;
  const close = vi.fn();
  const view = () => (
    <WorkspaceSettings
      session={session}
      scope="test"
      target={{ kind: "section", id: "work", name: "Work" }}
      close={close}
    />
  );
  const first = render(view());
  fireEvent.change(await screen.findByRole("textbox", { name: "Canvas" }), {
    target: { value: "Old instructions" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  first.unmount();
  const saved = kit.capability.snapshot().entries[0];
  if (!saved) throw new Error("Expected saved section defaults");
  // TemplateLibrary deletes through the same revision-checked save operation.
  await kit.capability.save(saved.record.value, saved.eventId, true);
  expect(kit.capability.snapshot().entries[0]?.record.deleted).toBe(true);
  render(view());
  expect(await screen.findByRole("textbox", { name: "Canvas" })).toHaveValue(
    "",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Canvas" }), {
    target: { value: "New instructions" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
  const restored = kit.capability.snapshot().entries[0];
  expect(restored?.record.deleted).toBe(false);
  expect(restored?.record.value).toMatchObject({ canvas: "New instructions" });
  expect(send).toHaveBeenCalledTimes(3);
});
