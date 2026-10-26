import type { ReactNode } from "react";
import { OnboardingScreen } from "./OnboardingScreen";

// Unstyled wireframe: first-run pages with no onboarding design yet use plain
// borders and the shared controls, inside the shared onboarding screen.

/** A bordered group within a wireframe page. */
export function WireframePanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-standard p-3">
      {children}
    </div>
  );
}

/** A first-run page titled by its `welcome-title` heading. */
export function WireframeScreen({ children }: { children: ReactNode }) {
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={
        <div className="flex w-full max-w-md flex-col gap-6 text-left">
          {children}
        </div>
      }
    >
      {null}
    </OnboardingScreen>
  );
}
