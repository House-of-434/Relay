import { AlertTriangle, RefreshCw } from "lucide-react";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { EngineSetup } from "./EngineSetup";
import { CHATGPT_USAGE_URL } from "./ChatGptPlanStatus";
import { openExternalLink } from "@/lib/app-links";
import { ClaudeUpdatePrompt } from "./ClaudeUpdatePrompt";
import { MacCuaRecoveryActions } from "./MacCuaRecoveryActions";
import { macCuaPermissionMessage, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { isProviderSafetyBlock, PROVIDER_SAFETY_GUIDANCE, PROVIDER_SAFETY_HELP_URL } from "../../shared/provider-safety";
import { t } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

/** A failed turn: a real error block with a retry, not a truncated pill.
 *
 * A `setup` error — CLI missing, or installed but not signed in — shows what
 * to do instead of a Retry, because retrying hits the same wall every time.
 * Once the engine reports itself fixed the card flips back to Retry, which
 * (with the on-focus re-probe) happens by itself when the user returns from
 * the terminal. */
export function ErrorRow({
  message,
  onRetry,
  setupInstance,
  claudeUpdateInstance,
}: {
  message: string;
  onRetry?: () => void;
  setupInstance?: InstanceInfo;
  /** The Claude engine to update when this turn failed because its Claude
   * Code is too old for the model. */
  claudeUpdateInstance?: InstanceInfo;
}) {
  const { capabilities, ready } = useDesktopCapabilities();
  const failedPermissions = missingMacCuaPermissions(message);
  const currentPermissions = missingMacCuaPermissions(capabilities.localComputer.message);
  const macCuaReason = ready && capabilities.host.platform === "darwin" &&
    capabilities.localComputer.available === false && capabilities.localComputer.reasonCode !== "remote-server" &&
    message.startsWith("CUA Driver is not ready for this computer — ") &&
    failedPermissions.length > 0 && failedPermissions.join(",") === currentPermissions.join(",")
    ? macCuaPermissionMessage(currentPermissions)
    : null;
  return (
    <div className="flex justify-start">
      <div className="w-fit max-w-[min(42rem,78%)] rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-[13.5px] text-danger">
        <div className="flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{macCuaReason ?? message}</span>
        </div>
        {macCuaReason && <details className="mt-2 text-[12px] text-ink-secondary"><summary className="cursor-pointer">{t("computer.mac.permission.driverDetail")}</summary><p className="mt-1 break-words">{message}</p></details>}
        {macCuaReason &&
          <MacCuaRecoveryActions reason={message} />}
        {message.includes("subscription_sharing_usage_limit_exceeded") ? (
          <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-app" onClick={(event) => {
            if (window.ogb?.openExternal) { event.preventDefault(); void openExternalLink(CHATGPT_USAGE_URL); }
          }}>{t("engineSetup.chatgpt.manageUsage")}</a>
        ) : claudeUpdateInstance ? (
          <ClaudeUpdatePrompt instance={claudeUpdateInstance} onRetry={onRetry} />
        ) : isProviderSafetyBlock(message) ? (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
            {PROVIDER_SAFETY_GUIDANCE}{" "}
            <a href={PROVIDER_SAFETY_HELP_URL} target="_blank" rel="noreferrer" className="underline">About provider safety checks</a>
          </p>
        ) : setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="mt-1.5 flex items-center gap-1.5 rounded-full border border-danger/30 px-2.5 py-1 text-[12.5px] hover:bg-danger/15"
            >
              <RefreshCw size={12} /> {t("chat.retry")}
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** Only a local, editable Claude Code engine can be updated from chat; a
 * company-managed one is the organisation's to update. */
export function claudeUpdateTarget(engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return engine?.driverKind === "claudeAgent" && !engine.readOnly ? engine : undefined;
}
