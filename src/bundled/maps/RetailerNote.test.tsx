// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ loadNote: vi.fn(), saveNote: vi.fn() }));
vi.mock("./notes", async (actual) => ({ ...(await actual()), ...api }));
import { NoteConflict } from "./notes";
import { RetailerNote } from "./RetailerNote";
const props = {
  scope: "viewer-community",
  channel: "map",
  location: `square-roster:${"a".repeat(64)}`,
  onSaving: vi.fn(),
};
beforeEach(() => {
  api.loadNote.mockResolvedValue({ text: "Saved note", revision: 1 });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("loads, saves and clears the note without losing typed formatting", async () => {
  api.saveNote
    .mockResolvedValueOnce({ text: "Line 1\nLine 2", revision: 2 })
    .mockResolvedValueOnce({ text: "", revision: 3 });
  render(<RetailerNote {...props} />);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue(
      "Saved note",
    ),
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Line 1\nLine 2" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Note saved"),
  );
  expect(api.saveNote).toHaveBeenNthCalledWith(
    1,
    props.scope,
    props.channel,
    props.location,
    { text: "Line 1\nLine 2", revision: 1 },
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Note cleared"),
  );
  expect(api.saveNote).toHaveBeenNthCalledWith(
    2,
    props.scope,
    props.channel,
    props.location,
    { text: "", revision: 2 },
  );
});
it("holds edits until the saved note loads and cancels that read on unmount", async () => {
  let release!: (value: { text: string; revision: number }) => void;
  api.loadNote.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const view = render(<RetailerNote {...props} />);
  await waitFor(() => expect(api.loadNote).toHaveBeenCalledOnce());
  const call = api.loadNote.mock.calls[0];
  if (!call) throw new Error("Note read not started");
  const signal = call[3] as AbortSignal;
  try {
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
    view.unmount();
    expect(signal.aborted).toBe(true);
  } finally {
    await act(async () => release({ text: "Late note", revision: 1 }));
  }
});
it("retains the draft while comparing and explicitly replacing a concurrent edit", async () => {
  api.saveNote.mockRejectedValueOnce(
    new NoteConflict("Another window changed this note"),
  );
  api.loadNote
    .mockResolvedValueOnce({ text: "Saved note", revision: 1 })
    .mockResolvedValueOnce({ text: "Other window", revision: 2 });
  render(<RetailerNote {...props} />);
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveValue("Saved note"),
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "My draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Another window"),
  );
  expect(screen.getByRole("textbox")).toHaveValue("My draft");
  expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Load latest saved note" }),
  );
  await waitFor(() => expect(screen.getByText("Other window")).toBeVisible());
  expect(screen.getByRole("textbox")).toHaveValue("My draft");
  api.saveNote.mockResolvedValueOnce({ text: "My draft", revision: 3 });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Note saved"),
  );
  expect(api.saveNote).toHaveBeenLastCalledWith(
    props.scope,
    props.channel,
    props.location,
    { text: "My draft", revision: 2 },
  );
});
it("recovers a failed read and a failed save while preserving the draft", async () => {
  api.loadNote.mockRejectedValueOnce(new Error("offline"));
  api.saveNote.mockRejectedValueOnce(new Error("Could not save"));
  render(<RetailerNote {...props} />);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("couldn’t load"),
  );
  expect(screen.getByRole("button", { name: "Save note" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Retry loading note" }));
  await waitFor(() =>
    expect(screen.getByRole("textbox")).toHaveValue("Saved note"),
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Keep my draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save"),
  );
  expect(screen.getByRole("textbox")).toHaveValue("Keep my draft");
});
