// Beat: the roster. Walks the sidebar's bots one by one — who each is and
// what it is for — because a messaging app is easier to trust once you know
// who you are talking to. The rows come from the bot records themselves
// (agentRoster), so this is always the workspace's real roster, including a
// bot a teammate added, and never a list that can drift from it.
//
// What it deliberately does not claim: per-bot capability grants. Those are
// bound to a seeded role server-side and `relayAgent` never reaches the
// client, so anything more specific here would be a guess. Each agent's
// description is the server's own sentence about what it does.
import { MausAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { agentRoster } from "@/lib/onboarding";
import { useStore, type Bot } from "@/state/store";
import { PrimaryButton, staggerIndex, type BeatProps } from "./shared";

export function TeamBeat({ onNext }: BeatProps) {
  const { state } = useStore();
  const roster = agentRoster(state.bots);

  return (
    <div className="stagger mt-4 flex flex-col gap-2.5">
      <p className="animate-rise text-center text-[13.5px] leading-relaxed text-ink-secondary" style={staggerIndex(0)}>
        {t("onboarding.team.intro")}
      </p>

      {roster.map((entry, index) => (
        <RosterRow key={entry.id} entry={entry} bot={state.bots.find((b) => b.id === entry.id)} index={index + 1} />
      ))}

      {roster.length === 0 && (
        <p className="animate-rise mt-2 text-center text-[13px] text-ink-tertiary" style={staggerIndex(1)}>
          {t("onboarding.team.empty")}
        </p>
      )}

      <PrimaryButton onClick={onNext} className="animate-rise mt-4" style={staggerIndex(roster.length + 1)}>
        {t("onboarding.team.done")}
      </PrimaryButton>
    </div>
  );
}

function RosterRow({ entry, bot, index }: { entry: ReturnType<typeof agentRoster>[number]; bot: Bot | undefined; index: number }) {
  return (
    <div
      className="animate-rise flex items-start gap-3 rounded-xl border border-hairline/40 bg-inset/40 px-3.5 py-3"
      style={staggerIndex(index)}
    >
      <MausAvatar
        color={bot?.color ?? "green"}
        state="happy"
        size={34}
        trackPointer={false}
        label={entry.name}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[14px] font-semibold text-ink">{entry.name}</span>
          {entry.title && <span className="shrink-0 text-[11.5px] text-ink-tertiary">{entry.title}</span>}
        </div>
        {entry.description && (
          <p className={cn("mt-1 text-[12.5px] leading-relaxed text-ink-secondary")}>{entry.description}</p>
        )}
      </div>
    </div>
  );
}