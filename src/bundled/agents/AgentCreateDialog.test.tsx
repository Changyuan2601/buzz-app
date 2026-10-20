// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
import {
  act,
  cleanup,
  fireEvent,
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
import {
  emojiAvatar,
  uploadAvatar,
} from "../../features/profiles/avatar-upload";
import { AgentCreateDialog } from "./AgentCreateDialog";

vi.mock("../../features/profiles/avatar-upload", async (actual) => ({
  ...(await actual<typeof import("../../features/profiles/avatar-upload")>()),
  uploadAvatar: vi.fn(),
  emojiAvatar: vi.fn(),
  paintEmojiAvatar: vi.fn(),
}));

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (actual) => ({
  ...(await actual<typeof import("motion/react")>()),
  useReducedMotion: () => motion.reduced,
}));

afterEach(cleanup);
// jsdom lacks both; tests that need them install stubs, removed here along
// with stubbed frames and media queries.
afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  Reflect.deleteProperty(Element.prototype, "animate");
  vi.unstubAllGlobals();
  motion.reduced = false;
});

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
  community?: string,
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
      community={community}
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

it("creates with a custom emoji on a chosen background", async () => {
  const file = new File(["emoji"], "avatar.png", { type: "image/png" });
  vi.mocked(emojiAvatar).mockResolvedValueOnce(file);
  vi.mocked(uploadAvatar).mockResolvedValueOnce(
    "https://images.example/emoji.png",
  );
  const { agents, dialog, user } = setup(
    [echo],
    undefined,
    "https://a.example",
  );
  await user.type(within(dialog).getByLabelText("Name"), "Nova");
  await user.click(
    within(dialog).getByRole("button", { name: "Choose avatar" }),
  );
  await user.click(
    await within(dialog).findByRole("button", { name: "Use custom" }),
  );
  expect(within(dialog).getByRole("tab", { name: "Image" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(
    within(dialog).getByRole("button", { name: "Edit avatar" }),
  ).toBeVisible();
  await user.click(within(dialog).getByRole("tab", { name: "Emoji" }));
  await user.click(within(dialog).getByRole("tab", { name: "Background" }));
  await user.click(
    within(dialog).getByRole("button", { name: "Use #476CFF background" }),
  );
  await user.click(within(dialog).getByRole("button", { name: "Done" }));
  expect(emojiAvatar).toHaveBeenCalledExactlyOnceWith("😀", "#476CFF");
  await waitFor(() =>
    expect(uploadAvatar).toHaveBeenCalledWith(
      file,
      "https://a.example",
      expect.any(AbortSignal),
    ),
  );
  await user.click(
    await within(dialog).findByRole("button", { name: "Create agent" }),
  );
  expect(agents.create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ picture: "https://images.example/emoji.png" }),
  );
});

it("keeps an emoji's Done disabled without a community to upload it to", async () => {
  const { dialog, user } = setup([echo]);
  await user.click(
    within(dialog).getByRole("button", { name: "Choose avatar" }),
  );
  await user.click(
    await within(dialog).findByRole("button", { name: "Use custom" }),
  );
  await user.click(within(dialog).getByRole("tab", { name: "Background" }));
  expect(within(dialog).getByRole("button", { name: "Done" })).toBeDisabled();
  expect(
    within(dialog).getByText(/Select a community in the sidebar/),
  ).toBeVisible();
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

it("flags an empty name on Create and clears it once named", async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  const animate = vi.fn();
  Element.prototype.animate = animate;
  const { agents, dialog, user } = setup([echo]);
  const name = () => within(dialog).getByLabelText("Name");
  const alert = () => within(dialog).queryByRole("alert");
  expect(createButton()).toBeEnabled();
  expect(alert()).not.toBeInTheDocument();
  await user.type(name(), "   ");
  await user.click(createButton());
  expect(agents.create).not.toHaveBeenCalled();
  expect(alert()).toHaveTextContent("Add a name to create your agent");
  expect(name()).toHaveAccessibleDescription("Add a name to create your agent");
  expect(name()).toHaveAttribute("placeholder", "Name your agent");
  expect(name()).toHaveAttribute("aria-invalid", "true");
  expect(name()).toHaveFocus();
  // Already in view, so nothing scrolls.
  expect(scrollIntoView).not.toHaveBeenCalled();
  expect(animate).toHaveBeenCalledOnce();
  expect(name()).toHaveValue("   ");
  // Each further empty submit shakes again.
  await user.click(createButton());
  expect(animate).toHaveBeenCalledTimes(2);
  expect(agents.create).not.toHaveBeenCalled();
  await user.type(name(), "Nova");
  expect(alert()).not.toBeInTheDocument();
  expect(name()).not.toHaveAttribute("aria-invalid");
  await user.click(createButton());
  expect(agents.create).toHaveBeenCalledOnce();
});

/** Hands each animation frame to the test, so it can step a scroll. */
const stepFrames = () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) =>
    frames.push(frame),
  );
  vi.stubGlobal("cancelAnimationFrame", () => {});
  // One tick runs every frame requested before it, like the browser.
  return () =>
    act(() => {
      for (const frame of frames.splice(0)) frame(performance.now());
    });
};

/** An out-of-view name whose position the test moves frame by frame. */
const scrolledName = (dialog: HTMLElement) => {
  const name = within(dialog).getByLabelText("Name");
  // Just below the fold.
  const position = { top: window.innerHeight - 38 };
  name.getBoundingClientRect = () =>
    ({ top: position.top, bottom: position.top + 40 }) as DOMRect;
  const scrollIntoView = vi.fn();
  name.scrollIntoView = scrollIntoView;
  return { name, position, scrollIntoView };
};

it("scrolls an out-of-view name to center, then flags it as the glide slows", async () => {
  Element.prototype.animate = vi.fn();
  const step = stepFrames();
  const { dialog, user } = setup([echo]);
  const { position, scrollIntoView } = scrolledName(dialog);
  const alert = () => within(dialog).queryByRole("alert");
  await user.click(createButton());
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
    block: "center",
    behavior: "smooth",
  });
  // Pressing again mid-scroll doesn't start a second scroll.
  await user.click(createButton());
  expect(scrollIntoView).toHaveBeenCalledOnce();
  step();
  // Easing in: barely moving, and just in view, but not yet past the glide.
  position.top = window.innerHeight - 41;
  step();
  expect(alert()).not.toBeInTheDocument();
  position.top = 600;
  step();
  expect(alert()).not.toBeInTheDocument();
  position.top = 300;
  step();
  expect(alert()).not.toBeInTheDocument();
  // In view and slowing: the prompt plays while the glide lands.
  position.top = 298;
  step();
  expect(alert()).toHaveTextContent("Add a name to create your agent");
  expect(Element.prototype.animate).toHaveBeenCalledOnce();
});

it("does not flag a name typed while it scrolls into view", async () => {
  Element.prototype.animate = vi.fn();
  const step = stepFrames();
  const { dialog, user } = setup([echo]);
  const { name, position } = scrolledName(dialog);
  await user.click(createButton());
  step();
  fireEvent.change(name, { target: { value: "Nova" } });
  position.top = 300;
  step();
  position.top = 300;
  step();
  expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  expect(Element.prototype.animate).not.toHaveBeenCalled();
});

it("jumps instead of gliding, and skips the shake, under reduced motion", async () => {
  Element.prototype.animate = vi.fn();
  const step = stepFrames();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
    addEventListener() {},
    removeEventListener() {},
  }));
  motion.reduced = true;
  const { dialog, user } = setup([echo]);
  const { position, scrollIntoView } = scrolledName(dialog);
  await user.click(createButton());
  expect(scrollIntoView).toHaveBeenCalledWith(
    expect.objectContaining({ behavior: "auto" }),
  );
  position.top = 300;
  step();
  step();
  expect(within(dialog).getByRole("alert")).toHaveTextContent(
    "Add a name to create your agent",
  );
  expect(Element.prototype.animate).not.toHaveBeenCalled();
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
