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
import { CreateSidebarSection } from "./CreateSidebarSection";

afterEach(cleanup);

it("retains a rejected draft and its identity through preference recovery", async () => {
  const create = vi.fn().mockReturnValue(false);
  const retry = vi.fn().mockResolvedValue(undefined);
  const props = {
    channelName: "Beta",
    create,
    close: vi.fn(),
    writable: false,
    refreshing: false,
    retry,
  };
  const view = render(<CreateSidebarSection {...props} />);
  const input = screen.getByRole("textbox", { name: "Section name" });
  expect(
    screen.getByRole("dialog", { name: "Move to new section" }),
  ).not.toHaveAccessibleDescription();
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).toHaveAttribute("placeholder", "Section name");
  fireEvent.change(input, { target: { value: " Launch " } });
  const form = input.closest("form");
  if (!form) throw new Error("Create form missing");
  const submit = () => fireEvent.submit(form);
  await submit();
  expect(create).toHaveBeenCalledWith({
    id: expect.any(String),
    name: "Launch",
  });
  expect(input).toHaveValue(" Launch ");
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Retry preferences"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry preferences" }));
  expect(retry).toHaveBeenCalledTimes(1);
  view.rerender(<CreateSidebarSection {...props} refreshing />);
  expect(
    screen.getByRole("button", { name: "Retry preferences" }),
  ).toBeDisabled();
  view.rerender(<CreateSidebarSection {...props} />);
  expect(input).toHaveValue(" Launch ");
  create.mockReturnValue(true);
  view.rerender(<CreateSidebarSection {...props} writable />);
  expect(screen.queryByRole("alert")).toBeNull();
  await submit();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  await submit();
  expect(create).toHaveBeenCalledTimes(2);
});

it("keeps an empty-section draft and identity through a failed save, blocking dismissal while pending", async () => {
  let reject!: (cause: Error) => void;
  const create = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<boolean>((_, no) => {
          reject = no;
        }),
    )
    .mockResolvedValue(true);
  const close = vi.fn();
  render(
    <CreateSidebarSection
      create={create}
      close={close}
      writable
      refreshing={false}
      retry={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Section name" });
  expect(
    screen.getByRole("dialog", { name: "Create new section" }),
  ).toBeInTheDocument();
  await waitFor(() => expect(input).toHaveFocus());
  fireEvent.change(input, { target: { value: " Launch " } });
  const submit = screen.getByRole("button", { name: "Create" });
  fireEvent.click(submit);
  expect(input).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  const form = input.closest("form");
  if (!form) throw new Error("Create form missing");
  fireEvent.submit(form);
  expect(create).toHaveBeenCalledTimes(1);
  reject(new Error("Could not confirm section"));
  await screen.findByRole("alert");
  expect(input).toHaveValue(" Launch ");
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(submit);
  await waitFor(() => expect(input).toBeEnabled());
  expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
});
