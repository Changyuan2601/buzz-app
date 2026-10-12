import { useState, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createDraftGuard } from "../../src/features/drafts/guard";
import { DraftProtection } from "../../src/features/drafts/DraftProtection";
import { createBrowserHistory } from "../../src/features/navigation/browser-history";
import { createNavigationController } from "../../src/features/navigation/controller";
import { Button } from "../../src/shared/design-system/ui/Button";
import { Field } from "../../src/shared/design-system/ui/Field";
import { Textarea } from "../../src/shared/design-system/ui/Textarea";
import "../../src/shared/styles/globals.css";
const guard = createDraftGuard();
const driver = createBrowserHistory(window, guard);
const controller = createNavigationController(driver, 15000, guard);
const agent = { version: 1, kind: "settings", section: "agents" } as const;
const appearance = {
  version: 1,
  kind: "settings",
  section: "appearance",
} as const;
function Editor() {
  const [text, setText] = useState("");
  const [registration] = useState(() =>
    guard.register({}, "instructions", () => setText("")),
  );
  useLayoutEffect(() => {
    registration.update({ dirty: !!text, saving: false, revision: text });
  }, [text, registration]);
  useLayoutEffect(() => () => registration.dispose(), [registration]);
  return (
    <Field label="Instructions">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    </Field>
  );
}
function App() {
  const state = useSyncExternalStore(
    controller.navigation.subscribe,
    controller.navigation.snapshot,
  );
  useLayoutEffect(() => {
    controller.complete(state.attempt, { status: "opened" });
  }, [state.attempt]);
  return (
    <DraftProtection guard={guard}>
      <Button onClick={() => void controller.navigation.open(agent)}>
        Agent
      </Button>
      <Button onClick={() => void controller.navigation.open(appearance)}>
        Appearance
      </Button>
      <p role="status">{JSON.stringify(state.entry.target)}</p>
      <Editor key={state.entry.id} />
    </DraftProtection>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
