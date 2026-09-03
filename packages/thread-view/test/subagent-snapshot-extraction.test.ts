import { threadScope, type ThreadSubagent } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { buildThreadTimelineFromEvents } from "../src/index.js";
import { EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT } from "../src/accepted-client-request-context.js";
import type { ThreadEventWithMeta } from "../src/build-event-projection.js";
import { extractThreadTimelineSubagents } from "../src/subagent-snapshot-extraction.js";

function subagentsEvent(
  seq: number,
  agents: readonly ThreadSubagent[],
): ThreadEventWithMeta {
  return {
    event: {
      type: "thread/subagents/updated",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: threadScope(),
      agents: [...agents],
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq * 100,
    },
  };
}

function extensionStateEvent(seq: number): ThreadEventWithMeta {
  return {
    event: {
      type: "thread/extensionState/updated",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: threadScope(),
      kind: "provider-codex/goal",
      payload: { objective: "Unrelated" },
    },
    meta: {
      id: `event-${seq}`,
      seq,
      createdAt: seq * 100,
    },
  };
}

const ROSTER_A: readonly ThreadSubagent[] = [
  {
    id: "agent-1",
    label: "Scout",
    state: "running",
    summary: "Reading tree",
    transcriptRef: null,
  },
];

const ROSTER_B: readonly ThreadSubagent[] = [
  {
    id: "agent-1",
    label: "Scout",
    state: "idle",
    summary: null,
    transcriptRef: null,
  },
  {
    id: "agent-2",
    label: "Runner",
    state: "parked",
    summary: "Waiting",
    transcriptRef: "provider-thread-2",
  },
];

describe("extractThreadTimelineSubagents", () => {
  it("returns the latest snapshot, replacing the one before it", () => {
    expect(
      extractThreadTimelineSubagents([
        subagentsEvent(1, ROSTER_A),
        subagentsEvent(2, ROSTER_B),
      ]),
    ).toEqual(ROSTER_B);
  });

  it("picks the highest-seq snapshot even when rows arrive out of order", () => {
    expect(
      extractThreadTimelineSubagents([
        subagentsEvent(2, ROSTER_B),
        subagentsEvent(1, ROSTER_A),
      ]),
    ).toEqual(ROSTER_B);
  });

  it("keeps an explicitly empty roster distinct from no roster", () => {
    expect(
      extractThreadTimelineSubagents([
        subagentsEvent(1, ROSTER_A),
        subagentsEvent(2, []),
      ]),
    ).toEqual([]);
  });

  it("returns null when no roster event exists", () => {
    expect(extractThreadTimelineSubagents([extensionStateEvent(1)])).toBeNull();
  });
});

describe("extractThreadTimelineSubagents on the timeline", () => {
  function buildSubagents(isLatestPage: boolean) {
    return buildThreadTimelineFromEvents({
      acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
      contextWindowEvents: [],
      events: [subagentsEvent(1, ROSTER_B)],
      options: {
        includeNestedRows: false,
        includeProviderUnhandledOperations: false,
        isLatestPage,
        threadStatus: "idle",
        threadName: "",
        turnMessageDetail: "summary",
        workspaceRoot: null,
      },
    }).subagents;
  }

  it("exposes the roster on the latest page only", () => {
    expect(buildSubagents(true)).toEqual(ROSTER_B);
    expect(buildSubagents(false)).toBeNull();
  });
});
