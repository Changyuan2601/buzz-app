import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { AudioAttachment } from "../../src/features/messages/AudioAttachment";
import "../../src/shared/styles/globals.css";

function Fixture() {
  useKeyboardFocusVisibility();
  const [showError, setShowError] = useState(false);
  return (
    <main aria-label="Audio attachment fixture">
      <div data-audio-container="" style={{ width: "24rem", maxWidth: "100%" }}>
        <AudioAttachment
          attachment={{
            url: "/audio-sample.fixture",
            kind: "audio",
            name: "Sample",
          }}
          source="/audio-sample.fixture"
        />
      </div>
      <button type="button" onClick={() => setShowError(true)}>
        Trigger audio error
      </button>
      {showError && (
        <AudioAttachment
          attachment={{
            url: "https://fixture.test/audio.synthetic",
            kind: "audio",
            name: "Synthetic warning sample",
          }}
          source="/missing-audio.fixture"
        />
      )}
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
