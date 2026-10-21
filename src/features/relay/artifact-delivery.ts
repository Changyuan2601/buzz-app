type ArtifactDelivery = {
  capture(type: string, collection: string): Promise<readonly string[]>;
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
  // Freeze accepted IDs before starting the relay capture. Later acceptances need another capture.
  const ids = (await delivery?.capture(type, collection)) ?? [];
  return async (signal: AbortSignal) => {
    signal.throwIfAborted();
    await delivery?.complete(ids, signal);
  };
}
