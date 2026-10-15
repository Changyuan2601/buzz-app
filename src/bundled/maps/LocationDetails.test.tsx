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
const maps = vi.hoisted(() => ({
  remove: vi.fn(),
  markerRemove: vi.fn(),
  fail: false,
}));
const notes = vi.hoisted(() => ({ loadNote: vi.fn(), saveNote: vi.fn() }));
vi.mock("./notes", async (actual) => ({ ...(await actual()), ...notes }));
vi.mock("./datasets", () => ({ mapDataEnabled: true }));
vi.mock("mapbox-gl", () => ({
  default: {
    Map: class {
      constructor() {
        if (maps.fail) throw new Error("WebGL unavailable");
      }
      remove = maps.remove;
      resize() {}
    },
    Marker: class {
      setLngLat() {
        return this;
      }
      addTo() {
        return this;
      }
      remove = maps.markerRemove;
    },
  },
}));
import { LocationDetails } from "./LocationDetails";
import { retailerResource } from "./retailer-reference";
beforeEach(() => {
  notes.loadNote.mockResolvedValue({ text: "", revision: 0 });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  notes.saveNote.mockReset();
  maps.fail = false;
});
it("holds the retailer card open during a save and keeps notes out of the message draft", async () => {
  let release!: (value: { text: string; revision: number }) => void;
  notes.saveNote.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const close = vi.fn(),
    insert = vi.fn(() => true as const);
  render(
    <LocationDetails
      selection={{
        id: `square-roster:${"a".repeat(64)}`,
        coordinates: [-122.4, 37.7],
        name: "Salon",
        address: "123 Example St",
      }}
      scope="viewer-community"
      channel="map"
      canAddToMessage
      onAddToMessage={insert}
      onClose={close}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Note" })).toBeEnabled(),
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Personal note" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save note" }));
  await waitFor(() => expect(notes.saveNote).toHaveBeenCalledOnce());
  try {
    expect(
      screen.getByRole("button", { name: "Close location details" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Add to message" }),
    ).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  } finally {
    await act(async () => release({ text: "Personal note", revision: 1 }));
  }
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Note saved"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add to message" }));
  expect(insert).toHaveBeenCalledExactlyOnceWith(
    retailerResource(
      {
        id: `square-roster:${"a".repeat(64)}`,
        coordinates: [-122.4, 37.7],
        name: "Salon",
        address: "123 Example St",
      },
      "map",
    ),
  );
  expect(close).toHaveBeenCalledOnce();
});
it("shows source text safely and closes through the existing dialog control", async () => {
  const close = vi.fn();
  render(
    <LocationDetails
      selection={{
        coordinates: [-122.4, 37.7],
        name: "<b>Salon</b>",
        address: "123 Example St",
        label: "hair_salon",
      }}
      onClose={close}
    />,
  );
  expect(screen.getByRole("dialog")).toHaveAccessibleName("<b>Salon</b>");
  expect(screen.getByText("<b>Salon</b>").querySelector("b")).toBeNull();
  expect(screen.getByText("123 Example St")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Close location details" }),
  );
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
it("releases the miniature map and marker when the detail overlay unmounts", () => {
  vi.stubEnv("VITE_MAPBOX_TOKEN", "test");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const { unmount } = render(
    <LocationDetails
      selection={{ coordinates: [-122.4, 37.7] }}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("Address unavailable")).toBeVisible();
  unmount();
  expect(maps.remove).toHaveBeenCalledOnce();
  expect(maps.markerRemove).toHaveBeenCalledOnce();
});

it("keeps location details usable when a second WebGL map cannot initialize", () => {
  vi.stubEnv("VITE_MAPBOX_TOKEN", "test");
  maps.fail = true;
  render(
    <LocationDetails
      selection={{
        coordinates: [-122.4, 37.7],
        name: "Salon",
        address: "123 Example St",
      }}
      onClose={() => {}}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Map preview unavailable",
  );
  expect(screen.getByText("123 Example St")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Close location details" }),
  ).toBeEnabled();
});

it("adds the chosen business as one inline resource, then closes without sending", () => {
  const insert = vi.fn(() => true as const),
    close = vi.fn();
  render(
    <LocationDetails
      selection={{
        coordinates: [-122.4, 37.7],
        name: "Salon",
        address: "123 Example St",
      }}
      canAddToMessage
      channel="map"
      onAddToMessage={insert}
      onClose={close}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add to message" }));
  expect(insert).toHaveBeenCalledExactlyOnceWith(
    retailerResource(
      { coordinates: [-122.4, 37.7], name: "Salon", address: "123 Example St" },
      "map",
    ),
  );
  expect(close).toHaveBeenCalledOnce();
});
it("retains the retailer card and explains a rejected draft edit", () => {
  const close = vi.fn();
  render(
    <LocationDetails
      selection={{
        coordinates: [-122.4, 37.7],
        name: "Salon",
        address: "123 Example St",
      }}
      canAddToMessage
      channel="map"
      onAddToMessage={() => "Links can't be added inside code"}
      onClose={close}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add to message" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Links can't be added inside code",
  );
  expect(close).not.toHaveBeenCalled();
});
it("does not add missing addresses or edit a disabled composer", () => {
  const base = {
    coordinates: [-122.4, 37.7] as [number, number],
    name: "Salon",
  };
  const { rerender } = render(
    <LocationDetails selection={base} canAddToMessage onClose={() => {}} />,
  );
  expect(screen.getByRole("button", { name: "Add to message" })).toBeDisabled();
  rerender(
    <LocationDetails
      selection={{ ...base, address: "123 Example St" }}
      canAddToMessage={false}
      onClose={() => {}}
    />,
  );
  expect(screen.getByRole("button", { name: "Add to message" })).toBeDisabled();
});
