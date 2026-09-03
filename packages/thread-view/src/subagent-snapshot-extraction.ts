import type { ThreadSubagent } from "@bb/domain";
import type { ThreadEventWithMeta } from "./build-event-projection.js";
import { getOrderedThreadEvents } from "./group-event-projection-turns.js";

export function extractThreadTimelineSubagents(
  events: readonly ThreadEventWithMeta[],
): ThreadSubagent[] | null {
  let best: { agents: ThreadSubagent[]; seq: number } | null = null;
  for (const { event, meta } of getOrderedThreadEvents(events)) {
    if (event.type !== "thread/subagents/updated") {
      continue;
    }
    if (best === null || meta.seq > best.seq) {
      best = { agents: [...event.agents], seq: meta.seq };
    }
  }
  return best === null ? null : best.agents;
}
