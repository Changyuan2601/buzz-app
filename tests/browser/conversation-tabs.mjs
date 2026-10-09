import { expect } from "./fixture.mjs";

export async function chooseConversationTab(
  page,
  name,
  { add = true, category = "Channels" } = {},
) {
  const workspace = page.locator("[data-panel-workspace]");
  if (add)
    await workspace
      .getByRole("button", { name: "Add tab", exact: true })
      .click();
  const picker = workspace.getByRole("region", { name: "Choose a tab" });
  const search = picker.getByRole("searchbox", {
    name: "Find a channel or person",
  });
  await expect(search).toBeFocused();
  if (category !== "Channels")
    await picker.getByRole("tab", { name: category, exact: true }).click();
  await search.fill(name);
  await picker.getByRole("button", { name, exact: true }).click();
  await expect(workspace.getByRole("tab", { name, exact: true })).toBeFocused();
}
