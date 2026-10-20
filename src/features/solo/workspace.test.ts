import { expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import { parseKitRecord } from "../channel-templates/model";
import {
  applyChatSetup,
  loadChatSetup,
  readWorkspace,
  projectTemplateId,
  workspaceCanvas,
  workspaceDirectories,
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
  const id = await projectTemplateId("section-one");
  // Existing project defaults records are found by this exact id.
  expect(id).toMatch(/^me-section-[0-9a-f]{64}$/);
  expect(id).toBe(await projectTemplateId("section-one"));
  expect(id).not.toBe(await projectTemplateId("section-two"));
  const record = parseKitRecord(
    {
      version: 1,
      community: "https://relay.test",
      deleted: false,
      value: {
        type: "template",
        id,
        name: "Work chats",
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
it("reads folder-only Canvas saved by earlier versions without treating it as edited", () => {
  // Literal saved format: the managed block is persisted, not display copy.
  const saved = [
    '<!-- buzz-session-workspace:v1 {"folders":["/repo"]} -->',
    "## Project folders",
    "",
    "- `/repo`",
    "<!-- /buzz-session-workspace -->",
    "",
    "Instructions",
  ].join("\n");
  expect(readWorkspace(saved)).toEqual({
    folders: ["/repo"],
    canvas: "Instructions",
  });
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
    soloPreferences: {
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
    channelWrites: {
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
it("loads exact project defaults and blocks when the catalog fails", async () => {
  const f = fixture();
  f.kit.entries = [
    {
      eventId: "head",
      record: {
        value: {
          type: "template",
          id: await projectTemplateId("work"),
          canvas: "Work here",
          agents: [],
          teamIds: [],
        },
      },
    },
  ];
  expect(await loadChatSetup(f.session, "work")).toEqual({
    projectId: "work",
    canvas: "Work here",
    agents: [],
  });
  f.kit.status = "error";
  await expect(loadChatSetup(f.session, "work")).rejects.toThrow(
    "defaults couldn’t load",
  );
});
it("applies Canvas before placement and agents, and resumes without replacing an existing Canvas", async () => {
  const f = fixture();
  const setup = {
    projectId: "work",
    canvas: "Use /repo",
    agents: ["a".repeat(64)],
  };
  await applyChatSetup(f.session, "channel", setup, () => true);
  expect(f.calls).toEqual(["canvas", "placement", "agents"]);
  await applyChatSetup(f.session, "channel", setup, () => true);
  expect(f.raw.canvas.save).toHaveBeenCalledTimes(1);
  expect(f.raw.soloPreferences.assign).toHaveBeenCalledTimes(1);
  f.changeCanvas("Someone edited this");
  await expect(
    applyChatSetup(f.session, "channel", setup, () => true),
  ).rejects.toThrow("different Canvas");
});
it("stops after failed Canvas or revoked lifetime before placing or inviting", async () => {
  const f = fixture();
  f.raw.canvas.save.mockRejectedValueOnce(new Error("Relay unavailable"));
  await expect(
    applyChatSetup(
      f.session,
      "channel",
      { projectId: "work", canvas: "Context", agents: [] },
      () => true,
    ),
  ).rejects.toThrow("Relay unavailable");
  expect(f.raw.soloPreferences.assign).not.toHaveBeenCalled();
  expect(f.raw.channelWrites.addAgents).not.toHaveBeenCalled();
  await applyChatSetup(
    f.session,
    "channel",
    { projectId: "work", canvas: "Context", agents: [] },
    () => false,
  );
  expect(f.raw.canvas.read).toHaveBeenCalledTimes(1);
});

it("checks an empty frozen Canvas before placing or inviting on retry", async () => {
  const f = fixture();
  f.changeCanvas("Written on another device");
  await expect(
    applyChatSetup(
      f.session,
      "channel",
      {
        projectId: "work",
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
    await applyChatSetup(
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
  "incomplete",
  "archived",
  "removed-legacy",
  "roster-loading",
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
          id: await projectTemplateId("work"),
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
          identities: [{ pubkey, name: "Agent", managed: false }],
        },
        archives: {
          status: "ready",
          archived: state === "archived" ? [pubkey] : [],
        },
      }),
    },
    channels: {
      refreshList: refreshRoster,
      list: () => ({
        status: rosterIncomplete ? "loading" : "ready",
        coverage: undefined,
        channels:
          state === "removed-legacy" || rosterIncomplete
            ? []
            : [{ members: [pubkey] }],
      }),
    },
  });
  if (state === "eligible")
    expect(await loadChatSetup(f.session, "work")).toMatchObject({
      agents: [pubkey],
    });
  else
    await expect(loadChatSetup(f.session, "work")).rejects.toThrow(
      state === "incomplete" || rosterIncomplete
        ? "couldn’t load"
        : "unavailable",
    );
  if (state === "incomplete" || rosterIncomplete) {
    expect(f.calls).toEqual([]);
    if (rosterIncomplete) expect(refreshRoster).toHaveBeenCalledOnce();
    complete = true;
    rosterIncomplete = false;
    expect(await loadChatSetup(f.session, "work")).toMatchObject({
      agents: [pubkey],
    });
  }
});

it("does not offer deleted-project recovery when project refresh fails", async () => {
  const f = fixture();
  Object.assign(f.session.soloPreferences, {
    snapshot: () => ({ status: "error", data: undefined }),
  });
  await expect(
    applyChatSetup(
      f.session,
      "channel",
      { projectId: "work", canvas: "", agents: [] },
      () => true,
    ),
  ).rejects.toThrow("Workspaces couldn’t load");
  expect(f.calls).toEqual([]);
});

it("finds an agent's folders even in a hand-edited workspace block", () => {
  const canvas = workspaceCanvas({
    folders: ["/repo", "~/two"],
    worktree: { location: "~/trees", baseBranch: "main" },
    canvas: "Notes",
  });
  expect(workspaceDirectories(canvas)).toEqual(["/repo", "~/two", "~/trees"]);
  expect(
    workspaceDirectories(canvas.replace("for review only", "freely")),
  ).toEqual(["/repo", "~/two", "~/trees"]);
  expect(workspaceDirectories("# Plain Canvas")).toEqual([]);
  expect(workspaceDirectories("<!-- buzz-session-workspace:v1 broken")).toEqual(
    [],
  );
});
