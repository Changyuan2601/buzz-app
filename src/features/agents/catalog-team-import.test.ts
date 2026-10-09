import { expect, it, vi } from "vitest";
import {
  agentCatalogContent,
  catalogTeamSnapshot,
  parsePublication,
  teamCatalogContent,
  type TeamPublication,
} from "./catalog-protocol";
import type { AgentControl } from "./control";
import { controlFixture } from "./control-testing";
import { keypair, signed } from "../relay/testing";
import { importTeamMembers } from "./team-bundles";

it("keeps an unsupported source runtime out of publication and the real team importer", async () => {
  const fixture = controlFixture();
  const unknown = {
    ...fixture.agent,
    harness: {
      ...fixture.agent.harness,
      command: "/local/codex-acp",
      model: "gpt-5-codex",
      provider: "openai",
    },
  };
  expect(() => agentCatalogContent(unknown, "channel")).toThrow(
    /runtime that cannot be shared/,
  );
  await expect(
    teamCatalogContent(
      { id: "crew", name: "Crew", agents: [unknown.pubkey] },
      [unknown],
      "channel",
    ),
  ).rejects.toThrow(/runtime that cannot be shared/);

  // A supported projection still survives signed publication, parsing and
  // native import without falling back to buzz-agent.
  const supported = {
    ...unknown,
    harness: {
      ...unknown.harness,
      command: "/local/buzz-pi-acp",
      model: "gpt-5",
      provider: "openai",
    },
  };
  const content = await teamCatalogContent(
    { id: "crew", name: "Crew", agents: [supported.pubkey] },
    [supported],
    "channel",
  );
  const listed = parsePublication(
    signed(keypair(), {
      kind: 30178,
      tags: [
        ["d", "crew"],
        ["shared", "true"],
      ],
      content,
      created_at: 1,
    }),
  ) as TeamPublication;
  expect(listed.members[0]?.runtime).toBe("pi");
  const snapshot = catalogTeamSnapshot(listed);
  expect(snapshot.members[0]?.definition.runtime).toBe("pi");
  fixture.data.harnessOptions = [
    {
      command: "/local/buzz-pi-acp",
      available: true,
      label: "Pi",
      status: "ready",
      defaultArgs: [],
      providers: [],
    },
  ];
  const create = vi.fn<NonNullable<AgentControl["create"]>>(async () => ({
    ...fixture.agent,
  }));
  const control = {
    refresh: vi.fn(async () => {}),
    snapshot: () => ({ data: fixture.data }),
    create,
  } as unknown as AgentControl;
  await importTeamMembers(
    control,
    snapshot,
    ["r0"],
    "https://relay.example",
    "ef".repeat(32),
    false,
    "team-copy",
  );
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0]?.[3].harness).toMatchObject({
    command: "/local/buzz-pi-acp",
    model: "gpt-5",
    provider: "openai",
  });
});

// A listed team's members reach the shared importer with their canonical
// runtime names, which it maps onto this device's installed harnesses.
it("adds a catalog team's Claude, Hermes and Pi members through the shared importer", async () => {
  const installed = {
    claude: "/local/claude-agent-acp",
    hermes: "/local/hermes-acp",
    pi: "/local/buzz-pi-acp",
  };
  const listed = parsePublication(
    signed(keypair(), {
      kind: 30178,
      tags: [
        ["d", "crew"],
        ["shared", "true"],
      ],
      content: JSON.stringify({
        v: 1,
        name: "Crew",
        members: Object.keys(installed).map((runtime, index) => ({
          member_key: `k${index}`,
          display_name: runtime,
          system_prompt: "Help.",
          acp_command: "buzz-acp",
          runtime,
        })),
      }),
      created_at: 1,
    }),
  ) as TeamPublication;

  const fixture = controlFixture();
  fixture.data.harnessOptions = Object.entries(installed).map(
    ([label, command]) => ({
      command,
      available: true,
      label,
      status: "ready",
      defaultArgs: [],
      providers: [],
    }),
  );
  const create = vi.fn<NonNullable<AgentControl["create"]>>(async () => ({
    ...fixture.agent,
  }));
  const control = {
    refresh: vi.fn(async () => {}),
    snapshot: () => ({ data: fixture.data }),
    create,
  } as unknown as AgentControl;

  await importTeamMembers(
    control,
    catalogTeamSnapshot(listed),
    ["r0", "r1", "r2"],
    "https://relay.example",
    "ef".repeat(32),
    false,
    "team-copy",
  );
  expect(create.mock.calls.map((call) => call[3].harness?.command)).toEqual(
    Object.values(installed),
  );
});
