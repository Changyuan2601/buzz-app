// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { CommunityAgent } from "./CommunityAgent";
import { COMMUNITY_AGENT_PRESETS } from "./communityAgentPresets";
import { stubAvatarBrowserApis } from "../../features/agents/avatar-testing";
stubAvatarBrowserApis();
afterEach(cleanup);
it("opens the existing creation dialog with shared compute and Auto without creating an identity", async () => {
  const fixture = controlFixture();
  fixture.data.defaultWorkspace = "/fixture/workspace";
  fixture.data.createAvailable = true;
  fixture.data.harnessOptions?.[0]?.providers.push({
    value: "relay-mesh",
    label: "Buzz shared compute",
  });
  const control = createAgentControl(fixture.host);
  await control.refresh();
  const view = render(
    <CommunityAgent
      control={control}
      destination="wss://relay.example.test"
      owner={"de".repeat(32)}
    />,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Create Custom agent" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Community agent");
  expect(
    within(dialog).getByRole("combobox", { name: /^Model$/ }),
  ).toHaveTextContent("Auto");
  expect(within(dialog).getByText("Buzz shared compute")).toBeInTheDocument();
  expect(fixture.calls.map((call) => call.action)).toEqual([
    "snapshot",
    "snapshot",
  ]);
  view.unmount();
});
it("prefills a preset's name and instructions on shared compute, still only after review", async () => {
  const fixture = controlFixture();
  fixture.data.defaultWorkspace = "/fixture/workspace";
  fixture.data.createAvailable = true;
  fixture.data.harnessOptions?.[0]?.providers.push({
    value: "relay-mesh",
    label: "Buzz shared compute",
  });
  const control = createAgentControl(fixture.host);
  await control.refresh();
  render(
    <CommunityAgent
      control={control}
      destination="wss://relay.example.test"
      owner={"de".repeat(32)}
    />,
  );
  const emoji = COMMUNITY_AGENT_PRESETS.find(
    (preset) => preset.id === "emoji-maker",
  );
  expect(
    screen.getByText(/custom emoji for the community palette/),
  ).toHaveTextContent("Needs ffmpeg on the host machine.");
  fireEvent.click(screen.getByRole("button", { name: "Set up Emoji maker" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByLabelText("Name")).toHaveValue("Emoji maker");
  expect(within(dialog).getByLabelText("Agent instructions")).toHaveValue(
    emoji?.systemPrompt,
  );
  expect(
    within(dialog).getByRole("combobox", { name: /^Model$/ }),
  ).toHaveTextContent("Auto");
  expect(within(dialog).getByText("Buzz shared compute")).toBeInTheDocument();
  expect(fixture.calls.map((call) => call.action)).not.toContain("create");
});
it("lists each example with an icon and offers a custom agent last", async () => {
  const control = createAgentControl(controlFixture().host);
  await control.refresh();
  render(
    <CommunityAgent
      control={control}
      destination="wss://relay.example.test"
      owner={"de".repeat(32)}
    />,
  );
  const rows = within(
    screen.getByRole("list", { name: "Community agent examples" }),
  ).getAllByRole("listitem");
  expect(rows).toHaveLength(COMMUNITY_AGENT_PRESETS.length + 1);
  for (const row of rows) expect(row.querySelector("svg")).not.toBeNull();
  expect(rows.at(-1)).toHaveTextContent("Custom agent");
  expect(
    within(rows.at(-1) as HTMLElement).getByRole("button", {
      name: "Create Custom agent",
    }),
  ).toBeVisible();
});
it("keeps an edited preset open when a later sync drops defaults, and retries when they never arrive", async () => {
  const fixture = controlFixture();
  fixture.data.createAvailable = true;
  fixture.data.defaultWorkspace = "";
  const control = createAgentControl(fixture.host);
  await control.refresh();
  render(
    <CommunityAgent
      control={control}
      destination="wss://relay.example.test"
      owner={"de".repeat(32)}
    />,
  );
  // No workspace from the re-read: offer Retry instead of loading forever.
  fireEvent.click(screen.getByRole("button", { name: "Create Custom agent" }));
  const retry = await screen.findByRole("button", { name: "Retry" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fixture.data.defaultWorkspace = "/fixture/workspace";
  fireEvent.click(retry);
  const name = within(await screen.findByRole("dialog")).getByLabelText("Name");
  fireEvent.change(name, { target: { value: "Eo9" } });
  // A later full read without defaults must not unmount the edited form.
  fixture.data.defaultWorkspace = "";
  await act(() => control.refresh());
  expect(within(screen.getByRole("dialog")).getByLabelText("Name")).toHaveValue(
    "Eo9",
  );
});
