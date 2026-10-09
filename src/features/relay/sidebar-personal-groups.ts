import type { ChannelKit } from "../channel-templates/capability";
import { personalGroups } from "../channel-templates/setup";
import type { Groups } from "../channel-templates/model";
import type {
  SidebarAssignmentMutator,
  SidebarGroups,
  SidebarSectionRemover,
  SidebarPreferences,
} from "./sidebar-preferences";

export function projectPersonalGroups(groups: Groups): SidebarGroups {
  return {
    sections: groups.groups.map(({ id, name }, order) => ({ id, name, order })),
    assignments: groups.assignments,
  };
}

/** Preserve the explicit new-Buzz opt-in; never migrate or merge either store. */
export async function readActiveSidebarGroups(
  kit: ChannelKit,
  legacy: SidebarPreferences,
  signal: AbortSignal,
): Promise<SidebarPreferences> {
  const state = kit.snapshot();
  if (state.status === "unavailable") return legacy;
  if (state.status !== "ready") await kit.refresh();
  signal.throwIfAborted();
  const loaded = kit.snapshot();
  if (loaded.status !== "ready")
    throw new Error(loaded.error ?? "Personal groups are unavailable");
  const entry = personalGroups(loaded.entries);
  return entry?.record.value.type === "groups"
    ? {
        ...legacy,
        ...projectPersonalGroups(entry.record.value),
        groupSource: "personal",
      }
    : legacy;
}

/** Existing recipe delivery remains the sole writer for active personal groups. */
export function activeSidebarAssignment(
  kit: ChannelKit,
  legacy: SidebarAssignmentMutator,
): SidebarAssignmentMutator {
  return async (intent, signal, source) => {
    signal.throwIfAborted();
    if (kit.snapshot().status === "unavailable") {
      if (source) throw new Error("Personal groups are unavailable");
      return legacy(intent, signal);
    }
    await kit.refresh();
    signal.throwIfAborted();
    const state = kit.snapshot();
    if (state.status !== "ready")
      throw new Error(state.error ?? "Personal groups could not be refreshed");
    const entry = personalGroups(state.entries);
    const current =
      entry?.record.value.type === "groups" ? entry.record.value : undefined;
    if (!!current !== (source === "personal"))
      throw new Error(
        "The active group source changed; refresh your sidebar before moving this channel",
      );
    if (!current || !entry) return legacy(intent, signal);
    const target = intent.createSection?.id ?? intent.sectionId;
    let groups = current.groups;
    if (intent.createSection) {
      const name = intent.createSection.name.trim();
      const existing = groups.find(({ id }) => id === target);
      if (existing && existing.name !== name)
        throw new Error("The new section changed; refresh before retrying");
      if (!existing)
        groups = [
          ...groups,
          { id: intent.createSection.id, name, defaultTemplateId: "" },
        ];
    }
    if (target && !groups.some(({ id }) => id === target))
      throw new Error("The destination group is unavailable");
    const assignments = { ...current.assignments };
    if (target) assignments[intent.channelId] = target;
    else delete assignments[intent.channelId];
    if (
      groups === current.groups &&
      current.assignments[intent.channelId] === target
    )
      return projectPersonalGroups(current);
    const next = { ...current, groups, assignments };
    await kit.save(next, entry.eventId, false, signal);
    signal.throwIfAborted();
    const confirmed = personalGroups(kit.snapshot().entries)?.record.value;
    if (
      confirmed?.type !== "groups" ||
      confirmed.assignments[intent.channelId] !== target
    )
      throw new Error("Personal group placement could not be confirmed");
    return projectPersonalGroups(confirmed);
  };
}

export function activeSidebarSectionRemoval(
  kit: ChannelKit,
  legacy: SidebarSectionRemover,
): SidebarSectionRemover {
  return async (id, signal, source) => {
    signal.throwIfAborted();
    if (kit.snapshot().status === "unavailable") {
      if (source) throw new Error("Personal groups are unavailable");
      return legacy(id, signal);
    }
    await kit.refresh();
    signal.throwIfAborted();
    const state = kit.snapshot();
    if (state.status !== "ready")
      throw new Error(state.error ?? "Personal groups are unavailable");
    const entry = personalGroups(state.entries);
    const current =
      entry?.record.value.type === "groups" ? entry.record.value : undefined;
    if (!!current !== (source === "personal"))
      throw new Error(
        "The active group source changed; refresh before deleting this section",
      );
    if (!current || !entry) return legacy(id, signal);
    if (!current.groups.some((group) => group.id === id))
      return projectPersonalGroups(current);
    await kit.save(
      {
        ...current,
        groups: current.groups.filter((group) => group.id !== id),
        assignments: Object.fromEntries(
          Object.entries(current.assignments).filter(
            ([, section]) => section !== id,
          ),
        ),
      },
      entry.eventId,
      false,
      signal,
    );
    signal.throwIfAborted();
    const confirmed = personalGroups(kit.snapshot().entries)?.record.value;
    if (
      confirmed?.type !== "groups" ||
      confirmed.groups.some((group) => group.id === id)
    )
      throw new Error("Section deletion could not be confirmed");
    return projectPersonalGroups(confirmed);
  };
}
