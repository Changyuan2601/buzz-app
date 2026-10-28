// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PageNavigation } from "../navigation/service";
import { PageView } from "./PageView";
import type { PageProps, RegisteredPage } from "./service";

afterEach(cleanup);

it("renders the page again only when its own props change", () => {
  const rendered = vi.fn();
  const page: RegisteredPage = {
    id: "channels",
    key: "buzz.channels/channels",
    pluginId: "buzz.channels",
    revision: "1",
    title: "Channels",
    component: (props: PageProps) => {
      rendered(props);
      return <p>Channels</p>;
    },
  };
  const navigation = (entryId: string) =>
    ({ entryId, complete: () => true }) as unknown as PageNavigation;
  const first = navigation("a");
  const { rerender } = render(<PageView page={page} navigation={first} />);
  // A shell render that keeps the page's props leaves the page alone.
  rerender(<PageView page={page} navigation={first} />);
  expect(rendered).toHaveBeenCalledTimes(1);
  const next = navigation("b");
  rerender(<PageView page={page} navigation={next} />);
  expect(rendered).toHaveBeenCalledTimes(2);
  expect(rendered).toHaveBeenLastCalledWith(
    expect.objectContaining({ navigation: next }),
  );
});
