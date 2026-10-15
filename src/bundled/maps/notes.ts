export type RetailerNote = { text: string; revision: number };
export class NoteConflict extends Error {}
function url(scope: string, channel: string, location: string) {
  return `/api/maps/note?${new URLSearchParams({ scope, channel, location })}`;
}
async function record(response: Response): Promise<RetailerNote> {
  if (!response.ok)
    throw new Error(
      response.status === 413
        ? "Note exceeds 64 KiB."
        : "Note could not be saved or loaded.",
    );
  const value = await response.json();
  if (
    typeof value?.text !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new Error("Invalid saved note.");
  return { text: value.text, revision: value.revision };
}
export async function loadNote(
  scope: string,
  channel: string,
  location: string,
  signal: AbortSignal,
) {
  return record(
    await fetch(url(scope, channel, location), { signal, cache: "no-store" }),
  );
}
export async function saveNote(
  scope: string,
  channel: string,
  location: string,
  value: RetailerNote,
) {
  const response = await fetch(url(scope, channel, location), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  if (response.status === 409)
    throw new NoteConflict(
      "Another window changed this note. Load its saved version before deciding to replace it.",
    );
  return record(response);
}
