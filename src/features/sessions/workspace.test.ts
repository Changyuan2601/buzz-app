import { expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { parseKitRecord } from "../channel-templates/model";
import {
  applySessionSetup,
  loadSessionSetup,
  readWorkspace,
  sectionTemplateId,
  workspaceCanvas,
} from "./workspace";

it("round trips folders, worktrees and Canvas through existing template records", async () => {
  const workspace = {
    folders: ["/workspace/one", "~/Development/two"],
    worktree: { location: "~/.buzz/worktrees", baseBranch: "develop" },
    canvas: "# Goal\nShip it\n",
  };
  const canvas = workspaceCanvas(workspace);
  expect(readWorkspace(canvas)).toEqual(workspace);
  expect(canvas).toContain("origin/develop");
  const id = await sectionTemplateId("section-one");
  expect(id).toBe(await sectionTemplateId("section-one"));
  expect(id).not.toBe(await sectionTemplateId("section-two"));
  const record = parseKitRecord(
    {
      version: 1,
      community: "https://relay.test",
      deleted: false,
      value: {
        type: "template",
        id,
        name: "Work sessions",
        description: "",
        teamIds: [],
        agents: [],
        canvas,
      },
    },
    "https://relay.test",
  );
  expect(record.value).toHaveProperty("canvas", canvas);
});
it("preserves ordinary Canvas and refuses malformed or manually changed workspace blocks", () => {
  expect(readWorkspace("# Existing\nKeep me")).toEqual({
    folders: [],
    canvas: "# Existing\nKeep me",
  });
  expect(() => readWorkspace("<!-- buzz-session-workspace:v1 broken")).toThrow(
    "incomplete",
  );
  const canvas = workspaceCanvas({
    folders: ["/repo"],
    canvas: "Instructions",
  });
  expect(() =>
    readWorkspace(canvas.replace("- `/repo`", "- `/other`")),
  ).toThrow("edited");
  expect(() =>
    workspaceCanvas({ folders: ["/repo`\nunsafe"], canvas: "" }),
  ).toThrow("folders");
  expect(() =>
    workspaceCanvas({ folders: [], canvas: "x".repeat(24577) }),
  ).toThrow("24 KiB");
});

function fixture() {
  let canvas: { id: string; content: string } | undefined;
  let assignments: Record<string, string> = {};
  const calls: string[] = [];
  const kit = { status: "ready", entries: [] as unknown[] };
  const session = {
    canvas: {
      read: vi.fn(async () => canvas),
      save: vi.fn(async (_id: string, content: string) => {
        calls.push("canvas");
        canvas = { id: "revision", content };
        return canvas;
      }),
    },
    sidebarPreferences: {
      writable: true,
      refresh: vi.fn(async () => {}),
      snapshot: () => ({
        status: "ready",
        data: { sections: [{ id: "work", name: "Work" }], assignments },
      }),
      assign: vi.fn(async (id: string, group: string) => {
        calls.push("placement");
        assignments = { ...assignments, [id]: group };
      }),
    },
    channelKit: { refresh: vi.fn(async () => {}), snapshot: () => kit },
    workSessions: {
      addAgents: vi.fn(async () => {
        calls.push("agents");
      }),
    },
  };
  return {
    session: session as unknown as RelaySession,
    raw: session,
    kit,
    calls,
    changeCanvas: (content: string) => {
      canvas = { id: "changed", content };
    },
  };
}
it("loads exact section defaults and blocks when the catalog fails", async () => {
  const f = fixture();
  f.kit.entries = [
    {
      eventId: "head",
      record: {
        value: {
          type: "template",
          id: await sectionTemplateId("work"),
          canvas: "Work here",
          agents: [],
          teamIds: [],
        },
      },
    },
  ];
  expect(await loadSessionSetup(f.session, "work")).toEqual({
    sectionId: "work",
    canvas: "Work here",
    agents: [],
  });
  f.kit.status = "error";
  await expect(loadSessionSetup(f.session, "work")).rejects.toThrow(
    "defaults couldn’t load",
  );
});
it("applies Canvas before placement and agents, and resumes without replacing an existing Canvas", async () => {
  const f = fixture();
  const setup = {
    sectionId: "work",
    canvas: "Use /repo",
    agents: ["a".repeat(64)],
  };
  await applySessionSetup(f.session, "channel", setup, () => true);
  expect(f.calls).toEqual(["canvas", "placement", "agents"]);
  await applySessionSetup(f.session, "channel", setup, () => true);
  expect(f.raw.canvas.save).toHaveBeenCalledTimes(1);
  expect(f.raw.sidebarPreferences.assign).toHaveBeenCalledTimes(1);
  f.changeCanvas("Someone edited this");
  await expect(
    applySessionSetup(f.session, "channel", setup, () => true),
  ).rejects.toThrow("different Canvas");
});
it("stops after failed Canvas or revoked lifetime before placing or inviting", async () => {
  const f = fixture();
  f.raw.canvas.save.mockRejectedValueOnce(new Error("Relay unavailable"));
  await expect(
    applySessionSetup(
      f.session,
      "channel",
      { sectionId: "work", canvas: "Context", agents: [] },
      () => true,
    ),
  ).rejects.toThrow("Relay unavailable");
  expect(f.raw.sidebarPreferences.assign).not.toHaveBeenCalled();
  expect(f.raw.workSessions.addAgents).not.toHaveBeenCalled();
  await applySessionSetup(
    f.session,
    "channel",
    { sectionId: "work", canvas: "Context", agents: [] },
    () => false,
  );
  expect(f.raw.canvas.read).toHaveBeenCalledTimes(1);
});

it("checks an empty frozen Canvas before placing or inviting on retry", async () => {
  const f = fixture();
  f.changeCanvas("Written on another device");
  await expect(
    applySessionSetup(
      f.session,
      "channel",
      {
        sectionId: "work",
        canvas: "",
        agents: ["a".repeat(64)],
      },
      () => true,
    ),
  ).rejects.toThrow("different Canvas");
  expect(f.calls).toEqual([]);
});

it("accepts matching empty Canvas without publishing a new revision", async () => {
  const f = fixture();
  for (const existing of [false, true]) {
    if (existing) f.changeCanvas("");
    await applySessionSetup(
      f.session,
      "channel",
      { canvas: "", agents: [] },
      () => true,
    );
  }
  expect(f.raw.canvas.read).toHaveBeenCalledTimes(2);
  expect(f.raw.canvas.save).not.toHaveBeenCalled();
});

it.each([
  "archive-error",
  "incomplete",
  "archived",
  "removed-legacy",
  "roster-loading",
  "roster-partial",
  "managed-partial",
  "eligible",
])("checks inherited agent eligibility: %s", async (state) => {
  const f = fixture();
  const pubkey = "a".repeat(64);
  let complete = state !== "incomplete";
  let rosterIncomplete = state.startsWith("roster-");
  const refreshRoster = vi.fn();
  f.kit.entries = [
    {
      record: {
        value: {
          type: "template",
          id: await sectionTemplateId("work"),
          canvas: "",
          agents: [pubkey],
          teamIds: [],
        },
      },
    },
  ];
  Object.assign(f.session, {
    agentChoices: {
      refresh: vi.fn(async () => {}),
      snapshot: () => ({
        templates: {
          status: "ready",
          complete,
          identities: [
            { pubkey, name: "Agent", managed: state === "managed-partial" },
          ],
        },
        archives: {
          status: state === "archive-error" ? "error" : "ready",
          archived: state === "archived" ? [pubkey] : [],
        },
      }),
    },
    channels: {
      refreshList: refreshRoster,
      list: () => ({
        status:
          rosterIncomplete && state === "roster-loading" ? "loading" : "ready",
        coverage:
          (rosterIncomplete && state === "roster-partial") ||
          state === "managed-partial"
            ? "partial"
            : undefined,
        channels:
          state === "removed-legacy" ||
          rosterIncomplete ||
          state === "managed-partial"
            ? []
            : [{ members: [pubkey] }],
      }),
    },
  });
  if (state === "eligible" || state === "managed-partial")
    expect(await loadSessionSetup(f.session, "work")).toMatchObject({
      agents: [pubkey],
    });
  else
    await expect(loadSessionSetup(f.session, "work")).rejects.toThrow(
      state === "archive-error" || state === "incomplete" || rosterIncomplete
        ? "couldn’t load"
        : "unavailable",
    );
  if (state === "incomplete" || rosterIncomplete) {
    expect(f.calls).toEqual([]);
    if (rosterIncomplete) expect(refreshRoster).toHaveBeenCalledOnce();
    complete = true;
    rosterIncomplete = false;
    expect(await loadSessionSetup(f.session, "work")).toMatchObject({
      agents: [pubkey],
    });
  }
});

it("does not offer deleted-section recovery when section refresh fails", async () => {
  const f = fixture();
  Object.assign(f.session.sidebarPreferences, {
    snapshot: () => ({ status: "error", data: undefined }),
  });
  await expect(
    applySessionSetup(
      f.session,
      "channel",
      { sectionId: "work", canvas: "", agents: [] },
      () => true,
    ),
  ).rejects.toThrow("Sections couldn’t load");
  expect(f.calls).toEqual([]);
});
