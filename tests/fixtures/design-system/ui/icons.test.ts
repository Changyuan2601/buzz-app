import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import * as gatewayIcons from "../../../../src/shared/design-system/icons/index";
import { TABLER_ICONS } from "../../../../src/shared/design-system/icons/inventory";

it("keeps every gateway icon decorative by default", () => {
  for (const Icon of Object.values(gatewayIcons)) {
    expect(renderToStaticMarkup(createElement(Icon))).toContain(
      'aria-hidden="true"',
    );
  }
});

it("renders every Tabler glyph with the existing size and color contract", () => {
  for (const { component: Icon } of TABLER_ICONS) {
    const markup = renderToStaticMarkup(
      createElement(Icon, { size: 18, color: "red", className: "test-icon" }),
    );
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('width="1.125rem"');
    expect(markup).toContain('height="1.125rem"');
    expect(markup).toContain("test-icon");
    expect(markup).toMatch(
      /<(path|circle|rect|line|polyline|polygon|ellipse)\b/,
    );
    expect(markup).toMatch(/(?:stroke|fill)="red"/);
  }
  expect(renderToStaticMarkup(createElement(gatewayIcons.PlusIcon))).toContain(
    'width="1em"',
  );
  expect(
    renderToStaticMarkup(
      createElement(gatewayIcons.PlusIcon, { strokeWidth: 2.5 }),
    ),
  ).toContain('stroke-width="2.5"');
  for (const Icon of [
    gatewayIcons.PlayFilledIcon,
    gatewayIcons.PauseFilledIcon,
  ]) {
    const markup = renderToStaticMarkup(createElement(Icon));
    expect(markup).toContain('fill="currentColor"');
    expect(markup).not.toContain("weight=");
  }
});
