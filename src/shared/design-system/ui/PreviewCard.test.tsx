// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { PreviewCard } from "./PreviewCard";

afterEach(cleanup);

it("mounts a trigger inside an overlay boundary in one render", async () => {
  let renders = 0;
  function Profile(props: ComponentProps<"a">) {
    renders++;
    return <a {...props}>Profile</a>;
  }
  render(
    <div data-overlay-boundary="">
      <PreviewCard trigger={<Profile href="#profile" />} aria-label="Preview">
        Preview body
      </PreviewCard>
    </div>,
  );
  expect(renders).toBe(1);
  act(() => screen.getByRole("link", { name: "Profile" }).focus());
  expect(await screen.findByText("Preview body")).toBeInTheDocument();
});
