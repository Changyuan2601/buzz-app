// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { memo } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatFullTimestamp } from "../../shared/datetime";
import {
  DayDivider,
  MessageTimestamp,
  MessageTimestampHint,
} from "./MessageTimestamp";

function timestamp(createdAt: number, hint = false) {
  return hint ? (
    <MessageTimestampHint createdAt={createdAt}>
      <p>Message body</p>
    </MessageTimestampHint>
  ) : (
    <MessageTimestamp createdAt={createdAt} />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 24, 12));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
// The label ladder itself belongs to formatItemTimestamp in datetime.test.ts.
it("names the day outside today while retaining the full accessible date", () => {
  const date = new Date(2026, 8, 23, 9, 5);
  const { container } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} />,
  );
  expect(container.querySelector("time")).toHaveAttribute(
    "datetime",
    date.toISOString(),
  );
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
    /^Yesterday at 9:05 AM$/,
  );
  expect(
    screen.getByText(
      date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }),
    ),
  ).toHaveClass("sr-only");
});
it("keeps a grouped timestamp accessible without a visible clock", () => {
  const date = new Date(2026, 8, 24, 9, 5);
  const { container } = render(timestamp(date.getTime() / 1000, true));
  expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  expect(container.querySelector("time")).toHaveClass("sr-only");
  expect(container.querySelector(".sr-only")).toHaveTextContent("2026");
});

it.each([false, true])(
  "refreshes cached styles after yielding when locale or timezone changes (hint=%s)",
  async (hint) => {
    const NativeFormat = Intl.DateTimeFormat;
    let locale = "en-GB";
    let timeZone = "Europe/London";
    function dateTimeFormat(
      requestedLocale?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ) {
      return new NativeFormat(requestedLocale ?? locale, {
        timeZone,
        ...options,
      });
    }
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(dateTimeFormat);
    const date = new Date("2026-09-24T09:05:00Z");
    const { container, rerender } = render(
      timestamp(date.getTime() / 1000, hint),
    );
    const assertDate = () => {
      expect(container.querySelector(".sr-only")).toHaveTextContent(
        new NativeFormat(locale, {
          timeZone,
          dateStyle: "full",
          timeStyle: "long",
        }).format(date),
      );
      const clock = new NativeFormat(locale, {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
      });
      if (hint) expect(container.querySelector("time")).toHaveClass("sr-only");
      else
        expect(
          container.querySelector('[aria-hidden="true"]'),
        ).toHaveTextContent(clock.format(date));
    };
    assertDate();
    await Promise.resolve();
    timeZone = "America/Los_Angeles";
    rerender(timestamp(date.getTime() / 1000, hint));
    assertDate();
    await Promise.resolve();
    locale = "de-DE";
    rerender(timestamp(date.getTime() / 1000, hint));
    assertDate();
  },
);
it("updates the visible clock, accessible date and datetime when a mounted row changes", () => {
  const date = new Date(2026, 8, 24, 9, 5);
  const { container, rerender } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} />,
  );
  date.setDate(date.getDate() + 1);
  date.setHours(17);
  rerender(timestamp(date.getTime() / 1000, true));
  expect(container.querySelector("time")).toHaveAttribute(
    "datetime",
    date.toISOString(),
  );
  expect(container.querySelector(".sr-only")).toHaveTextContent(
    date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }),
  );
  expect(container.querySelector("time")).toHaveClass("sr-only");
});
it("keeps grouped messages free of a hover date", async () => {
  const createdAt = new Date(2026, 8, 24, 9, 5).getTime() / 1000;
  render(timestamp(createdAt, true));
  const payload = screen.getByText("Message body").parentElement;
  if (!payload) throw new Error("Expected message payload");
  fireEvent.mouseEnter(payload);
  fireEvent.mouseMove(payload);
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
  expect(screen.queryByRole("tooltip")).toBeNull();
});

// Either side of local midnight; formatDayGroupLabel's ladder is tested in
// datetime.test.ts.
it.each([
  [new Date(2026, 8, 24, 0, 1), "2026-09-24", "Today"],
  [new Date(2026, 8, 23, 23, 59), "2026-09-23", "Yesterday"],
])(
  "the day divider for %s names its local day like plugins' dayGroupLabel",
  (date, day, label) => {
    const { container } = render(
      <DayDivider createdAt={date.getTime() / 1000} />,
    );
    expect(container.querySelector(`[data-day="${day}"]`)).toHaveTextContent(
      new RegExp(`^${label}$`),
    );
    expect(
      container.querySelector("[data-calendar-date]")?.closest("[aria-hidden]"),
    ).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("[data-calendar-date]")).toHaveTextContent(
      new RegExp(`^${date.getDate()}$`),
    );
  },
);

// Rows are memoized and a quiet conversation never re-renders them, so the
// labels must follow the local day on their own.
const QuietRow = memo(function QuietRow({ createdAt }: { createdAt: number }) {
  return (
    <>
      <DayDivider createdAt={createdAt} />
      <MessageTimestamp createdAt={createdAt} />
    </>
  );
});
function renderQuietRow() {
  vi.setSystemTime(new Date(2026, 8, 24, 23, 59));
  const createdAt = new Date(2026, 8, 24, 9, 5).getTime() / 1000;
  const { container } = render(<QuietRow createdAt={createdAt} />);
  const divider = () => container.querySelector("[data-day]");
  const byline = () => container.querySelector('time [aria-hidden="true"]');
  const calendar = () => container.querySelector("[data-calendar-date]");
  expect(divider()).toHaveTextContent(/^Today$/);
  expect(byline()).toHaveTextContent(/^9:05 AM$/);
  return { divider, byline, calendar };
}

it("relabels a mounted quiet row at local midnight", () => {
  const { divider, byline, calendar } = renderQuietRow();
  act(() => vi.advanceTimersByTime(60_000));
  expect(divider()).toHaveTextContent(/^Yesterday$/);
  expect(calendar()).toHaveTextContent(/^24$/);
  expect(byline()).toHaveTextContent(/^Yesterday at 9:05 AM$/);
});

it("relabels a mounted quiet row when the window wakes after midnight", () => {
  const { divider, byline, calendar } = renderQuietRow();
  // Sleep: the clock moves on but the midnight timer has not fired yet.
  vi.setSystemTime(new Date(2026, 8, 26, 8));
  expect(divider()).toHaveTextContent(/^Today$/);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(divider()).toHaveTextContent(/^Thursday$/);
  expect(calendar()).toHaveTextContent(/^24$/);
  expect(byline()).toHaveTextContent(/^Thursday at 9:05 AM$/);
});

function messageTimestamp(createdAt: number) {
  return (
    <div data-message-id="message">
      <MessageTimestamp createdAt={createdAt} deferHint />
    </div>
  );
}
const withoutTrigger = (html: string) =>
  html.replace(/ (id|data-base-ui-tooltip-trigger)="[^"]*"/g, "");

it("mounts a message timestamp's hint on the first pointer visit with identical markup", async () => {
  const createdAt = new Date(2026, 8, 23, 9, 5).getTime() / 1000;
  const { container } = render(messageTimestamp(createdAt));
  const time = () => container.querySelector("time");
  const staticMarkup = container.innerHTML;
  expect(time()).not.toHaveAttribute("data-base-ui-tooltip-trigger");
  const message = container.querySelector("[data-message-id]");
  if (!message) throw new Error("Expected message");
  fireEvent.pointerEnter(message);
  await act(async () => {});
  expect(time()).toHaveAttribute("data-base-ui-tooltip-trigger");
  expect(withoutTrigger(container.innerHTML)).toBe(staticMarkup);
  const visited = time();
  if (!visited) throw new Error("Expected time");
  fireEvent.mouseEnter(visited);
  fireEvent.mouseMove(visited);
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(screen.getByRole("tooltip")).toHaveTextContent(
    formatFullTimestamp(createdAt),
  );
  expect(visited).toHaveAttribute(
    "aria-describedby",
    screen.getByRole("tooltip").id,
  );
});

it("replays a move over the static timestamp so a resting pointer still opens the hint", async () => {
  const createdAt = new Date(2026, 8, 23, 9, 5).getTime() / 1000;
  const { container } = render(messageTimestamp(createdAt));
  const message = container.querySelector("[data-message-id]");
  const time = container.querySelector("time");
  if (!message || !time) throw new Error("Expected message");
  // The pointer lands on the timestamp as it enters the message, then rests.
  // The static element hears the move before the hint's render commits.
  fireEvent.mouseMove(time, { clientX: 4, clientY: 4 });
  fireEvent.pointerEnter(message);
  await act(() => vi.advanceTimersByTimeAsync(499));
  expect(screen.queryByRole("tooltip")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.getByRole("tooltip")).toHaveTextContent(
    formatFullTimestamp(createdAt),
  );
});

it("does not replay a pointer that moved off the timestamp before the hint mounted", async () => {
  const { container } = render(
    messageTimestamp(new Date(2026, 8, 23, 9, 5).getTime() / 1000),
  );
  const message = container.querySelector("[data-message-id]");
  const time = container.querySelector("time");
  if (!message || !time) throw new Error("Expected message");
  fireEvent.mouseMove(time);
  fireEvent.mouseMove(message);
  fireEvent.pointerEnter(message);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("mounts the hint at once when the message is already hovered", async () => {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return selector === ":hover"
      ? this.hasAttribute("data-message-id")
      : matches.call(this, selector);
  });
  const { container } = render(
    messageTimestamp(new Date(2026, 8, 23, 9, 5).getTime() / 1000),
  );
  await act(async () => {});
  expect(container.querySelector("time")).toHaveAttribute(
    "data-base-ui-tooltip-trigger",
  );
});

it("mounts an undeferred timestamp's hint with the message", () => {
  const { container } = render(
    <div data-message-id="message">
      <MessageTimestamp
        createdAt={new Date(2026, 8, 23, 9, 5).getTime() / 1000}
      />
    </div>,
  );
  expect(container.querySelector("time")).toHaveAttribute(
    "data-base-ui-tooltip-trigger",
  );
});
