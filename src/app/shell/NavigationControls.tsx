import { IconButton } from "../../shared/design-system/ui/IconButton";
import { memo, useSyncExternalStore } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
} from "../../shared/design-system/icons/index";
import type { Navigation } from "../../features/navigation/controller";
export const NavigationControls = memo(function NavigationControls({
  navigation,
}: {
  navigation: Navigation;
}) {
  const canGoBack = useSyncExternalStore(
    navigation.subscribe,
    () => navigation.snapshot().canGoBack,
  );
  const canGoForward = useSyncExternalStore(
    navigation.subscribe,
    () => navigation.snapshot().canGoForward,
  );
  return (
    <nav
      className="flex shrink-0 items-center gap-0"
      aria-label="Navigation history"
    >
      <IconButton
        hint="familiar"
        type="button"
        variant="ghost"
        aria-label="Go back"
        title="Go back"
        disabled={!canGoBack}
        onClick={navigation.back}
        icon={<ArrowLeftIcon size={16} aria-hidden="true" />}
      />
      <IconButton
        hint="familiar"
        type="button"
        variant="ghost"
        aria-label="Go forward"
        title="Go forward"
        disabled={!canGoForward}
        onClick={navigation.forward}
        icon={<ArrowRightIcon size={16} aria-hidden="true" />}
      />
    </nav>
  );
});
