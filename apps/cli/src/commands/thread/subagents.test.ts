import { describe, expect, it, vi } from "vitest";
import type { ThreadSubagent } from "@bb/domain";
import { printThreadSubagents } from "./subagents.js";

function captureLogLines(fn: () => void): { lines: string[] } {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    fn();
    const lines = spy.mock.calls
      .map((call) => String(call[0] ?? ""))
      .join("\n")
      .split("\n")
      .filter((line) => /[a-zA-Z0-9]/.test(line));
    return { lines };
  } finally {
    spy.mockRestore();
  }
}

const ROSTER: readonly ThreadSubagent[] = [
  {
    id: "agent-1",
    label: "Scout",
    state: "running",
    summary: "Reading tree",
    transcriptRef: null,
  },
];

describe("printThreadSubagents", () => {
  it("prints an explicit no-roster notice when the provider never reported one", () => {
    const { lines } = captureLogLines(() => printThreadSubagents(null));
    expect(lines).toEqual(["Provider has not reported a subagent roster"]);
  });

  it("prints a distinct notice for an observed-empty roster", () => {
    const { lines } = captureLogLines(() => printThreadSubagents([]));
    expect(lines).toEqual(["No subagents"]);
  });

  it("renders state, label, and summary columns for a reported roster", () => {
    const { lines } = captureLogLines(() => printThreadSubagents([...ROSTER]));
    expect(lines[0]).toContain("State");
    expect(lines[0]).toContain("Label");
    expect(lines[0]).toContain("Summary");
    expect(lines[1]).toContain("running");
    expect(lines[1]).toContain("Scout");
    expect(lines[1]).toContain("Reading tree");
  });

  it("leaves the summary cell empty when the agent has none", () => {
    const { lines } = captureLogLines(() =>
      printThreadSubagents([
        { ...ROSTER[0]!, summary: null },
      ]),
    );
    expect(lines[1]).toContain("Scout");
    expect(lines[1]).not.toContain("Reading tree");
  });
});
