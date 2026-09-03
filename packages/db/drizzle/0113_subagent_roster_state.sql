DROP INDEX `events_thread_state_thread_sequence_idx`;--> statement-breakpoint
CREATE INDEX `events_thread_state_thread_sequence_idx` ON `events` (`thread_id`,`sequence`) WHERE "events"."type" IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated', 'thread/subagents/updated');--> statement-breakpoint
ALTER TABLE `pending_interactions` ADD `agent_label` text;