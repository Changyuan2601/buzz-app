import { generateSecretKey, getPublicKey } from "nostr-tools";
import { test as base, expect } from "../fixture.mjs";
import { openPage } from "../navigation.mjs";

const nativeKey =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const nativeSecret = new Uint8Array(32);
nativeSecret[31] = 1;
const test = base.extend({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture dependencies.
  editorPeople: async ({}, use) => {
    await use(
      ["Aster", "Avery", "Axel", "Azure", "Local tester"].map((name) => {
        const key = generateSecretKey();
        return { name, key, pubkey: getPublicKey(key) };
      }),
    );
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture dependencies.
  editorAgents: async ({}, use) => {
    await use(
      ["Cedar helper", "Orchid helper"].map((name) => {
        const key = generateSecretKey();
        return { name, key, pubkey: getPublicKey(key) };
      }),
    );
  },
  sessionMembers: async ({ editorPeople, editorAgents }, use) => {
    await use({
      alpha: [...editorPeople, ...editorAgents]
        .map((p) => p.pubkey)
        .concat(nativeKey),
    });
  },
  legacyAgentRows: async ({ editorAgents }, use) => {
    await use([
      ...editorAgents.map(({ name, pubkey }) => ({ name, pubkey })),
      { name: "Local tester", pubkey: nativeKey },
    ]);
  },
});
test.use({
  productionBroker: true,
  readState: true,
  localAgentActivity: true,
  controlledAgentLibrary: true,
  historyCounts: { alpha: 120, beta: 1 },
  markdownMessages: true,
});

for (let i = 1; i <= Number(process.env.PERF_REPEAT ?? 1); i++)
  test(`editor-busy-agent-choose sample ${i}`, async ({
    page,
    app,
    editorPeople,
    editorAgents,
  }, testInfo) => {
    for (const person of editorPeople)
      app.serveProfile(person.key, { name: person.name });
    for (const agent of [
      ...editorAgents,
      { key: nativeSecret, name: "Local tester" },
    ])
      app.serveOwnedAgentProfile(agent.key, agent.name);
    await page.goto(app.origin);
    await openPage(page, "Messages");
    await page.locator('button[data-channel-id="alpha"]').click();
    const choices = () =>
      page.evaluate(() => window.localAgentFixture?.choices());
    await expect
      .poll(
        async () =>
          (await choices())?.identities.find((a) => a.pubkey === nativeKey)
            ?.managed,
      )
      .toBe(true);
    const native = await page.evaluate(() =>
      window.localAgentFixture.identities(),
    );
    expect(native).toHaveLength(1);
    expect(native[0]).toMatchObject({
      pubkey: nativeKey,
      name: "Local tester",
      deleted: false,
      owner: app.sign({ kind: 0, content: "", tags: [], created_at: 1 }).pubkey,
    });
    await expect.poll(async () => (await choices())?.complete).toBe(true);
    const expectedKeys = [
      ...editorAgents.map((a) => a.pubkey),
      nativeKey,
    ].sort();
    expect((await choices()).identities.map((a) => a.pubkey).sort()).toEqual(
      expectedKeys,
    );
    const conversation = page.getByRole("article", { name: "Conversation" });
    await conversation
      .getByRole("button", { name: "Manage members", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Manage members",
      exact: true,
    });
    const refresh = dialog.getByRole("button", {
      name: "Refresh member data",
      exact: true,
    });
    await expect(refresh).toBeEnabled();
    const beforeReads = app.agentLibraryGate.requests.length;
    app.agentLibraryGate.hold();
    try {
      await refresh.click();
      await expect
        .poll(() => app.agentLibraryGate.requests.length)
        .toBe(beforeReads + 1);
      await expect
        .poll(async () => ({
          pending: (await choices()).pending,
          complete: (await choices()).complete,
        }))
        .toEqual({ pending: true, complete: false });
      const partial = await choices();
      expect(partial.identities).toEqual([
        expect.objectContaining({ pubkey: nativeKey, managed: true }),
      ]);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      app.agentLibraryGate.release();
      await expect.poll(async () => (await choices()).complete).toBe(true);
      const settled = await choices();
      expect(settled.identities.map((a) => a.pubkey).sort()).toEqual(
        expectedKeys,
      );
      expect(settled.selectable.map((a) => a.pubkey).sort()).toEqual(
        expectedKeys,
      );
      expect(
        settled.identities.filter((a) => a.managed).map((a) => a.pubkey),
      ).toEqual([nativeKey]);
      const receipt = {
        native,
        partial,
        settled,
        requests: app.agentLibraryGate.requests,
        choices: await page.evaluate(() =>
          window.localAgentFixture.choiceEvents(),
        ),
      };
      await testInfo.attach("perf-sample", {
        body: JSON.stringify({ metrics: {}, work: receipt }),
        contentType: "application/json",
      });
    } finally {
      app.agentLibraryGate.release();
    }
  });
