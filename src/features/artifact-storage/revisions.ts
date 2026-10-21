import type { ArtifactRevision, SavedArtifact } from "./types";

export type StoredArtifact = {
  record: SavedArtifact;
  ancestry: Record<string, readonly string[]>;
  heads: ArtifactRevision[];
  superseded: string[];
};
export function emptyArtifact(id: string): StoredArtifact {
  return {
    record: {
      id,
      conflicts: [],
      unresolved: false,
      availability: { state: "unknown" },
    },
    ancestry: {},
    heads: [],
    superseded: [],
  };
}
export function receiveRevision(
  stored: StoredArtifact,
  revision: ArtifactRevision,
): StoredArtifact {
  if (
    !revision.id ||
    typeof revision.content !== "string" ||
    revision.parents.some((id) => !id)
  )
    throw new Error("Invalid artifact revision");
  const ancestry = { ...stored.ancestry };
  const prior = Object.hasOwn(ancestry, revision.id)
    ? ancestry[revision.id]
    : undefined;
  if (prior && JSON.stringify(prior) !== JSON.stringify(revision.parents))
    throw new Error("Artifact revision ancestry mismatch");
  Object.defineProperty(ancestry, revision.id, {
    value: [...revision.parents],
    enumerable: true,
    configurable: true,
  });
  const parents = (id: string) =>
    Object.hasOwn(ancestry, id) ? (ancestry[id] ?? []) : [];
  const reaches = (from: string, target: string) => {
    const pending = [...parents(from)];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop();
      if (id === undefined) break;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...parents(id));
    }
    return false;
  };
  if (reaches(revision.id, revision.id))
    throw new Error("Artifact revision ancestry cycle");
  const candidates = new Map(stored.heads.map((head) => [head.id, head]));
  const existing =
    candidates.get(revision.id) ??
    (stored.record.current?.id === revision.id
      ? stored.record.current
      : undefined);
  if (existing && JSON.stringify(existing) !== JSON.stringify(revision))
    throw new Error("Artifact revision content mismatch");
  candidates.set(revision.id, revision);
  const heads = [...candidates.values()].filter(
    (candidate) =>
      ![...candidates.keys()].some(
        (id) => id !== candidate.id && reaches(id, candidate.id),
      ),
  );
  const unresolved = Object.values(ancestry).some((parents) =>
    parents.some((id) => !Object.hasOwn(ancestry, id)),
  );
  let current = stored.record.current;
  const successors = heads.filter(
    (head) =>
      !current || head.id === current.id || reaches(head.id, current.id),
  );
  if (successors.length === 1) current = successors[0];
  return {
    ancestry,
    heads,
    superseded:
      current?.id !== stored.record.current?.id && stored.record.current
        ? [...new Set([...stored.superseded, stored.record.current.id])]
        : stored.superseded,
    record: {
      ...stored.record,
      ...(current ? { current } : {}),
      unresolved,
      conflicts: heads.filter((head) => head.id !== current?.id),
    },
  };
}
