import { describe, expect, it } from "vitest";
import { threadEventSchema, threadScope, turnScope } from "../src/index.js";

describe("thread/subagents/updated event", () => {
  const rosterEvent = {
    type: "thread/subagents/updated",
    threadId: "thr_123",
    providerThreadId: "provider-thread-123",
    scope: threadScope(),
    agents: [
      {
        id: "agent-alpha",
        label: "Scout",
        state: "running",
        summary: "Mapping the repository",
        transcriptRef: "tr_agent_alpha",
      },
      {
        id: "agent-beta",
        label: "Reviewer",
        state: "parked",
        summary: null,
        transcriptRef: null,
      },
    ],
  };

  it("parses a full roster snapshot at thread scope", () => {
    expect(threadEventSchema.parse(rosterEvent)).toEqual(rosterEvent);
  });

  it("allows an empty roster snapshot", () => {
    expect(
      threadEventSchema.safeParse({ ...rosterEvent, agents: [] }).success,
    ).toBe(true);
  });

  it("rejects an unknown subagent state", () => {
    expect(
      threadEventSchema.safeParse({
        ...rosterEvent,
        agents: [
          {
            id: "agent-alpha",
            label: "Scout",
            state: "sleeping",
            summary: null,
            transcriptRef: null,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty subagent id", () => {
    expect(
      threadEventSchema.safeParse({
        ...rosterEvent,
        agents: [
          {
            id: "",
            label: "Scout",
            state: "running",
            summary: null,
            transcriptRef: null,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects turn scope for a roster snapshot", () => {
    expect(
      threadEventSchema.safeParse({
        ...rosterEvent,
        scope: turnScope("turn_123"),
      }).success,
    ).toBe(false);
  });
});
