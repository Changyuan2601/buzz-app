// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agents } from "../../features/agents/service";
import { channelTemplates } from "../../features/channel-templates/local";
import { ChannelTemplateSettings } from "./ChannelTemplateSettings";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const snapshot = {
  status: "ready",
  agents: [
    {
      pubkey: "a".repeat(64),
      name: "Ada",
      picture: "https://images.example/ada.png",
      relay: "https://community.example",
    },
    { pubkey: "b".repeat(64), name: "Grace" },
  ],
  running: [],
  teams: [
    { id: "t1", name: "Core", instructions: "", members: [] },
    { id: "t2", name: "Docs", instructions: "", members: [] },
  ],
};
const agents = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
} as unknown as Agents;

it("uses the relay thumbnail for a template agent after community registration", async () => {
  const community = "https://community.example";
  const picture = `${community}/media/${"a".repeat(64)}.png`;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
  );
  const picturedSnapshot = {
    ...snapshot,
    agents: [{ ...snapshot.agents[0], picture }],
  };
  const picturedAgents = {
    ...agents,
    snapshot: () => picturedSnapshot,
  } as unknown as Agents;
  render(
    <ChannelTemplateSettings agents={picturedAgents} active={() => true} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "New template" }));
  await waitFor(() => {
    expect(
      screen
        .getByRole("checkbox", { name: "Ada" })
        .closest("label")
        ?.querySelector("img"),
    ).toHaveAttribute(
      "src",
      `/api/relay/${encodeURIComponent(community)}/media?url=${encodeURIComponent(picture.replace(/\.png$/, ".thumb.jpg"))}`,
    );
  });
});

it("makes, edits and deletes a template of agents, teams and a Canvas", async () => {
  const user = userEvent.setup();
  render(<ChannelTemplateSettings agents={agents} active={() => true} />);
  await user.click(screen.getByRole("button", { name: "New template" }));
  const ada = screen.getByRole("checkbox", { name: "Ada" });
  const artwork = ada.closest("label")?.querySelector("img");
  expect(artwork).toHaveAttribute("src", snapshot.agents[0]?.picture);
  if (!artwork) throw new Error("Missing agent artwork");
  fireEvent.load(artwork);
  expect(artwork).toBeVisible();
  expect(
    screen.getByRole("checkbox", { name: "Grace" }).closest("label"),
  ).toHaveTextContent("GGrace");
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Launch");
  await user.click(artwork);
  expect(ada).toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "Docs" }));
  await user.type(
    screen.getByRole("textbox", { name: /Starting Canvas/ }),
    "# Goal",
  );
  await user.click(screen.getByRole("button", { name: "Save template" }));
  expect(channelTemplates.snapshot()).toMatchObject([
    {
      name: "Launch",
      teams: ["t2"],
      agents: ["a".repeat(64)],
      canvas: "# Goal",
    },
  ]);
  expect(screen.getByText("Ada, Docs · Canvas")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Edit Launch" }));
  expect(screen.getByRole("checkbox", { name: "Ada" })).toBeChecked();
  const grace = screen.getByRole("checkbox", { name: "Grace" });
  grace.focus();
  await user.keyboard(" ");
  expect(grace).toBeChecked();
  await user.keyboard(" ");
  expect(grace).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "Core" }));
  await user.click(screen.getByRole("button", { name: "Save template" }));
  expect(channelTemplates.snapshot()[0]?.teams).toEqual(["t2", "t1"]);

  await user.click(screen.getByRole("button", { name: "Edit Launch" }));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  expect(channelTemplates.snapshot()).toEqual([]);
  expect(screen.getByText("No channel templates yet")).toBeVisible();
});
