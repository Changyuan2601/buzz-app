type ArtifactDelivery = {
  capture(type: string, collection: string): Promise<readonly string[]>;
  targets(
    ids: readonly string[],
  ): readonly { operationId: string; artifactId: string }[];
  complete(ids: readonly string[], signal: AbortSignal): Promise<void>;
};
const sessions = new WeakMap<object, ArtifactDelivery>();
export function registerArtifactDelivery(
  session: object,
  delivery: ArtifactDelivery,
) {
  sessions.set(session, delivery);
}
export async function captureArtifactDelivery(
  session: object,
  type: string,
  collection: string,
) {
  const delivery = sessions.get(session);
  const ids = (await delivery?.capture(type, collection)) ?? [];
  const targets = delivery?.targets(ids) ?? [];
  return {
    artifactIds: [...new Set(targets.map((target) => target.artifactId))],
    async complete(artifactIds: readonly string[], signal: AbortSignal) {
      signal.throwIfAborted();
      const covered = new Set(artifactIds);
      await delivery?.complete(
        targets
          .filter((target) => covered.has(target.artifactId))
          .map((target) => target.operationId),
        signal,
      );
    },
  };
}
