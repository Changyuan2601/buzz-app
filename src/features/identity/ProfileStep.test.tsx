// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { publishProfile } from "../communities/api";
import { ProfileStep } from "./ProfileStep";

vi.mock("../communities/api", () => ({ publishProfile: vi.fn() }));

const found = {
  url: "https://relay.example.com",
  host: "relay.example.com",
  policy: undefined,
} as unknown as ComponentProps<typeof ProfileStep>["found"];
const none = {
  existing: {},
  profile: { name: "", picture: "", about: "" },
  exists: false,
};
function communities(previous = { name: "", picture: "", about: "" }) {
  return {
    snapshot: () =>
      ({ profile: previous }) as ReturnType<
        ComponentProps<typeof ProfileStep>["communities"]["snapshot"]
      >,
    saveProfile: vi.fn(),
  };
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("suggests and focuses the default name, needs a name to continue, and publishes then saves the trimmed profile", async () => {
  vi.mocked(publishProfile).mockResolvedValue(undefined);
  const service = communities();
  const onDone = vi.fn();
  const user = userEvent.setup();
  render(
    <ProfileStep
      found={found}
      read={none}
      defaultName="ada"
      communities={service}
      onDone={onDone}
    />,
  );
  const name = screen.getByRole("textbox", { name: "Display name" });
  expect(name).toHaveValue("ada");
  expect(name).toHaveFocus();
  await user.clear(name);
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  await user.type(name, " Ada ");
  await user.type(
    screen.getByRole("textbox", { name: "Profile description (optional)" }),
    "Hi ",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  const next = { name: "Ada", picture: "", about: "Hi" };
  expect(publishProfile).toHaveBeenCalledWith(found.url, next, {});
  expect(service.saveProfile).toHaveBeenCalledWith(next);
  expect(onDone).toHaveBeenCalledOnce();
});

it("keeps a relay profile the user leaves unchanged without republishing it", async () => {
  const profile = { name: "Ada", picture: "", about: "Hi" };
  const service = communities();
  const onDone = vi.fn();
  const user = userEvent.setup();
  render(
    <ProfileStep
      found={found}
      read={{ existing: { name: "Ada", about: "Hi" }, profile, exists: true }}
      defaultName="ignored"
      communities={service}
      onDone={onDone}
    />,
  );
  expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
    "Ada",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(publishProfile).not.toHaveBeenCalled();
  expect(service.saveProfile).toHaveBeenCalledWith(profile);
  expect(onDone).toHaveBeenCalledOnce();
});

it("a failed publish stays on the step with the error inline, and Skip for now leaves without publishing or saving", async () => {
  vi.mocked(publishProfile).mockRejectedValue(
    new Error("Profile publication was not confirmed"),
  );
  const service = communities();
  const onDone = vi.fn();
  const user = userEvent.setup();
  render(
    <ProfileStep
      found={found}
      read={none}
      defaultName="ada"
      communities={service}
      onDone={onDone}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Profile publication was not confirmed",
  );
  expect(onDone).not.toHaveBeenCalled();
  expect(service.saveProfile).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
    "ada",
  );
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(onDone).toHaveBeenCalledOnce();
  expect(publishProfile).toHaveBeenCalledOnce();
  expect(service.saveProfile).not.toHaveBeenCalled();
});
