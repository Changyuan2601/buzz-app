import { nip19 } from "nostr-tools";
import type { RelaySession } from "../relay/session";
import { foldProfiles } from "../relay/profiles";
import { matchPerson } from "../search/person-match";

export const MEMBER_SEARCH_PAGE_SIZE = 30;

/** One bounded server-ranked page; never substitute a scan of cached profiles. */
export async function searchMembers(
  session: RelaySession,
  query: string,
  page: number,
  signal: AbortSignal,
) {
  const text = query.trim();
  if (!text || text.length > 256 || !Number.isSafeInteger(page) || page < 1)
    throw new Error("Enter a name or public key to search.");
  let exact = /^[0-9a-f]{64}$/i.test(text) ? text.toLowerCase() : undefined;
  if (text.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(text);
      if (decoded.type === "npub") exact = decoded.data;
    } catch {
      // An incomplete public key remains an ordinary query while typing.
    }
  }
  const events = await session.read(
    [
      {
        kinds: [0],
        ...(exact
          ? { authors: [exact] }
          : { search: text, search_mode: "prefix" as const, page }),
        limit: MEMBER_SEARCH_PAGE_SIZE,
      },
    ],
    { signal },
  );
  signal.throwIfAborted();
  const profiles = foldProfiles(
    events.filter(
      (event) => event.kind === 0 && (!exact || event.pubkey === exact),
    ),
  );
  // The relay matches words; rank its page by the shared name rule.
  const score = (name: string) => matchPerson(name, text)?.tier ?? 4;
  return {
    people: [...profiles]
      .map(([pubkey, profile]) => ({ pubkey, ...profile }))
      .sort(
        (a, b) =>
          score(a.name) - score(b.name) ||
          a.name.localeCompare(b.name) ||
          a.pubkey.localeCompare(b.pubkey),
      ),
    more: !exact && events.length >= MEMBER_SEARCH_PAGE_SIZE,
  };
}
export type MemberSearchResult = Awaited<ReturnType<typeof searchMembers>>;
