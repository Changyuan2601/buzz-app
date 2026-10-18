// In-memory mock IPC only. Never put a real private key in this fixture.
import { mockIPC } from "@tauri-apps/api/mocks";
import { getPublicKey } from "nostr-tools/pure";
import { decode, nsecEncode } from "nostr-tools/nip19";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { Context } from "@deepseek-ai/cordis";
import { createIdentity } from "../../src/features/identity/service";
import { IdentitySetup } from "../../src/features/identity/IdentitySetup";
import { createCommunities } from "../../src/features/communities/service";
import { CommunityPicker } from "../../src/features/communities/CommunityPicker";
import { ProfileSettings } from "../../src/app/ProfileSettings";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import "../../src/shared/styles/globals.css";
const bytes = new Uint8Array(32).fill(1);
const fixtureKey = nsecEncode(bytes);
let saved: string | null = null;
mockIPC((command, payload) => {
  if (command === "identity_restore")
    return saved ? getPublicKey(bytesFrom(saved)) : null;
  if (command === "identity_export") {
    if (!saved) throw new Error("No fixture identity");
    return saved;
  }
  if (command === "identity_import" || command === "identity_create") {
    if (saved) throw new Error("Already saved");
    const supplied =
      command === "identity_create"
        ? fixtureKey
        : String((payload as { nsec: string }).nsec).trim();
    if (supplied !== fixtureKey)
      throw new Error(
        "This fixture accepts only the public test key displayed above. Do not use a real nsec.",
      );
    const viewer = getPublicKey(bytesFrom(supplied));
    saved = supplied;
    return viewer;
  }
  throw new Error("Unexpected fixture command");
});
function bytesFrom(value: string) {
  const result = decode(value);
  if (result.type !== "nsec") throw new Error("Expected nsec");
  return result.data;
}
function Fixture() {
  const [attempt, setAttempt] = useState(0);
  return (
    <>
      <aside className="p-4">
        <strong>
          UI fixture only — no Keychain or relay. Never enter a real key.
        </strong>
        <p>
          Public test key for import: <code>{fixtureKey}</code>
        </p>
        <button
          type="button"
          onClick={() => {
            saved = null;
            setAttempt(attempt + 1);
          }}
        >
          Reset fixture
        </button>
        <button type="button" onClick={() => setAttempt(attempt + 1)}>
          Simulate restart
        </button>
      </aside>
      <Client key={attempt} />
    </>
  );
}
function Client() {
  const [ctx] = useState(() => new Context());
  const [identity] = useState(createIdentity);
  const [communities] = useState(() =>
    createCommunities(ctx, false, undefined, "", undefined, identity.ready),
  );
  useEffect(
    () => () => {
      identity.dispose();
      void ctx.fiber.dispose();
    },
    [ctx, identity],
  );
  const [active, setActive] = useState(true);
  return (
    <IdentitySetup identity={identity}>
      <ToastProvider>
        <main className="p-8">
          <CommunityPicker communities={communities} />
          <button type="button" onClick={() => setActive(!active)}>
            {active ? "Leave Profile" : "Open Profile"}
          </button>
          <div hidden={!active}>
            <ProfileSettings
              communities={communities}
              identity={identity}
              active={active}
            />
          </div>
        </main>
      </ToastProvider>
    </IdentitySetup>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
