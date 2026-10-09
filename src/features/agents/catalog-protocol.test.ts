import { describe, expect, it } from "vitest";
import type { RelayEvent } from "../relay/events.ts";
import {
  agentCatalogContent,
  catalogHeads,
  catalogTeamSnapshot,
  catalogTemplate,
  memberKey,
  parsePublication,
  teamCatalogContent,
  visibleText,
} from "./catalog-protocol.ts";
import { controlFixture } from "./control-testing.ts";
import type { AgentView } from "./control.ts";

const owner = "cd".repeat(32);
function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    ...controlFixture().agent,
    harness: { ...controlFixture().agent.harness, command: "buzz-agent" },
    sessionPolicy: "channel",
    ...overrides,
  };
}
let serial = 0;
function event(
  kind: number,
  tags: string[][],
  content: string,
  created_at = 100,
  id = (serial++).toString(16).padStart(64, "0"),
) {
  return {
    id,
    pubkey: owner,
    kind,
    tags,
    content,
    created_at,
    sig: "",
  } as unknown as RelayEvent;
}

describe("agent projection", () => {
  it("emits only portable public fields in wire order", () => {
    const content = agentCatalogContent(
      agent({
        respondTo: "allowlist",
        picture: "data:image/png;base64,AA",
        sessionPolicy: "channel",
      }),
    );
    expect(content).toBe(
      JSON.stringify({
        display_name: "Fixture agent",
        system_prompt: "Help with the project.",
        acp_command: "buzz-acp",
        runtime: "buzz-agent",
        model: "fixture-model",
        provider: "fixture-provider",
        respond_to: "owner-only",
        session_policy: "channel",
      }),
    );
    for (const secret of [
      "EXAMPLE_TOKEN",
      "/fixture",
      "--literal",
      "workspace",
    ])
      expect(content).not.toContain(secret);
  });

  it("shares the conversation context an inheriting agent runs with", () => {
    const policy = (defaults?: "channel" | "thread") =>
      JSON.parse(agentCatalogContent(agent({ sessionPolicy: null }), defaults))
        .session_policy;
    expect(policy("channel")).toBe("channel");
    expect(policy("thread")).toBe("thread");
    expect(() => policy()).toThrow(/Agent defaults .* are unavailable/);
  });

  it("shares an explicit conversation context over the agent defaults", () => {
    const policy = (
      own: "channel" | "thread",
      defaults: "channel" | "thread",
    ) =>
      JSON.parse(agentCatalogContent(agent({ sessionPolicy: own }), defaults))
        .session_policy;
    expect(policy("channel", "thread")).toBe("channel");
    expect(policy("thread", "channel")).toBe("thread");
  });

  it("projects the known Windows Buzz Agent executable but still rejects Codex", () => {
    const windows = agent({
      harness: { ...agent().harness, command: "C:\\Tools\\buzz-agent.exe" },
    });
    expect(JSON.parse(agentCatalogContent(windows)).runtime).toBe("buzz-agent");
    expect(() =>
      agentCatalogContent(
        agent({
          harness: { ...windows.harness, command: "C:\\Tools\\codex-acp.exe" },
        }),
      ),
    ).toThrow(/runtime that cannot be shared/);
  });

  it("omits a machine-local transport that has no portable alias", () => {
    const body = JSON.parse(
      agentCatalogContent(agent({ acpCommand: "/opt/custom-acp" })),
    );
    expect(body).not.toHaveProperty("acp_command");
  });

  it("refuses concealed characters before anything is signed", () => {
    expect(() =>
      agentCatalogContent(agent({ systemPrompt: "safe\u202Eevil" })),
    ).toThrow("prohibited invisible or formatting characters");
    expect(visibleText("line\n\ttab 👩‍💻", true)).toBe(true);
    expect(visibleText("a\u200Bb", true)).toBe(false);
  });
});

describe("team projection", () => {
  const member = agent({ pubkey: owner, sessionPolicy: "thread" });
  it("embeds opaque member keys and omits the default session policy", async () => {
    const body = JSON.parse(
      await teamCatalogContent({ id: "t1", name: "Crew", agents: [owner] }, [
        member,
      ]),
    );
    expect(body.v).toBe(1);
    expect(body.members[0].member_key).toBe(await memberKey(owner));
    expect(body.members[0].member_key).not.toContain(owner);
    expect(body.members[0].session_policy).toBe("thread");
    const plain = JSON.parse(
      await teamCatalogContent({ id: "t1", name: "Crew", agents: [owner] }, [
        { ...member, sessionPolicy: "channel" },
      ]),
    );
    expect(plain.members[0]).not.toHaveProperty("session_policy");
  });

  it("projects an inheriting member with the agent defaults", async () => {
    const policy = async (defaults?: "channel" | "thread") =>
      JSON.parse(
        await teamCatalogContent(
          { id: "t1", name: "Crew", agents: [owner] },
          [{ ...member, sessionPolicy: null }],
          defaults,
        ),
      ).members[0].session_policy;
    expect(await policy("channel")).toBeUndefined();
    expect(await policy("thread")).toBe("thread");
    await expect(policy()).rejects.toThrow(/Agent defaults .* are unavailable/);
  });

  it("projects an explicit member context over the agent defaults", async () => {
    const policy = async (
      own: "channel" | "thread",
      defaults: "channel" | "thread",
    ) =>
      JSON.parse(
        await teamCatalogContent(
          { id: "t1", name: "Crew", agents: [owner] },
          [{ ...member, sessionPolicy: own }],
          defaults,
        ),
      ).members[0].session_policy;
    expect(await policy("channel", "thread")).toBeUndefined();
    expect(await policy("thread", "channel")).toBe("thread");
  });

  it("carries saved team text and refuses text the parser would reject", async () => {
    const team = { id: "t1", name: "Crew", agents: [owner] };
    const body = JSON.parse(
      await teamCatalogContent(
        { ...team, description: "Ships.", instructions: "Be brief." },
        [member],
      ),
    );
    expect(body).toMatchObject({
      description: "Ships.",
      instructions: "Be brief.",
    });
    const plain = JSON.parse(
      await teamCatalogContent(
        { ...team, description: null, instructions: " " },
        [member],
      ),
    );
    expect(plain).not.toHaveProperty("description");
    expect(plain).not.toHaveProperty("instructions");
    await expect(
      teamCatalogContent({ ...team, description: "a\u202eb" }, [member]),
    ).rejects.toThrow("the team description contains prohibited");
    await expect(
      teamCatalogContent({ ...team, instructions: "x".repeat(16 * 1024 + 1) }, [
        member,
      ]),
    ).rejects.toThrow("team too large to share: the team instructions");
  });

  it("refuses to publish a member with an unmapped harness instead of dropping its runtime", async () => {
    const unknown = agent({
      harness: {
        ...member.harness,
        command: "/local/codex-acp",
        model: "gpt-5-codex",
        provider: "openai",
      },
    });
    expect(() => agentCatalogContent(unknown)).toThrow(
      /runtime that cannot be shared/,
    );
    await expect(
      teamCatalogContent({ id: "t1", name: "Crew", agents: [owner] }, [
        { ...unknown, pubkey: owner },
      ]),
    ).rejects.toThrow(/runtime that cannot be shared/);
  });

  it("fails rather than publishing a partial team", async () => {
    await expect(
      teamCatalogContent(
        { id: "t1", name: "Crew", agents: ["ef".repeat(32)] },
        [member],
      ),
    ).rejects.toThrow("not found");
    await expect(
      teamCatalogContent(
        { id: "t1", name: "Crew", agents: Array(65).fill(owner) },
        [member],
      ),
    ).rejects.toThrow("65 members");
  });
});

describe("catalog reads", () => {
  const body = agentCatalogContent(agent());
  const shared = (created: number) =>
    event(
      30175,
      [
        ["d", owner],
        ["shared", "true"],
      ],
      body,
      created,
    );

  it("lets a newer unshared head retract older shared versions", () => {
    const unshared = event(30175, [["d", owner]], body, 200);
    const [head] = catalogHeads([shared(100), unshared]).values();
    expect(head).toBe(unshared);
    expect(head && parsePublication(head)).toBeUndefined();
  });

  it("breaks timestamp ties by the lowest id", () => {
    const low = event(30175, [["d", owner]], body, 100, "0".repeat(64));
    const high = event(
      30175,
      [
        ["d", owner],
        ["shared", "true"],
      ],
      body,
      100,
      "f".repeat(64),
    );
    expect([...catalogHeads([high, low]).values()]).toEqual([low]);
  });

  it("rejects malformed visibility and nonportable transports", () => {
    expect(
      parsePublication(
        event(
          30175,
          [
            ["d", owner],
            ["shared", "true", "x"],
          ],
          body,
        ),
      ),
    ).toBeUndefined();
    const custom = JSON.stringify({
      display_name: "X",
      acp_command: "/bin/sh",
    });
    expect(
      parsePublication(
        event(
          30175,
          [
            ["d", owner],
            ["shared", "true"],
          ],
          custom,
        ),
      ),
    ).toBeUndefined();
  });

  it("round-trips agents and teams into display-only records", async () => {
    expect(parsePublication(shared(100))).toMatchObject({
      kind: 30175,
      owner,
      agent: {
        displayName: "Fixture agent",
        acpCommand: "buzz-acp",
        respondTo: "owner-only",
      },
    });
    const team = await teamCatalogContent(
      { id: "t1", name: "Crew", agents: [owner] },
      [agent({ pubkey: owner, sessionPolicy: "channel" })],
    );
    const parsed = parsePublication(
      event(
        30178,
        [
          ["d", "t1"],
          ["shared", "true"],
        ],
        team,
      ),
    );
    expect(parsed).toMatchObject({
      kind: 30178,
      name: "Crew",
      members: [
        { memberKey: await memberKey(owner), sessionPolicy: "channel" },
      ],
    });
  });
});

describe("catalog writes", () => {
  it("builds the owner-to-self envelope", () => {
    expect(catalogTemplate(30178, "t1", "{}", true).tags).toEqual([
      ["d", "t1"],
      ["shared", "true"],
    ]);
    expect(catalogTemplate(30178, "t1", "{}", false).tags).toEqual([
      ["d", "t1"],
    ]);
  });
});

describe("catalog team adoption", () => {
  it("adapts a shared team to a memory-free v1 snapshot", () => {
    const content = JSON.stringify({
      v: 1,
      name: "Crew",
      description: "Ships things.",
      instructions: "Work together.",
      members: [
        {
          member_key: "k1",
          display_name: "Mate",
          system_prompt: "Help.",
          description: "First mate.",
          model: "m1",
          respond_to: "anyone",
          session_policy: "thread",
          avatar_url: "https://example.test/a.png",
          memories: [{ slug: "core", body: "secret" }],
          env_vars: { TOKEN: "x" },
        },
      ],
    });
    const parsed = parsePublication(
      event(
        30178,
        [
          ["d", "crew"],
          ["shared", "true"],
        ],
        content,
      ),
    );
    if (parsed?.kind !== 30178) throw new Error("team did not parse");
    expect(catalogTeamSnapshot(parsed)).toEqual({
      format: "buzz-team-snapshot",
      version: 1,
      team: {
        name: "Crew",
        description: "Ships things.",
        instructions: "Work together.",
      },
      members: [
        {
          format: "buzz-agent-snapshot",
          version: 1,
          definition: {
            name: "Mate",
            systemPrompt: "Help.",
            model: "m1",
            sessionPolicy: "thread",
            respondTo: "anyone",
          },
          profile: {
            displayName: "Mate",
            about: "First mate.",
            avatarUrl: "https://example.test/a.png",
          },
          memory: { level: "none", entries: [] },
        },
      ],
    });
  });
});
