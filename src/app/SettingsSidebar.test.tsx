// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsSidebar } from "./SettingsSidebar";
import type { Communities } from "../features/communities/service";
import type { SettingsCards } from "../features/settings/service";
import {
  CopyIcon,
  FolderSimpleIcon,
  GlobeIcon,
} from "../shared/design-system/icons";

import { CpuIcon, ChatCircleIcon } from "../shared/design-system/icons";

afterEach(cleanup);

it("keeps Administration separate and uses each card's navigation icon", () => {
  const client = {
    selected: "primary",
    memberships: [{ id: "primary", name: "Primary" }],
  };
  const connection = { scope: "settings-sidebar-admin-test" };
  const cards: ReturnType<SettingsCards["snapshot"]> = [
    {
      id: "membership",
      key: "moderation/membership",
      pluginId: "moderation",
      revision: "one",
      title: "Membership",
      icon: CopyIcon,
      section: "administration",
      component: () => null,
    },
    {
      id: "groups",
      key: "channels/groups",
      pluginId: "channels",
      revision: "one",
      title: "Personal groups",
      icon: FolderSimpleIcon,
      component: () => null,
    },
    {
      id: "hosted",
      key: "communities/hosted",
      pluginId: "communities",
      revision: "one",
      title: "Hosted communities",
      group: "Communities",
      icon: GlobeIcon,
      component: () => null,
    },
  ];
  render(
    <SettingsSidebar
      communities={
        {
          subscribe: () => () => {},
          snapshot: () => client,
          relay: {
            subscribe: () => () => {},
            snapshot: () => connection,
          },
        } as unknown as Communities
      }
      cards={
        {
          subscribe: () => () => {},
          snapshot: () => cards,
        } as unknown as SettingsCards
      }
      selected="moderation/membership"
      onBack={() => {}}
      onSection={() => {}}
    />,
  );

  const membership = screen.getByRole("button", { name: "Membership" });
  expect(membership).toHaveAttribute("aria-current", "page");
  expect(membership.closest("section")).toHaveTextContent("Administration");
  expect(membership.closest("section")).not.toHaveTextContent("Primary");
  expect(membership.querySelector("svg")).toHaveClass("tabler-icon-copy");
  expect(
    screen
      .getByRole("button", { name: "Personal groups" })
      .querySelector("svg"),
  ).toHaveClass("tabler-icon-folder");
  expect(
    screen
      .getByRole("button", { name: "Hosted communities" })
      .querySelector("svg"),
  ).toHaveClass("tabler-icon-world");
});

it.each([null, "primary"])(
  "keeps one usable Profile entry with community %s",
  async (selected) => {
    const client = {
      selected,
      memberships: [{ id: "primary", name: "Primary" }],
    };
    const connection = { scope: "settings-sidebar-profile-test" };
    const cards: ReturnType<SettingsCards["snapshot"]> = [];
    const onSection = vi.fn();
    render(
      <SettingsSidebar
        communities={
          {
            subscribe: () => () => {},
            snapshot: () => client,
            relay: { subscribe: () => () => {}, snapshot: () => connection },
          } as unknown as Communities
        }
        cards={
          {
            subscribe: () => () => {},
            snapshot: () => cards,
          } as unknown as SettingsCards
        }
        selected="profile"
        onBack={() => {}}
        onSection={onSection}
      />,
    );
    const profile = screen.getByRole("button", {
      name: "Profile",
    });
    expect(profile).toHaveAttribute("aria-current", "page");
    expect(profile.closest("section")).toHaveTextContent(
      selected ? "Primary" : "App",
    );
    await userEvent.setup().click(profile);
    expect(onSection).toHaveBeenCalledWith("profile");
  },
);

it("uses a contributed icon and preserves the chat fallback", () => {
  const client = {
    selected: "primary",
    memberships: [{ id: "primary", name: "Primary" }],
  };
  const connection = { scope: "icon-test" };
  const entries = [
    {
      id: "compute",
      key: "mesh/compute",
      pluginId: "mesh",
      revision: "one",
      title: "Compute",
      component: () => null,
      icon: CpuIcon,
    },
    {
      id: "other",
      key: "other/card",
      pluginId: "other",
      revision: "one",
      title: "Other",
      component: () => null,
    },
  ];
  render(
    <SettingsSidebar
      communities={
        {
          snapshot: () => client,
          subscribe: () => () => {},
          relay: { snapshot: () => connection, subscribe: () => () => {} },
        } as unknown as Communities
      }
      cards={
        {
          snapshot: () => entries,
          subscribe: () => () => {},
        } as unknown as SettingsCards
      }
      onBack={() => {}}
      onSection={() => {}}
    />,
  );
  const reference = render(
    <>
      <CpuIcon data-testid="cpu-reference" />
      <ChatCircleIcon data-testid="chat-reference" />
    </>,
  );
  expect(
    screen.getByRole("button", { name: "Compute" }).querySelector("svg")
      ?.innerHTML,
  ).toBe(reference.getByTestId("cpu-reference").innerHTML);
  expect(
    screen.getByRole("button", { name: "Other" }).querySelector("svg")
      ?.innerHTML,
  ).toBe(reference.getByTestId("chat-reference").innerHTML);
  expect(
    screen.getByRole("button", { name: "Compute" }).closest("section"),
  ).toHaveTextContent("Primary");
});
