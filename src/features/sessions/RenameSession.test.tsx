// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RelaySession } from "../relay/session";
import type { DetailsAttempt } from "../relay/channel-details";
import { RenameSession } from "./RenameSession";
afterEach(cleanup);
function setup(canEdit = true) {
  const base = {
    channelId: "session",
    version: "revision",
    name: "Old",
    description: "Keep context",
    visibility: "private" as const,
    ttlSeconds: 3600,
    canEdit,
  };
  let attempt: DetailsAttempt | undefined;
  const details = {
    subscribe: () => () => {},
    snapshot: () => attempt,
    load: vi.fn(async () => base),
    save: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
  };
  const close = vi.fn();
  render(
    <RenameSession
      session={{ channelDetails: details } as unknown as RelaySession}
      id="session"
      name="Old"
      close={close}
    />,
  );
  return {
    base,
    details,
    close,
    uncertain: () => {
      attempt = { status: "unconfirmed", draft: base };
    },
  };
}
it("renames through verified details without changing visibility, description or lifetime", async () => {
  const { details, base, close } = setup();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), {
    target: { value: "  Better title  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(details.save).toHaveBeenCalledWith(base, {
    ...base,
    name: "Better title",
  });
});
it("retains the typed name after conflict and reloads the base before retry", async () => {
  const { details, close } = setup();
  details.save.mockRejectedValueOnce(new Error("Details changed"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Keep my title" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Details changed");
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Reload session details" }),
  );
  await waitFor(() => expect(details.load).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("textbox")).toHaveValue("Keep my title");
});
it("checks uncertain delivery instead of publishing another rename", async () => {
  const { details, uncertain, close } = setup();
  details.save.mockImplementationOnce(async () => {
    uncertain();
    throw new Error("Unconfirmed");
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Check saved name" }),
  );
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(details.save).toHaveBeenCalledOnce();
  expect(details.check).toHaveBeenCalledWith("session");
});
it("prevents rename without verified edit permission", async () => {
  const { details } = setup(false);
  expect(await screen.findByRole("status")).toHaveTextContent("permission");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(details.save).not.toHaveBeenCalled();
});
