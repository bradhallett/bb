// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ThreadSubagent } from "@bb/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadSubagentsCard } from "./ThreadSubagentsCard";

function makeAgent(
  overrides: Partial<ThreadSubagent> = {},
): ThreadSubagent {
  return {
    id: "agent_scout",
    label: "Scout",
    state: "running",
    summary: null,
    transcriptRef: null,
    ...overrides,
  };
}

afterEach(cleanup);

describe("ThreadSubagentsCard", () => {
  it("renders one row per agent with its state and summary from the snapshot", () => {
    render(
      <ThreadSubagentsCard
        agents={[
          makeAgent({
            id: "agent_scout",
            label: "Scout",
            state: "running",
            summary: "Tracing the callers of buildApprovalSubject",
          }),
          makeAgent({
            id: "agent_sentry",
            label: "Sentry",
            state: "aborted",
            summary: null,
          }),
        ]}
        isExpanded
        onToggle={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Subagents: 1 of 2 agents running" }),
    ).toBeTruthy();
    const scout = screen.getByTitle("Scout").closest("li");
    expect(scout?.textContent).toContain("running");
    expect(scout?.textContent).toContain("Tracing the callers");
    const sentry = screen.getByTitle("Sentry").closest("li");
    expect(sentry?.textContent).toContain("aborted");
  });

  it("sorts rows by state so live agents surface above parked and aborted ones", () => {
    const { container } = render(
      <ThreadSubagentsCard
        agents={[
          makeAgent({ id: "agent_sentry", label: "Sentry", state: "aborted" }),
          makeAgent({ id: "agent_anchor", label: "Anchor", state: "parked" }),
          makeAgent({ id: "agent_scout", label: "Scout", state: "running" }),
          makeAgent({ id: "agent_drift", label: "Drift", state: "idle" }),
        ]}
        isExpanded
        onToggle={() => {}}
      />,
    );

    expect(
      Array.from(container.querySelectorAll("li")).map(
        (row) => row.textContent,
      ),
    ).toEqual(["Scoutrunning", "Driftidle", "Anchorparked", "Sentryaborted"]);
  });

  it("stays hidden without a roster snapshot and for an empty roster", () => {
    const { container, rerender } = render(
      <ThreadSubagentsCard agents={null} isExpanded onToggle={() => {}} />,
    );

    expect(container.querySelector("section")).toBeNull();

    rerender(
      <ThreadSubagentsCard agents={[]} isExpanded onToggle={() => {}} />,
    );

    expect(container.querySelector("section")).toBeNull();
    expect(screen.queryByRole("button", { name: /Subagents/ })).toBeNull();
  });

  it("collapses and expands its roster body from the header toggle", () => {
    const onToggle = vi.fn();
    render(
      <ThreadSubagentsCard
        agents={[makeAgent()]}
        isExpanded={false}
        onToggle={onToggle}
      />,
    );

    const toggle = screen.getByRole("button", {
      name: "Subagents: 1 of 1 agent running",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
