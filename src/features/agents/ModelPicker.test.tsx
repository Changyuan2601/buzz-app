// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ModelPicker, type ModelChoice } from "./ModelPicker";

afterEach(cleanup);

const models: ModelChoice[] = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus", description: "Most capable" },
];

function setup(value = "", props: { allowCustomModel?: boolean } = {}) {
  const onChange = vi.fn();
  const view = render(
    <ModelPicker
      models={models}
      allowCustomModel={props.allowCustomModel ?? true}
      value={value}
      defaultLabel="Default model"
      onChange={onChange}
    />,
  );
  return { onChange, view, user: userEvent.setup() };
}

const control = () => screen.getByRole("combobox", { name: "Model" });

it("picks a listed model", async () => {
  const { onChange, user } = setup("");
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: /Sonnet/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("sonnet");
});

it("picks the default as an empty value", async () => {
  const { onChange, user } = setup("opus");
  await user.click(control());
  await user.click(
    await screen.findByRole("option", { name: /Default model/ }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
});

it.each([
  [true, "Custom model"],
  [false, "Unavailable model"],
])(
  "describes a saved unlisted value when custom entry is %s",
  async (allowCustomModel, description) => {
    const { user } = setup("claude-old-1", { allowCustomModel });
    expect(control()).toHaveTextContent("claude-old-1");
    await user.click(control());
    const option = await screen.findByRole("option", { name: /claude-old-1/ });
    expect(option).toHaveTextContent(description);
    expect(option).toHaveAttribute("aria-selected", "true");
  },
);

it("does not submit a form around the custom-model dialog", async () => {
  const submitted = vi.fn();
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitted();
      }}
    >
      <ModelPicker
        models={models}
        allowCustomModel
        value=""
        defaultLabel="Default model"
        onChange={onChange}
      />
    </form>,
  );
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: "Custom model" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Model ID" }),
    "claude-custom-1{enter}",
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("claude-custom-1");
  expect(submitted).not.toHaveBeenCalled();
});

it("uses a dropdown to pick listed models when custom entry is disabled", async () => {
  const { onChange, user } = setup("", { allowCustomModel: false });
  expect(control().tagName).toBe("BUTTON");
  expect(control()).toHaveTextContent("Default model");
  await user.click(control());
  expect(
    screen.queryByRole("option", { name: "Custom model" }),
  ).not.toBeInTheDocument();
  await user.click(await screen.findByRole("option", { name: /Opus/ }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("opus");
});

it("edits a custom model in a dialog without changing the selection on cancel", async () => {
  const { onChange, user } = setup("opus");
  await user.click(control());
  const custom = await screen.findByRole("option", { name: "Custom model" });
  expect(custom).toHaveAccessibleDescription("Enter a model ID");
  await user.click(custom);
  expect(
    await screen.findByRole("dialog", { name: "Custom model" }),
  ).toBeVisible();
  const modelId = screen.getByRole("textbox", { name: "Model ID" });
  await waitFor(() => expect(modelId).toHaveFocus());
  expect(onChange).not.toHaveBeenCalled();
  await user.type(modelId, "ignored-model");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "Custom model" })).toBeNull();
  expect(control()).toHaveTextContent("Opus");
  await user.click(control());
  await user.click(await screen.findByRole("option", { name: "Custom model" }));
  await user.type(
    await screen.findByRole("textbox", { name: "Model ID" }),
    "  claude-custom-1  ",
  );
  await user.click(screen.getByRole("button", { name: "Use model" }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("claude-custom-1");
});

it("is disabled as a whole", () => {
  render(
    <ModelPicker
      models={models}
      allowCustomModel
      value=""
      defaultLabel="Default model"
      onChange={vi.fn()}
      disabled
    />,
  );
  expect(control()).toBeDisabled();
});

it("keeps loading inside the disabled picker and restores the selected value", () => {
  const onChange = vi.fn();
  const view = render(
    <ModelPicker
      models={[]}
      allowCustomModel={false}
      value=""
      defaultLabel="Default model"
      onChange={onChange}
      loading
    />,
  );
  const picker = control();
  expect(picker).toBeDisabled();
  expect(picker).toContainElement(screen.getByText("Loading models…"));
  view.rerender(
    <ModelPicker
      models={models}
      allowCustomModel={false}
      value="opus"
      defaultLabel="Default model"
      onChange={onChange}
    />,
  );
  expect(control()).toBe(picker);
  expect(picker).toBeEnabled();
  expect(picker).toHaveTextContent("Opus");
  expect(screen.queryByText("Loading models…")).not.toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps compact choices finite and includes rich model descriptions", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelPicker
      compact
      allowCustomModel
      models={models}
      value="sonnet"
      defaultLabel="Default model"
      onChange={onChange}
    />,
  );
  await user.click(control());
  expect(
    screen.queryByRole("option", { name: "Custom model" }),
  ).not.toBeInTheDocument();
  expect(await screen.findByRole("option", { name: "Sonnet" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const opus = screen.getByRole("option", { name: "Opus" });
  expect(opus).toHaveAccessibleDescription("Most capable");
  await user.click(opus);
  expect(onChange).toHaveBeenCalledExactlyOnceWith("opus");
});

it("lists the inherited default once with its catalog copy", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelPicker
      models={models}
      value=""
      defaultModel="opus"
      defaultLabel="Opus"
      onChange={onChange}
    />,
  );
  expect(control()).toHaveTextContent("Opus · Default");
  expect(screen.getByTitle("Opus · Default")).toBeVisible();
  await user.click(control());
  const options = await screen.findAllByRole("option");
  expect(options).toHaveLength(2);
  expect(options[0]).toHaveAccessibleName("Opus · Default");
  expect(options[1]).toHaveAccessibleName("Sonnet");
  expect(options[0]).toHaveAccessibleDescription("Most capable");
  expect(options[0]).toHaveAttribute("aria-selected", "true");
  expect(onChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole("option", { name: "Sonnet" }));
  expect(onChange).toHaveBeenCalledWith("sonnet");
});

it("keeps a matching explicit pin distinct from inheritance as defaults change", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const props = {
    models,
    value: "opus",
    defaultModel: "opus",
    defaultLabel: "Opus",
    onChange,
  };
  const view = render(<ModelPicker {...props} />);
  expect(control()).not.toHaveTextContent("Default");
  await user.click(control());
  const inherited = await screen.findByRole("option", {
    name: "Opus · Default",
  });
  const pinned = screen.getByRole("option", { name: "Opus" });
  expect(pinned).toHaveAttribute("aria-selected", "true");
  expect(pinned).toHaveAccessibleDescription("Most capable");
  expect(inherited).toHaveAttribute("aria-selected", "false");
  expect(onChange).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  view.rerender(
    <ModelPicker {...props} defaultModel="sonnet" defaultLabel="Sonnet" />,
  );
  expect(control()).toHaveTextContent("Opus");
  await user.click(control());
  expect(await screen.findByRole("option", { name: "Opus" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.keyboard("{Escape}");
  view.rerender(<ModelPicker {...props} />);
  await user.click(control());
  await user.click(
    await screen.findByRole("option", { name: "Opus · Default" }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("");
  view.rerender(
    <ModelPicker
      {...props}
      value=""
      defaultModel="sonnet"
      defaultLabel="Sonnet"
    />,
  );
  expect(control()).toHaveTextContent("Sonnet · Default");
  await user.click(control());
  expect(
    await screen.findByRole("option", { name: "Sonnet · Default" }),
  ).toHaveAttribute("aria-selected", "true");
});

it("opens a family before selecting a model and formats only its display name", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelPicker
      groupByFamily
      modelLabelPrefixes={["databricks-", "goose-"]}
      models={[
        { id: "databricks-gpt-6", label: "databricks-gpt-6" },
        { id: "databricks-gpt-6-codex", label: "databricks-gpt-6-codex" },
        { id: "databricks-kimi-k2", label: "databricks-kimi-k2" },
        { id: "unrecognized-model", label: "unrecognized-model" },
      ]}
      value="databricks-gpt-6"
      defaultLabel="Provider default"
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("button", { name: /^Model:/ });
  expect(trigger).toHaveTextContent("GPT-6");
  expect(trigger).not.toHaveTextContent("databricks-");
  await user.click(trigger);
  expect(screen.queryByRole("menuitemradio", { name: "Kimi K2" })).toBeNull();
  expect(await screen.findByRole("menuitem", { name: "OpenAI" })).toBeVisible();
  expect(screen.queryByRole("menuitem", { name: "Codex" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "GPT" })).toBeNull();
  expect(screen.getByRole("menuitem", { name: "Other" })).toBeVisible();
  screen.getByRole("menuitem", { name: "OpenAI" }).focus();
  await user.keyboard("{ArrowRight}");
  expect(
    await screen.findByRole("menuitemradio", { name: "GPT-6" }),
  ).toBeVisible();
  await user.click(
    await screen.findByRole("menuitemradio", { name: "GPT-6 Codex" }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("databricks-gpt-6-codex");
});

it("keeps the IDs of Databricks models whose names read the same", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const ids = [
    "system.ai.gpt-6-1-sol",
    "acme_models.goose.goose-gpt-6-1-sol",
    "system.ai.gpt-6-luna",
  ];
  render(
    <ModelPicker
      groupByFamily
      modelLabelPrefixes={["databricks-", "goose-"]}
      models={ids.map((id) => ({ id, label: id }))}
      value=""
      defaultLabel="acme_models.goose.goose-gpt-6-1-sol"
      onChange={onChange}
    />,
  );
  await user.click(
    screen.getByRole("button", {
      name: "Model: acme_models.goose.goose-gpt-6-1-sol · Default",
    }),
  );
  (await screen.findByRole("menuitem", { name: "OpenAI" })).focus();
  await user.keyboard("{ArrowRight}");
  expect(
    await screen.findByRole("menuitemradio", { name: "GPT-6 Luna" }),
  ).toBeVisible();
  await user.click(
    screen.getByRole("menuitemradio", { name: "system.ai.gpt-6-1-sol" }),
  );
  expect(onChange).toHaveBeenCalledExactlyOnceWith("system.ai.gpt-6-1-sol");
});

it("marks a saved model the list lacks in the family menu", async () => {
  const user = userEvent.setup();
  render(
    <ModelPicker
      groupByFamily
      allowCustomModel
      modelLabelPrefixes={["databricks-", "goose-"]}
      models={[
        {
          id: "acme_models.goose.goose-gpt-6-luna",
          label: "acme_models.goose.goose-gpt-6-luna",
        },
      ]}
      value="system.ai.gpt-6-1-sol"
      defaultLabel="Provider default"
      onChange={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Model: GPT-6.1 Sol" }));
  (await screen.findByRole("menuitem", { name: "OpenAI" })).focus();
  await user.keyboard("{ArrowRight}");
  const saved = await screen.findByRole("menuitemradio", {
    name: "GPT-6.1 Sol · Custom model",
  });
  expect(saved).toBeChecked();
  expect(
    screen.getByRole("menuitemradio", { name: "GPT-6 Luna" }),
  ).toBeVisible();
});

it("keeps custom entry and default selection in the family menu", async () => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(
    <ModelPicker
      groupByFamily
      allowCustomModel
      models={models}
      value="sonnet"
      defaultLabel="Provider default"
      onChange={onChange}
    />,
  );
  await user.click(screen.getByRole("button", { name: /^Model:/ }));
  await user.click(
    await screen.findByRole("menuitemradio", {
      name: "Provider default · Default",
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith("");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await user.click(screen.getByRole("button", { name: /^Model:/ }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Custom model" }),
  );
  await user.type(screen.getByRole("textbox"), "new-model");
  await user.click(screen.getByRole("button", { name: "Use model" }));
  expect(onChange).toHaveBeenLastCalledWith("new-model");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^Model:/ })).toHaveFocus(),
  );
});

it("keeps a Default suffix beside inherited card models as defaults change", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const props = {
    compact: true,
    appearance: "glass-ghost" as const,
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
      { id: "gpt-6.1-astra", label: "GPT-6.1-Astra" },
    ],
    value: "",
    defaultLabel: "GPT-6.1-Sol",
    onChange,
  };
  const view = render(<ModelPicker {...props} />);
  expect(control()).toHaveTextContent(/^GPT-6.1-Sol · Default$/);
  expect(control().querySelector(".buzz-select-value")).toHaveTextContent(
    /^GPT-6.1-Sol$/,
  );
  expect(
    control().querySelector(".buzz-select-value-suffix"),
  ).toHaveTextContent("· Default");
  expect(screen.getByTitle("GPT-6.1-Sol · Default")).toBeVisible();
  await user.click(control());
  expect(
    await screen.findByRole("option", { name: "GPT-6.1-Sol · Default" }),
  ).toHaveAttribute("aria-selected", "true");
  await user.keyboard("{Escape}");

  view.rerender(<ModelPicker {...props} defaultLabel="GPT-6.1-Astra" />);
  expect(control()).toHaveTextContent(/^GPT-6.1-Astra · Default$/);
  expect(onChange).not.toHaveBeenCalled();

  view.rerender(<ModelPicker {...props} value="gpt-6.1-sol" />);
  expect(control()).toHaveTextContent(/^GPT-6.1-Sol$/);
  expect(control().querySelector(".buzz-select-value-suffix")).toBeNull();

  view.rerender(<ModelPicker {...props} loading />);
  expect(control()).toHaveTextContent("Loading models…");
  expect(control().querySelector(".buzz-select-value-suffix")).toBeNull();
});
