// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CreateModelChoices } from "../../features/agents/CreateModelChoices";
import { AgentInstructions } from "../../features/agents/AgentInstructions";
import { agentAvatars, avatarPacks } from "../../features/agents/avatar-packs";
import type {
  Agent,
  Agents,
  NewAgent,
  RegisteredAgentType,
} from "../../features/agents/service";
import { AgentCreateDialog } from "./AgentCreateDialog";

afterEach(cleanup);

type Echo = { reply: string };
type Notes = { notes: string; instructions: string };

const echo = {
  key: "test/echo",
  pluginId: "test",
  revision: "1",
  id: "echo",
  title: "Echo",
  description: "Says its line.",
  defaults: () => ({ config: { reply: "" } }),
  Create: ({
    config,
    disabled,
    onChange,
  }: {
    config: Echo;
    disabled: boolean;
    onChange(config: Echo): void;
  }) => (
    <input
      aria-label="Reply"
      disabled={disabled}
      value={config.reply}
      onChange={(event) => onChange({ reply: event.target.value })}
    />
  ),
} as unknown as RegisteredAgentType;

const notes = {
  key: "test/notes",
  pluginId: "test",
  revision: "1",
  id: "notes",
  title: "Notes",
  description: "Takes notes.",
  defaults: () => ({ config: { notes: "start", instructions: "Be brief." } }),
  Create: ({
    config,
    disabled,
    onChange,
  }: {
    config: Notes;
    disabled: boolean;
    onChange(config: Notes): void;
  }) => (
    <>
      <input
        aria-label="Notes"
        disabled={disabled}
        value={config.notes}
        onChange={(event) => onChange({ ...config, notes: event.target.value })}
      />
      <AgentInstructions
        value={config.instructions}
        disabled={disabled}
        onChange={(instructions) => onChange({ ...config, instructions })}
      />
    </>
  ),
} as unknown as RegisteredAgentType;

const made = {
  pubkey: "3".repeat(64),
  name: "Nova",
  type: "test/echo",
  owner: "f".repeat(64),
  relay: "wss://relay.example",
  place: "here",
  config: {},
  skipped: {},
  timers: {},
  attention: {},
} as unknown as Agent;

function setup(
  types: readonly RegisteredAgentType[],
  create: (input: NewAgent) => Promise<Agent> = async () => made,
) {
  const agents = { create: vi.fn(create) } as unknown as Agents & {
    create: ReturnType<typeof vi.fn>;
  };
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <AgentCreateDialog
      agents={agents}
      types={types}
      onCreated={onCreated}
      onClose={onClose}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Create agent" });
  return { agents, onCreated, onClose, dialog, user: userEvent.setup() };
}

const createButton = () => screen.getByRole("button", { name: "Create agent" });

it("creates with the name, a pack picture and the config from the type's view", async () => {
  const { agents, onCreated, dialog, user } = setup([echo]);
  await user.type(within(dialog).getByLabelText("Reply"), "Hi there");
  await user.type(within(dialog).getByLabelText("Name"), "  Nova ");

  const pack = avatarPacks[0];
  const avatar = agentAvatars.find((item) => item.collectionId === pack?.id);
  if (!pack || !avatar) throw new Error("The catalog has a pack");
  await user.click(
    within(dialog).getByRole("button", { name: "Choose avatar" }),
  );
  await user.click(
    await within(dialog).findByRole("button", {
      name: new RegExp(pack.label),
    }),
  );
  await user.click(
    await within(dialog).findByRole("button", { name: avatar.label }),
  );
  expect(await within(dialog).findByLabelText("Name")).toHaveValue("  Nova ");

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledExactlyOnceWith({
    type: "test/echo",
    name: "Nova",
    picture: avatar.url,
    config: { reply: "Hi there" },
  });
  expect(avatar.url).toMatch(/^https:\/\//);
  expect(onCreated).toHaveBeenCalledExactlyOnceWith(made);
});

it("opens on the name field", async () => {
  const { dialog } = setup([echo]);
  await waitFor(() =>
    expect(within(dialog).getByLabelText("Name")).toHaveFocus(),
  );
});

it("starts with a pack picture already chosen", async () => {
  const { agents, dialog, user } = setup([echo]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  const [input] = agents.create.mock.calls[0] as [NewAgent];
  expect(input.picture).toMatch(/^https:\/\//);
  expect(agentAvatars.map((avatar) => avatar.url)).toContain(input.picture);
});

it("shows the sole harness as a disabled choice", () => {
  setup([echo]);
  expect(screen.getByRole("combobox", { name: "Harness" })).toBeDisabled();
});

it("disables Create agent with an empty name and says why", async () => {
  const { agents, dialog, user } = setup([echo]);
  const hint = () => within(dialog).queryByText("Name your agent to continue");
  expect(createButton()).toBeDisabled();
  expect(hint()).toBeVisible();
  await user.type(within(dialog).getByLabelText("Name"), "   ");
  expect(createButton()).toBeDisabled();
  expect(hint()).toBeVisible();
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  expect(createButton()).toBeEnabled();
  expect(hint()).not.toBeInTheDocument();
  await user.clear(within(dialog).getByLabelText("Name"));
  expect(createButton()).toBeDisabled();
  expect(hint()).toBeVisible();
  await user.type(within(dialog).getByLabelText("Reply"), "x{Enter}");
  expect(agents.create).not.toHaveBeenCalled();
});

it("switches type from the corner menu, resetting the config to the new type's defaults", async () => {
  const { agents, dialog, user } = setup([echo, notes]);
  await user.type(within(dialog).getByLabelText("Reply"), "typed in echo");
  await user.type(within(dialog).getByLabelText("Name"), "Nova");

  await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Notes" }));

  expect(
    within(dialog).getByRole("combobox", { name: "Harness" }),
  ).toBeInTheDocument();
  expect(within(dialog).queryByLabelText("Reply")).not.toBeInTheDocument();
  expect(within(dialog).getByLabelText("Notes")).toHaveValue("start");
  // The name stays; only the type's own settings start over.
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Nova");

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledExactlyOnceWith({
    type: "test/notes",
    name: "Nova",
    picture: expect.stringMatching(/^https:\/\//),
    config: { notes: "start", instructions: "Be brief." },
  });
});

it("starts over again when switching back to the first type", async () => {
  const { agents, dialog, user } = setup([echo, notes]);
  await user.type(within(dialog).getByLabelText("Reply"), "typed");
  const switchTo = async (to: string) => {
    await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
    await user.click(await screen.findByRole("option", { name: to }));
  };
  await switchTo("Notes");
  await switchTo("Echo");
  expect(within(dialog).getByLabelText("Reply")).toHaveValue("");
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({ type: "test/echo", config: { reply: "" } }),
  );
});

it("edits instructions below the identity card without a separate editing step", async () => {
  const { agents, dialog, user } = setup([notes]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  const instructions = within(dialog).getByRole("textbox", {
    name: "Instructions",
  });
  expect(
    within(dialog).getByRole("group", { name: "Agent avatar" }),
  ).not.toContainElement(instructions);
  await user.type(instructions, " And kind.{Enter}Keep it short.");
  expect(agents.create).not.toHaveBeenCalled();
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      config: {
        notes: "start",
        instructions: "Be brief. And kind.\nKeep it short.",
      },
    }),
  );
});

it("shows a failed create's error, stays open, and lets it be tried again", async () => {
  let attempts = 0;
  const { agents, onCreated, onClose, dialog, user } = setup(
    [echo],
    async () => {
      if (++attempts === 1) throw new Error("Credential store refused");
      return made;
    },
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Credential store refused",
  );
  expect(screen.getByRole("dialog", { name: "Create agent" })).toBeVisible();
  expect(createButton()).toBeEnabled();
  expect(within(dialog).getByLabelText("Name")).toBeEnabled();
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Nova");
  expect(onCreated).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith(made));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("clears a shown error when the name changes", async () => {
  const { dialog, user } = setup([echo], async () => {
    throw new Error("Nope");
  });
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  expect(await screen.findByRole("alert")).toHaveTextContent("Nope");
  await user.type(within(dialog).getByLabelText("Name"), "!");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("blocks a second create while the first is pending", async () => {
  let finish: (agent: Agent) => void = () => {};
  const { agents, dialog, user } = setup(
    [echo],
    () => new Promise<Agent>((resolve) => (finish = resolve)),
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(createButton());
  await vi.waitFor(() => expect(agents.create).toHaveBeenCalledTimes(1));
  expect(within(dialog).getByLabelText("Name")).toBeDisabled();
  expect(within(dialog).getByLabelText("Reply")).toBeDisabled();
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledTimes(1);
  finish(made);
});

const withModels = (type: RegisteredAgentType): RegisteredAgentType => ({
  ...type,
  CreateModel: ({ config, onChange, ...props }) => {
    const current = config as Record<string, unknown>;
    return (
      <CreateModelChoices
        {...props}
        models={[
          { id: "fast", label: "Fast" },
          { id: "deep", label: "Deep" },
        ]}
        value={String(current.model ?? "")}
        defaultLabel={`${type.title} default`}
        onChange={(model) => onChange({ ...current, model })}
      />
    );
  },
});

it("chooses harness and model separately while retaining instructions", async () => {
  const { agents, dialog, user } = setup([withModels(echo), withModels(notes)]);
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(within(dialog).getByRole("combobox", { name: "Harness" }));
  await user.click(await screen.findByRole("option", { name: "Notes" }));
  const instructions = within(dialog).getByLabelText("Instructions");
  await user.type(instructions, " Keep this.");
  const model = within(dialog).getByRole("combobox", { name: "Model" });
  await user.click(model);
  await user.click(await screen.findByRole("option", { name: "Deep" }));
  expect(instructions).toHaveValue("Be brief. Keep this.");
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledWith(
    expect.objectContaining({
      type: notes.key,
      config: {
        notes: "start",
        instructions: "Be brief. Keep this.",
        model: "deep",
      },
    }),
  );
});
