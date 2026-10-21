import { welcomeTarget } from "../../features/channel-navigation/routes";
import type { Navigation } from "../../features/navigation/controller";
import {
  useWelcomeReceipt,
  WELCOME_CHAT_NAME,
} from "../../features/sessions/welcome";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";

/** Solo's way back into an unfinished Welcome. */
export function WelcomeSidebar({
  scope,
  navigator,
  selected,
  chats,
}: {
  scope: string;
  navigator: Navigation;
  /** The Welcome page is open. */
  selected: boolean;
  /** The owner's Solo chats in this community. */
  chats: readonly string[];
}) {
  const { receipt } = useWelcomeReceipt(scope);
  if (receipt?.complete || chats.includes(receipt?.channelId ?? ""))
    return null;
  return (
    <NavigationItem
      label={WELCOME_CHAT_NAME}
      selected={selected}
      onClick={() => void navigator.open(welcomeTarget(scope))}
    />
  );
}
