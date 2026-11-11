// Identity: avatar, name, title, and the short blurb every roster and the
// phone show.
import { useStore, type Bot } from "@/state/store";
import type { MausMotion, MausState } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { BOT_PROFILE_LIMITS } from "../../../shared/bot-profile";
import { BotProfileAvatarCard } from "../BotProfileAvatarCard";
import { Field, inputCls } from "./field";
import type { BotPatch } from "./useBotSettingsDerived";
import { useBotEditor } from "./BotEditorContext";
import { PackageProvenance } from "./PackageProvenance";
import { ProposalStatus } from "./ProposalStatus";
import { randomBotName } from "@/lib/random-bot-name";
import { t } from "@/lib/i18n";

export function IdentitySection({
  bot,
  patch,
  activeState,
  mascotMotion,
  namePlaceholder,
}: {
  bot: Bot;
  patch: (patch: BotPatch) => void;
  activeState: MausState;
  mascotMotion: { kind: Exclude<MausMotion, "none">; nonce: number } | null;
  namePlaceholder?: string;
}) {
  const { draft } = useBotEditor();
  const { state } = useStore();

  return (
    <div className="flex flex-col gap-4">
      <BotProfileAvatarCard bot={bot} activeState={activeState} mascotMotion={mascotMotion} onPatch={patch} />
      <PackageProvenance bot={bot} />

      <div>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <label htmlFor={`bot-name-${bot.id}`} className="text-[13px] text-ink-secondary">Name</label>
          {draft && <div className="flex flex-wrap gap-1">
            {(["female", "male"] as const).map(kind => <button
              key={kind}
              type="button"
              className="rounded-md px-2 py-1 text-xs text-ink-secondary hover:bg-control hover:text-ink"
              onClick={() => patch({ name: randomBotName(kind, bot.name, state.bots.map(existing => existing.name)) })}
            >{t(kind === "female" ? "newBot.randomFemaleName" : "newBot.randomMaleName")}</button>)}
          </div>}
        </div>
        <ProposalStatus bot={bot} kind="chief" />
        <input
          id={`bot-name-${bot.id}`}
          className={inputCls}
          maxLength={BOT_PROFILE_LIMITS.name}
          value={bot.name}
          placeholder={namePlaceholder}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </div>
      <Field label="Title">
        <ProposalStatus bot={bot} kind="chief" />
        <input
          className={inputCls}
          maxLength={BOT_PROFILE_LIMITS.title}
          placeholder="Describe what your agent does"
          value={bot.title}
          onChange={(e) => patch({ title: e.target.value })}
        />
      </Field>
      <div className="block">
        <label htmlFor={`bot-instructions-${bot.id}`} className="mb-1.5 block text-[13px] text-ink-secondary">
          Blurb
        </label>
        <ProposalStatus bot={bot} kind="chief" />
        <textarea
          id={`bot-instructions-${bot.id}`}
          className={cn(inputCls, "min-h-[72px] resize-y leading-relaxed")}
          maxLength={BOT_PROFILE_LIMITS.description}
          placeholder="One line on what this bot is for"
          aria-label="Blurb"
          value={bot.description}
          onChange={(e) => patch({ description: e.target.value })}
        />
        <div className="mt-1.5 flex items-start justify-between gap-3 text-[11px] text-ink-secondary">
          <span>Shown in rosters, on the phone, and to other bots.</span>
          {/* The cap only matters when someone is near it; a counter under a
              one-line field otherwise reads as an invitation to fill it. */}
          {bot.description.length > 3_000 && (
            <span className="shrink-0 tabular-nums">
              {bot.description.length.toLocaleString()} / {BOT_PROFILE_LIMITS.description.toLocaleString()}
            </span>
          )}
        </div>
      </div>

    </div>
  );
}
