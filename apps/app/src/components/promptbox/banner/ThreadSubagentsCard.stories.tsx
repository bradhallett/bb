import { useState } from "react";
import type { ThreadSubagent } from "@bb/domain";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import { ThreadSubagentsCard } from "./ThreadSubagentsCard";

export default {
  title: "promptbox/banner/Subagents Card",
};

function Stage({ children }: { children: React.ReactNode }) {
  return <div className="w-full max-w-[760px]">{children}</div>;
}

const roster: ThreadSubagent[] = [
  {
    id: "agent_writer",
    label: "Writer",
    state: "running",
    summary: "Drafting the migration notes for the roster event",
    transcriptRef: null,
  },
  {
    id: "agent_audit",
    label: "Audit",
    state: "idle",
    summary: "Waiting on the writer to finish the first pass",
    transcriptRef: null,
  },
  {
    id: "agent_anchor",
    label: "Anchor",
    state: "parked",
    summary: null,
    transcriptRef: null,
  },
  {
    id: "agent_sentry",
    label: "Sentry",
    state: "aborted",
    summary: "Stopped after the worktree vanished",
    transcriptRef: null,
  },
];

function ToggleableSubagentsCard({
  agents,
  initiallyExpanded = false,
}: {
  agents: ThreadSubagent[] | null;
  initiallyExpanded?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(initiallyExpanded);
  return (
    <ThreadSubagentsCard
      agents={agents}
      isExpanded={isExpanded}
      onToggle={() => setIsExpanded((value) => !value)}
    />
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow label="Collapsed">
        <Stage>
          <ToggleableSubagentsCard agents={roster} />
        </Stage>
      </StoryRow>
      <StoryRow label="Expanded">
        <Stage>
          <ToggleableSubagentsCard agents={roster} initiallyExpanded />
        </Stage>
      </StoryRow>
      <StoryRow label="No roster snapshot">
        <Stage>
          <ToggleableSubagentsCard agents={null} initiallyExpanded />
        </Stage>
      </StoryRow>
    </StoryCard>
  );
}
