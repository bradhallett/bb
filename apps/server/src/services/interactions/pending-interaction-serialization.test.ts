import { describe, expect, it } from "vitest";
import type { PendingInteractionRow } from "@bb/db";
import { toPendingInteraction } from "./pending-interaction-serialization.js";

function providerRow(
  overrides: Partial<PendingInteractionRow> = {},
): PendingInteractionRow {
  return {
    id: "pi_test",
    threadId: "thr_test",
    turnId: "turn_test",
    status: "pending",
    createdAt: 1,
    resolvedAt: null,
    expiresAt: null,
    updatedAt: 1,
    agentLabel: null,
    payload: JSON.stringify({
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item-1",
        command: "git push",
        cwd: "/tmp/project",
        actions: [],
        sessionGrant: null,
      },
      reason: null,
      availableDecisions: ["allow_once", "deny"],
    }),
    resolution: null,
    statusReason: null,
    originKind: "provider",
    providerId: "codex",
    providerThreadId: "provider-thread-1",
    providerRequestId: "request-1",
    pluginId: null,
    rendererId: null,
    ...overrides,
  };
}

describe("toPendingInteraction agent attribution", () => {
  it("carries a stored agent label onto the serialized interaction", () => {
    expect(
      toPendingInteraction(providerRow({ agentLabel: "Scout" })).agentLabel,
    ).toBe("Scout");
  });

  it("reads a stored null label as null, not undefined", () => {
    expect(toPendingInteraction(providerRow()).agentLabel).toBeNull();
  });
});
