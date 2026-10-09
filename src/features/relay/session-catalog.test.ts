import { afterEach, expect, it, vi } from "vitest";
import { catalogRelay, memoryStorage } from "../agents/catalog-testing";
import { createRelaySession } from "./session";
import { flush, keypair } from "./testing";

const viewer = keypair(),
  relay = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});

it("reconciles a restored catalog share through the session's verified read", async () => {
  const server = catalogRelay();
  const storage = memoryStorage();
  const reader = server.reader(viewer);
  const transport = {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query: (filters: Parameters<typeof reader.read>[0]) => reader.read(filters),
    writer: { kinds: [30175, 30178], ...server.writer(viewer) },
  };
  const first = createRelaySession(transport, { outboxStorage: storage });
  owners.push(first);
  const catalog = first.session.communityCatalog;
  await first.session.outbox?.ready();
  await catalog.refresh();
  const id = await catalog.publish(
    30175,
    "helper",
    true,
    JSON.stringify({ display_name: "Helper", system_prompt: "Help." }),
  );
  await vi.waitFor(() =>
    expect(catalog.state(30175, "helper").change?.delivery).toBe("accepted"),
  );
  await flush();
  first.dispose();

  const second = createRelaySession(transport, { outboxStorage: storage });
  owners.push(second);
  const restored = second.session.communityCatalog;
  await second.session.outbox?.ready();
  // A restored receipt is not proof of the head until a fresh read.
  expect(restored.state(30175, "helper")).toMatchObject({
    shared: false,
    change: { operation: id, delivery: "queued" },
  });
  await restored.refresh();
  expect(restored.state(30175, "helper")).toMatchObject({
    shared: true,
    change: { operation: id, delivery: "accepted" },
  });
});
