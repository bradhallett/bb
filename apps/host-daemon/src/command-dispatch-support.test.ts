import { AgentRuntimeRecoveryError } from "@bb/agent-runtime";
import { describe, expect, it } from "vitest";
import {
  CommandDispatchError,
  isExpectedOnlineRpcFailureError,
} from "./command-dispatch-support.js";

const ACP_MODEL_LIST_AUTH_MESSAGE = "ACP agent is not authenticated.";

/**
 * The error `provider.list_models` surfaces when an ACP bridge rejects the
 * model probe with a typed `authRequired` recovery hint: the agent runtime
 * turns that into an `AgentRuntimeRecoveryError` whose string `code` the
 * daemon's `getErrorCode` reads. Constructed exactly as the runtime does, so
 * this test fails if the classifier ever returns to message-shape matching.
 */
function createAcpAuthRequiredError(): AgentRuntimeRecoveryError {
  return new AgentRuntimeRecoveryError({
    code: "auth_required",
    message: ACP_MODEL_LIST_AUTH_MESSAGE,
    recovery: {
      kind: "authRequired",
      message: ACP_MODEL_LIST_AUTH_MESSAGE,
      providerId: "acp-cursor",
      retryable: false,
    },
    cause: new Error("Authentication required."),
  });
}

describe("command dispatch support", () => {
  it("classifies oversized file reads as expected RPC failures", () => {
    expect(
      isExpectedOnlineRpcFailureError(
        new CommandDispatchError("file_too_large", "File exceeds the limit"),
      ),
    ).toBe(true);
  });

  it("classifies typed auth_required recovery failures as expected RPC failures", () => {
    expect(isExpectedOnlineRpcFailureError(createAcpAuthRequiredError())).toBe(
      true,
    );
  });

  it("keeps unclassified failures unexpected", () => {
    expect(isExpectedOnlineRpcFailureError(new Error("boom"))).toBe(false);
    expect(
      isExpectedOnlineRpcFailureError(
        new CommandDispatchError(
          "provider_bridge_unavailable",
          "No plugin host artifact fetcher configured",
        ),
      ),
    ).toBe(false);
  });
});
