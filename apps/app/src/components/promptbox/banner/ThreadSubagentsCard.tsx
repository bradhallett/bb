import type { ThreadSubagent, ThreadSubagentState } from "@bb/domain";
import { AnimatedBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  activityIconClass,
  activityMetaClass,
  activityRowClass,
  activityTextClass,
  type ActivityRowState,
} from "@bb/shared-ui/activity-row-styles";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

const SUBAGENT_STATE_SORT_RANK: Record<ThreadSubagentState, number> = {
  running: 0,
  idle: 1,
  parked: 2,
  aborted: 3,
};

const SUBAGENT_STATE_ACTIVITY_STATE: Record<
  ThreadSubagentState,
  ActivityRowState
> = {
  running: "active",
  idle: "pending",
  parked: "muted",
  aborted: "failed",
};

const SUBAGENT_STATE_ICON_NAME: Record<ThreadSubagentState, IconName> = {
  running: "Play",
  idle: "Circle",
  parked: "Pause",
  aborted: "CircleX",
};

interface ThreadSubagentsCardProps {
  agents: ThreadSubagent[] | null;
  isExpanded: boolean;
  onToggle: () => void;
}

const BODY_ID = "thread-subagents-card-body";
const TOGGLE_ID = "thread-subagents-card-toggle";
const SUBAGENTS_HEADER_BUTTON_CLASS = activityRowClass(
  "active",
  "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-none px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-background/80",
);
const SUBAGENTS_ACTIVE_ROW_CLASS = "shadow-none ring-0";

function getSubagentsSummary(agents: readonly ThreadSubagent[]): {
  visible: string;
  aria: string;
} {
  let runningCount = 0;
  for (const agent of agents) {
    if (agent.state === "running") runningCount += 1;
  }
  return {
    visible: `${runningCount}/${agents.length} running`,
    aria: `${runningCount} of ${agents.length} ${
      agents.length === 1 ? "agent" : "agents"
    } running`,
  };
}

function SubagentRow({ agent }: { agent: ThreadSubagent }) {
  const activityState = SUBAGENT_STATE_ACTIVITY_STATE[agent.state];
  const isActive = activityState === "active";
  return (
    <li
      className={activityRowClass(
        activityState,
        cn(
          "flex min-w-0 items-start gap-2 text-xs",
          isActive && SUBAGENTS_ACTIVE_ROW_CLASS,
        ),
      )}
    >
      <Icon
        name={SUBAGENT_STATE_ICON_NAME[agent.state]}
        className={activityIconClass(
          activityState,
          "mt-0.5 size-3.5 shrink-0",
        )}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={activityTextClass(
              activityState,
              "min-w-0 flex-1 truncate text-left",
            )}
            title={agent.label}
          >
            {agent.label}
          </span>
          <span className={activityMetaClass(activityState, "shrink-0")}>
            {agent.state}
          </span>
        </div>
        {agent.summary ? (
          <span
            className="truncate text-left text-muted-foreground"
            title={agent.summary}
          >
            {agent.summary}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function SubagentsBody({ agents }: { agents: readonly ThreadSubagent[] }) {
  const ordered = [...agents].sort(
    (a, b) =>
      SUBAGENT_STATE_SORT_RANK[a.state] - SUBAGENT_STATE_SORT_RANK[b.state],
  );
  return (
    <ul className="max-h-40 space-y-1 overflow-y-auto px-2.5 pb-2 pt-2">
      {ordered.map((agent) => (
        <SubagentRow agent={agent} key={agent.id} />
      ))}
    </ul>
  );
}

export function ThreadSubagentsCard({
  agents,
  isExpanded,
  onToggle,
}: ThreadSubagentsCardProps) {
  if (!agents || agents.length === 0) {
    return null;
  }
  const summary = getSubagentsSummary(agents);
  return (
    <PromptStackCard
      ariaLabel="Subagents"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        <button
          type="button"
          id={TOGGLE_ID}
          aria-expanded={isExpanded}
          aria-controls={BODY_ID}
          aria-label={`Subagents: ${summary.aria}`}
          onClick={onToggle}
          className={SUBAGENTS_HEADER_BUTTON_CLASS}
        >
          <Icon
            name="Bot"
            className={activityIconClass("active", "size-3.5 shrink-0")}
            aria-hidden="true"
          />
          <span
            className={activityTextClass(
              "active",
              "min-w-0 flex-1 truncate text-left",
            )}
          >
            Subagents
          </span>
          <span
            className={activityMetaClass("active", "shrink-0 tabular-nums")}
          >
            {summary.visible}
          </span>
          <Icon
            name="ChevronDown"
            className={cn(
              activityIconClass("active"),
              "size-3.5 shrink-0 transition-transform duration-200",
              isExpanded && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </div>
      <AnimatedBody
        id={BODY_ID}
        labelledBy={TOGGLE_ID}
        isExpanded={isExpanded}
        collapsedBorder="none"
      >
        <SubagentsBody agents={agents} />
      </AnimatedBody>
    </PromptStackCard>
  );
}
