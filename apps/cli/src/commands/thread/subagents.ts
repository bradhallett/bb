import { Command } from "commander";
import type { ThreadSubagent } from "@bb/domain";
import type { ThreadSubagentsResult } from "@bb/sdk";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { renderBorderlessTable } from "../../table.js";
import { outputJson, requireThreadId } from "../helpers.js";

interface ThreadSubagentsCommandOptions {
  json?: boolean;
}

const SUBAGENT_COLUMN_HEADS: readonly string[] = ["State", "Label", "Summary"];

function formatSubagentRow(agent: ThreadSubagent): string[] {
  return [
    agent.state,
    agent.label,
    agent.summary === null ? "" : agent.summary,
  ];
}

/** Column width is the widest of head and every cell, so nothing wraps. */
function columnWidth(
  rows: string[][],
  index: number,
  headWidth: number,
): number {
  return Math.max(headWidth, ...rows.map((row) => row[index].length));
}

/**
 * A null roster means the provider never reported one, which reads as its own
 * answer rather than as an empty table: `null` prints explicitly so it cannot
 * be mistaken for a provider reporting zero subagents.
 */
export function printThreadSubagents(result: ThreadSubagentsResult): void {
  if (result === null) {
    console.log("Provider has not reported a subagent roster");
    return;
  }
  if (result.length === 0) {
    console.log("No subagents");
    return;
  }
  const rows = result.map(formatSubagentRow);
  console.log(
    renderBorderlessTable(
      {
        head: [...SUBAGENT_COLUMN_HEADS],
        colWidths: SUBAGENT_COLUMN_HEADS.map((head, index) =>
          columnWidth(rows, index, head.length),
        ),
      },
      rows,
    ),
  );
}

export function registerSubagentsCommand(
  parent: Command,
  getUrl: () => string,
): void {
  parent
    .command("subagents <id>")
    .description(
      "Show the subagent roster a provider last reported for a thread",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(
        async (id: string | undefined, opts: ThreadSubagentsCommandOptions) => {
          const result = await createCliBbSdk(getUrl()).threads.subagents({
            threadId: requireThreadId(id),
          });
          if (outputJson(opts, result)) return;
          printThreadSubagents(result);
        },
      ),
    );
}
