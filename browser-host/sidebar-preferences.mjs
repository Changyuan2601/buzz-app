import {
  editSidebarAssignment,
  validSidebarAssignment,
} from "../src/features/relay/sidebar-edits.ts";
import {
  editSidebarRecord,
  projectSidebarRecord,
} from "../src/features/relay/sidebar-registers.ts";
import { finalizeEvent, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import {
  projectSidebarPreferences,
  SIDEBAR_COORDINATES,
} from "../src/features/relay/sidebar-preferences.ts";

export const SIDEBAR_REQUEST_BYTES = 768 * 1024; // Four bounded encrypted coordinates.
export const SIDEBAR_HEAD_BYTES = 192 * 1024 + 4096; // One signed coordinate plus response framing.
export const SIDEBAR_UPLOAD_SLOTS = 2;
export const SIDEBAR_UPLOAD_MS = 10_000;
/** Local host decoder, deliberately not an arbitrary NIP-44 decrypt capability. */
export function decodeSidebarPreferences(events, secret) {
  if (
    !Array.isArray(events) ||
    events.length > SIDEBAR_COORDINATES.length ||
    Buffer.byteLength(JSON.stringify(events)) > SIDEBAR_REQUEST_BYTES
  )
    throw new Error("Invalid sidebar records");
  const viewer = getPublicKey(secret);
  const coordinates = new Set();
  for (const event of events) {
    const tags = event?.tags?.filter?.(
      (tag) => Array.isArray(tag) && tag[0] === "d",
    );
    const coordinate = tags?.[0]?.[1];
    if (
      event?.kind !== 30078 ||
      event.pubkey !== viewer ||
      tags?.length !== 1 ||
      !SIDEBAR_COORDINATES.includes(coordinate) ||
      coordinates.has(coordinate) ||
      typeof event.content !== "string" ||
      !verifyEvent(event)
    )
      throw new Error("Invalid sidebar record");
    coordinates.add(coordinate);
  }
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const decoded = new Map();
    for (const event of events) {
      const plaintext = nip44.v2.decrypt(event.content, key);
      if (Buffer.byteLength(plaintext) > 128 * 1024)
        throw new Error("Sidebar plaintext budget exceeded");
      decoded.set(
        event.tags.find((tag) => tag[0] === "d")[1],
        JSON.parse(plaintext),
      );
    }
    return projectSidebarPreferences(
      decoded.get("channel-sections"),
      decoded.get("channel-stars"),
      decoded.get("channel-mutes"),
      decoded.get("channel-sort"),
    );
  } finally {
    key.fill(0);
  }
}

const SECTION_COORDINATE = "channel-sections";
function validAssignmentIntent(intent) {
  return (
    intent &&
    typeof intent === "object" &&
    !Array.isArray(intent) &&
    typeof intent.channelId === "string" &&
    (intent.sectionId === undefined || typeof intent.sectionId === "string") &&
    (intent.createSection === undefined ||
      (intent.createSection &&
        typeof intent.createSection === "object" &&
        !Array.isArray(intent.createSection) &&
        typeof intent.createSection.id === "string" &&
        typeof intent.createSection.name === "string" &&
        Object.keys(intent.createSection).every((key) =>
          ["id", "name"].includes(key),
        ))) &&
    validSidebarAssignment(intent) &&
    Object.keys(intent).every((key) =>
      ["channelId", "sectionId", "createSection"].includes(key),
    )
  );
}
export function assertSidebarAssignmentIntent(intent) {
  if (!validAssignmentIntent(intent))
    throw new Error("Invalid sidebar assignment intent");
}
function parseSectionsEvent(events, secret) {
  if (
    !Array.isArray(events) ||
    events.length > 1 ||
    Buffer.byteLength(JSON.stringify(events)) > SIDEBAR_REQUEST_BYTES
  )
    throw new Error("Invalid sidebar group head");
  if (!events.length)
    return {
      blob: { version: 1, sections: [], assignments: {} },
      createdAt: 0,
    };
  const [event] = events;
  const viewer = getPublicKey(secret);
  const tags = event?.tags?.filter?.(
    (tag) => Array.isArray(tag) && tag[0] === "d",
  );
  if (
    event?.kind !== 30078 ||
    event.pubkey !== viewer ||
    tags?.length !== 1 ||
    tags[0]?.[1] !== SECTION_COORDINATE ||
    typeof event.content !== "string" ||
    !verifyEvent(event)
  )
    throw new Error("Invalid sidebar group head");
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  try {
    const plaintext = nip44.v2.decrypt(event.content, key);
    if (Buffer.byteLength(plaintext) > 128 * 1024)
      throw new Error("Sidebar plaintext budget exceeded");
    const blob = JSON.parse(plaintext);
    projectSidebarPreferences(blob, undefined);
    return {
      blob: projectSidebarRecord("channel-sections", blob),
      createdAt: event.created_at,
    };
  } finally {
    key.fill(0);
  }
}
export function assertSidebarSectionRemovalIntent(intent) {
  if (
    !intent ||
    typeof intent !== "object" ||
    Array.isArray(intent) ||
    Object.keys(intent).length !== 1 ||
    typeof intent.sectionId !== "string" ||
    !intent.sectionId.trim() ||
    intent.sectionId.length > 256
  )
    throw new Error("Invalid section removal intent");
}

/** Narrow host command: mutate one assignment against the latest encrypted head. */
function prepareSidebarGroups(
  events,
  intent,
  secret,
  now = Date.now(),
  removing = false,
) {
  if (removing) assertSidebarSectionRemovalIntent(intent);
  else assertSidebarAssignmentIntent(intent);
  const viewer = getPublicKey(secret);
  const current = parseSectionsEvent(events, secret);
  const blob = removing
    ? editSidebarRecord(
        SECTION_COORDINATE,
        current.blob,
        current.createdAt,
        current.blob.sections.some(({ id }) => id === intent.sectionId)
          ? [[["s", intent.sectionId, "live"], false]]
          : [],
        now,
      )
    : editSidebarAssignment(current.blob, current.createdAt, intent, now);
  const groups = projectSidebarPreferences(blob, undefined);
  if (Buffer.byteLength(JSON.stringify(blob)) > 128 * 1024)
    throw new Error("Sidebar plaintext budget exceeded");
  if (blob === current.blob) return { groups };
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  let content;
  try {
    content = nip44.v2.encrypt(JSON.stringify(blob), key);
  } finally {
    key.fill(0);
  }
  return {
    groups,
    event: finalizeEvent(
      {
        kind: 30078,
        content,
        created_at: Math.max(Math.floor(now / 1000), current.createdAt + 1),
        tags: [
          ["d", SECTION_COORDINATE],
          ["t", SECTION_COORDINATE],
        ],
      },
      secret,
    ),
  };
}

export function prepareSidebarAssignment(
  events,
  intent,
  secret,
  now = Date.now(),
) {
  return prepareSidebarGroups(events, intent, secret, now);
}
export async function mutateSidebarSectionRemoval(
  intent,
  secret,
  readHead,
  publish,
) {
  assertSidebarSectionRemovalIntent(intent);
  const draft = prepareSidebarGroups(
    await readHead(),
    intent,
    secret,
    Date.now(),
    true,
  );
  if (!draft.event) return draft.groups;
  await publish(draft.event);
  const confirmed = prepareSidebarGroups(
    await readHead(),
    intent,
    secret,
    Date.now(),
    true,
  );
  if (confirmed.event)
    throw new Error("Section changed on another device; refresh and try again");
  return confirmed.groups;
}

/** Publish one assignment, then re-read the coordinate before reporting saved state. */
export async function mutateSidebarAssignment(
  intent,
  secret,
  readHead,
  publish,
) {
  assertSidebarAssignmentIntent(intent);
  const draft = prepareSidebarAssignment(await readHead(), intent, secret);
  if (!draft.event) return draft.groups;
  await publish(draft.event);
  const confirmation = prepareSidebarAssignment(
    await readHead(),
    intent,
    secret,
  );
  if (confirmation.event)
    throw new Error(
      "Sidebar groups changed on another device; reload and try again",
    );
  return confirmation.groups;
}
