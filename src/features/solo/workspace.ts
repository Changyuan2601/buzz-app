import { templateAgentChoices } from "../agents/choices";
import type { KitEntry, Lineup, Template } from "../channel-templates/model";
import {
  CANVAS_BYTES,
  parseKitRecord,
  parseLineup,
  resolveLineup,
} from "../channel-templates/model";
import { splitPartition } from "../relay/partition";
import type { RelaySession } from "../relay/session";

export type Workspace = {
  folders: string[];
  worktree?: { location: string; baseBranch: string } | undefined;
  canvas: string;
};
const prefix = "<!-- buzz-session-workspace:v1 ";
const end = "<!-- /buzz-session-workspace -->";
export const emptyWorkspace = (): Workspace => ({ folders: [], canvas: "" });

export function validateWorkspace(value: Workspace): Workspace {
  const folders = [
    ...new Set(value.folders.map((path) => path.trim()).filter(Boolean)),
  ];
  const path = (value: string) =>
    value.length <= 2048 &&
    [...value].every((char) => char.charCodeAt(0) >= 32 && char !== "`");
  if (folders.length > 20 || folders.some((folder) => !path(folder)))
    throw new Error(
      "Use up to 20 project folders, without control characters or backticks.",
    );
  const worktree = value.worktree && {
    location: value.worktree.location.trim(),
    baseBranch: value.worktree.baseBranch.trim(),
  };
  if (
    worktree &&
    (!folders.length ||
      !worktree.location ||
      !path(worktree.location) ||
      !worktree.baseBranch ||
      !path(worktree.baseBranch))
  )
    throw new Error(
      "Choose a project folder, worktree location, and base branch.",
    );
  return { folders, ...(worktree ? { worktree } : {}), canvas: value.canvas };
}

/** Workspace preferences remain ordinary Canvas instructions, as in the reference workflow. */
export function workspaceCanvas(input: Workspace): string {
  const value = validateWorkspace(input);
  if (new TextEncoder().encode(value.canvas).length > CANVAS_BYTES)
    throw new Error("Keep Canvas below 24 KiB.");
  if (!value.folders.length) return value.canvas;
  const metadata = JSON.stringify({
    folders: value.folders,
    worktree: value.worktree,
  })
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  const instructions = value.worktree
    ? [
        "## Workspace instructions",
        "",
        ...value.folders.map(
          (folder) =>
            `- Use \`${folder}\` for review only. Do not make changes directly in it.`,
        ),
        `- Before starting new work, fetch the latest \`${value.worktree.baseBranch}\` branch from origin.`,
        `- For each repository that needs changes, create a new worktree under \`${value.worktree.location}\` from \`origin/${value.worktree.baseBranch}\`.`,
        "- Make all changes in that new worktree.",
      ]
    : [
        "## Project folders",
        "",
        ...value.folders.map((folder) => `- \`${folder}\``),
      ];
  const canvas = [
    `${prefix}${metadata} -->`,
    ...instructions,
    end,
    "",
    value.canvas,
  ].join("\n");
  if (new TextEncoder().encode(canvas).length > CANVAS_BYTES)
    throw new Error("Keep Canvas and workspace instructions below 24 KiB.");
  return canvas;
}

export function readWorkspace(content: string): Workspace {
  if (!content.startsWith(prefix)) return { folders: [], canvas: content };
  const lineEnd = content.indexOf(" -->\n");
  const blockEnd = content.indexOf(`\n${end}\n\n`, lineEnd);
  if (lineEnd < 0 || blockEnd < 0)
    throw new Error(
      "Workspace metadata is incomplete. Edit the raw Canvas before changing workspace settings.",
    );
  let raw: unknown;
  try {
    raw = JSON.parse(content.slice(prefix.length, lineEnd));
  } catch {
    throw new Error(
      "Workspace metadata is invalid. Edit the raw Canvas before changing workspace settings.",
    );
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    !("folders" in raw) ||
    !Array.isArray(raw.folders) ||
    raw.folders.some((v) => typeof v !== "string")
  )
    throw new Error("Invalid workspace folders.");
  const worktree = "worktree" in raw ? raw.worktree : undefined;
  if (
    worktree !== undefined &&
    (!worktree ||
      typeof worktree !== "object" ||
      !("location" in worktree) ||
      typeof worktree.location !== "string" ||
      !("baseBranch" in worktree) ||
      typeof worktree.baseBranch !== "string")
  )
    throw new Error("Invalid worktree settings.");
  const value = validateWorkspace({
    folders: raw.folders,
    ...(worktree
      ? { worktree: worktree as { location: string; baseBranch: string } }
      : {}),
    canvas: content.slice(blockEnd + end.length + 3),
  });
  // Never silently discard manually edited instructions inside the managed block.
  if (workspaceCanvas(value) !== content)
    throw new Error(
      "Workspace instructions were edited in Canvas. Use the raw Canvas editor to preserve those changes.",
    );
  return value;
}

/** One existing encrypted template record per project. */
export async function projectTemplateId(projectId: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(projectId),
  );
  return `me-section-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
/** The defaults record new chats in a project copy; validated for publication. */
export function projectTemplate(
  scope: string,
  id: string,
  projectName: string,
  lineup: Lineup,
): Template {
  const community = splitPartition(scope)?.communityOrigin;
  if (!community)
    throw new Error("Project defaults require a connected community.");
  const template: Template = {
    ...lineup,
    type: "template",
    id,
    name: `${projectName.slice(0, 100)} chats`,
    description: "Starting workspace and Canvas for new chats in this project.",
  };
  // Validate the complete encrypted recipe budget, including the community
  // URL, before publication.
  const record = parseKitRecord(
    { version: 1, community, deleted: false, value: template },
    community,
  );
  if (record.value.type !== "template")
    throw new Error("Expected project defaults");
  // Keep the exact parsed shape used on reread, including field order.
  return record.value;
}
export function templateEntry(entries: readonly KitEntry[], id: string) {
  return entries.find(
    (entry) =>
      !entry.record.deleted &&
      entry.record.value.type === "template" &&
      entry.record.value.id === id,
  );
}
export function projectDefault(
  entries: readonly KitEntry[],
  projectId: string,
  overrideId: string,
  requireDefault = false,
) {
  const override = templateEntry(entries, overrideId);
  if (override?.record.value.type === "template") return override.record.value;
  const groups = entries.find(
    (entry) => !entry.record.deleted && entry.record.value.type === "groups",
  )?.record.value;
  const defaultId =
    groups?.type === "groups"
      ? groups.groups.find((group) => group.id === projectId)?.defaultTemplateId
      : undefined;
  const fallback = defaultId
    ? templateEntry(entries, defaultId)?.record.value
    : undefined;
  if (requireDefault && defaultId && fallback?.type !== "template")
    throw new Error(
      "This project’s default template is unavailable. Choose new project defaults before starting a chat.",
    );
  return fallback?.type === "template" ? fallback : undefined;
}
export type ChatSetup = {
  projectId?: string;
  canvas: string;
  agents: string[];
};
export function parseChatSetup(raw: unknown): ChatSetup {
  if (
    !raw ||
    typeof raw !== "object" ||
    ("projectId" in raw &&
      raw.projectId !== undefined &&
      (typeof raw.projectId !== "string" ||
        !raw.projectId ||
        raw.projectId.length > 256))
  )
    throw new Error("Invalid saved chat project.");
  const lineup = parseLineup({ ...raw, teamIds: [] });
  return {
    ...("projectId" in raw && typeof raw.projectId === "string"
      ? { projectId: raw.projectId }
      : {}),
    canvas: lineup.canvas,
    agents: lineup.agents,
  };
}
export async function loadChatSetup(
  session: RelaySession,
  projectId: string,
): Promise<ChatSetup> {
  const store = session.soloPreferences;
  await store.refresh();
  const preferences = store.snapshot();
  if (
    !store.writable ||
    !preferences.data?.sections.some((project) => project.id === projectId)
  )
    throw new Error(
      "This project is unavailable. Refresh projects before starting a chat.",
    );
  await session.channelKit.refresh();
  const kit = session.channelKit.snapshot();
  if (kit.status !== "ready")
    throw new Error(
      kit.error ??
        "Project defaults couldn’t load. Retry before starting the chat.",
    );
  const template = projectDefault(
    kit.entries,
    projectId,
    await projectTemplateId(projectId),
    true,
  );
  if (!template) return { projectId, canvas: "", agents: [] };
  if (template.agents.length || template.teamIds.length) {
    await session.agentChoices.refresh("templates");
    const choices = session.agentChoices.snapshot();
    if (
      choices.templates.status !== "ready" ||
      !choices.templates.complete ||
      choices.archives.status !== "ready"
    )
      throw new Error(
        "Available agents couldn’t load. Retry before starting the chat.",
      );
    const roster = session.channels.list();
    const candidates = resolveLineup(
      template,
      kit.entries,
      choices.templates.identities,
    );
    if (
      candidates.some(
        (agent) =>
          !choices.templates.identities.find(
            (choice) => choice.pubkey === agent.pubkey,
          )?.managed,
      ) &&
      (roster.status !== "ready" || roster.coverage === "partial")
    ) {
      session.channels.refreshList?.();
      throw new Error(
        "Community membership couldn’t load completely. Refresh and retry before starting the chat.",
      );
    }
    const agents = resolveLineup(
      template,
      kit.entries,
      templateAgentChoices(choices, roster),
    ).map((agent) => agent.pubkey);
    return { projectId, canvas: template.canvas, agents };
  }
  return { projectId, canvas: template.canvas, agents: [] };
}

export const removedProjectMessage =
  "The project was removed. Continue without a project to retry.";

export async function applyChatSetup(
  session: RelaySession,
  channelId: string,
  setup: ChatSetup,
  active: () => boolean,
) {
  if (!active()) return;
  const head = await session.canvas.read(channelId);
  if (!active()) return;
  if (head && head.content !== setup.canvas)
    throw new Error(
      "This chat already has a different Canvas. Review it before retrying setup.",
    );
  if (!head && setup.canvas)
    await session.canvas.save(channelId, setup.canvas, undefined);
  if (!active()) return;
  if (setup.projectId) {
    const store = session.soloPreferences;
    await store.refresh();
    if (!active()) return;
    const preferences = store.snapshot();
    if (preferences.status !== "ready" || !preferences.data)
      throw new Error("Projects couldn’t load. Retry before continuing setup.");
    if (
      !preferences.data.sections.some(
        (project) => project.id === setup.projectId,
      )
    )
      throw new Error(removedProjectMessage);
    if (store.snapshot().data?.assignments[channelId] !== setup.projectId)
      await store.assign(channelId, setup.projectId);
  }
  if (!active()) return;
  if (setup.agents.length)
    await session.channelWrites.addAgents(channelId, setup.agents, active);
}
