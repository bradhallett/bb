import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  environments,
  listOpenBackgroundTaskItemRowsForHost,
  listOpenBackgroundTaskItemRowsForThread,
  listThreadTurnInterruptionEventStates,
  threads,
  type DbNotifier,
  type DbTransaction,
  type OpenBackgroundTaskItemRow,
} from "@bb/db";
import {
  backgroundTaskItemStatus,
  isSettledBackgroundTaskStatus,
  threadEventBackgroundTaskItemSchema,
  threadScope,
  turnScope,
  type ThreadEventType,
} from "@bb/domain";
import type { ThreadEventBackgroundTaskItem } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import { appendThreadEventsInTransaction } from "./thread-events.js";

interface SettleDanglingBackgroundTasksArgs {
  hostId: string;
}

interface SettleDaemonRestartedThreadRunsArgs {
  hostId: string;
}

interface SettledDaemonRestartedThreadRun {
  interruptedTurnId: string | null;
  threadId: string;
}

type DaemonReconciliationDeps = Pick<AppDeps, "db" | "hub" | "logger">;
type ThreadEventAppendArgs = Parameters<
  typeof appendThreadEventsInTransaction
>[1][number];
type SettleDanglingBackgroundTasksTransactionDeps = {
  db: DbTransaction;
  hub: DbNotifier;
  logger: AppDeps["logger"];
};

const storedBackgroundTaskEventDataSchema = z.object({
  item: threadEventBackgroundTaskItemSchema,
});

function parseStoredBackgroundTaskItem(
  row: OpenBackgroundTaskItemRow,
): ThreadEventBackgroundTaskItem | null {
  try {
    const parsed = storedBackgroundTaskEventDataSchema.safeParse(
      JSON.parse(row.data),
    );
    return parsed.success ? parsed.data.item : null;
  } catch {
    return null;
  }
}

export function settleDanglingBackgroundTasks(
  deps: DaemonReconciliationDeps,
  args: SettleDanglingBackgroundTasksArgs,
): void {
  const rows = listOpenBackgroundTaskItemRowsForHost(deps.db, {
    hostId: args.hostId,
  });
  if (rows.length === 0) {
    return;
  }

  const settledThreadIds = new Set<string>();
  deps.db.transaction(
    (tx) => {
      for (const threadId of appendDanglingBackgroundTaskCompletions(
        { db: tx, logger: deps.logger },
        rows,
      )) {
        settledThreadIds.add(threadId);
      }
    },
    { behavior: "immediate" },
  );

  for (const threadId of settledThreadIds) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      eventTypes: ["item/backgroundTask/completed"],
    });
  }
}

export function settleDaemonRestartedThreadRunsForResume(
  deps: DaemonReconciliationDeps,
  args: SettleDaemonRestartedThreadRunsArgs,
): SettledDaemonRestartedThreadRun[] {
  const activeThreads = deps.db
    .select({
      environmentId: environments.id,
      threadId: threads.id,
    })
    .from(threads)
    .innerJoin(environments, eq(threads.environmentId, environments.id))
    .where(
      and(
        eq(environments.hostId, args.hostId),
        eq(threads.status, "active"),
        isNull(threads.deletedAt),
      ),
    )
    .all();
  if (activeThreads.length === 0) {
    return [];
  }

  const stateByThreadId = new Map(
    listThreadTurnInterruptionEventStates(deps.db, {
      threadIds: activeThreads.map((thread) => thread.threadId),
    }).map((state) => [state.threadId, state]),
  );
  const resumableThreads = activeThreads.filter((thread) => {
    const state = stateByThreadId.get(thread.threadId);
    return state !== undefined && state.latestProviderThreadId !== null;
  });
  if (resumableThreads.length === 0) {
    return [];
  }

  const results: SettledDaemonRestartedThreadRun[] = [];
  deps.db.transaction(
    (tx) => {
      for (const thread of resumableThreads) {
        const state = stateByThreadId.get(thread.threadId)!;
        const providerThreadId = state.latestProviderThreadId;
        const eventArgs: ThreadEventAppendArgs[] = [];
        if (state.activeTurnId !== null) {
          eventArgs.push({
            threadId: thread.threadId,
            environmentId: thread.environmentId,
            providerThreadId,
            type: "turn/completed",
            scope: turnScope(state.activeTurnId),
            data: {
              providerThreadId,
              status: "interrupted",
            },
          });
        }
        eventArgs.push({
          threadId: thread.threadId,
          type: "system/thread/interrupted",
          scope: threadScope(),
          data: {
            reason: "host-daemon-restarted",
          },
        });
        appendThreadEventsInTransaction(tx, eventArgs);

        applyLoggedThreadLifecycleEventInTransaction(
          { db: tx, logger: deps.logger },
          { event: { type: "stop.requested" }, threadId: thread.threadId },
        );
        applyLoggedThreadLifecycleEventInTransaction(
          { db: tx, logger: deps.logger },
          { event: { type: "stop.settled" }, threadId: thread.threadId },
        );
        results.push({
          interruptedTurnId: state.activeTurnId,
          threadId: thread.threadId,
        });
      }
    },
    { behavior: "immediate" },
  );

  for (const result of results) {
    const eventTypes: ThreadEventType[] = ["system/thread/interrupted"];
    if (result.interruptedTurnId !== null) {
      eventTypes.unshift("turn/completed");
    }
    deps.hub.notifyThread(
      result.threadId,
      ["events-appended", "status-changed"],
      { eventTypes },
    );
  }

  return results;
}
export function settleDanglingBackgroundTasksForStoppedThreadInTransaction(
  deps: SettleDanglingBackgroundTasksTransactionDeps,
  args: { threadId: string },
): void {
  const rows = listOpenBackgroundTaskItemRowsForThread(deps.db, args);
  const settledThreadIds = appendDanglingBackgroundTaskCompletions(deps, rows);
  for (const threadId of settledThreadIds) {
    deps.hub.notifyThread(threadId, ["events-appended"], {
      eventTypes: ["item/backgroundTask/completed"],
    });
  }
}

function appendDanglingBackgroundTaskCompletions(
  deps: Pick<SettleDanglingBackgroundTasksTransactionDeps, "db" | "logger">,
  rows: readonly OpenBackgroundTaskItemRow[],
): Set<string> {
  const settledThreadIds = new Set<string>();
  for (const row of rows) {
    const item = parseStoredBackgroundTaskItem(row);
    if (!item) {
      deps.logger.warn(
        { itemId: row.itemId, threadId: row.threadId },
        "Skipping dangling background task with unparsable item payload",
      );
      continue;
    }
    const providerThreadId = row.providerThreadId ?? "";
    const taskStatus = isSettledBackgroundTaskStatus(item.taskStatus)
      ? item.taskStatus
      : "stopped";
    appendThreadEventsInTransaction(deps.db, [
      {
        threadId: row.threadId,
        environmentId: row.environmentId,
        providerThreadId,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        data: {
          providerThreadId,
          item: {
            ...item,
            status: backgroundTaskItemStatus(taskStatus),
            taskStatus,
          },
        },
      },
    ]);
    settledThreadIds.add(row.threadId);
  }
  return settledThreadIds;
}
