import { matchPerson } from "../search/person-match";

type Person = { name: string; pubkey: string };

/** Match quality by the shared name rule, then name, then key. */
export function peopleOrder(query: string) {
  const tier = (person: Person) => matchPerson(person.name, query)?.tier ?? 4;
  return (a: Person, b: Person) =>
    tier(a) - tier(b) ||
    a.name.localeCompare(b.name) ||
    a.pubkey.localeCompare(b.pubkey);
}
