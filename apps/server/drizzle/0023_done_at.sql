ALTER TABLE "tasks" ADD COLUMN "done_at" timestamp with time zone;--> statement-breakpoint
-- Cards done before this was kept: the best guess there is. In a done list: their last real change (moving there, usually).
UPDATE "tasks" AS t SET "done_at" = coalesce(t."active_at", t."updated_at") FROM "lists" AS l WHERE t."archived_at" IS NULL AND l."board_id" = t."board_id" AND l."id" = t."status" AND l."category" = 'done';--> statement-breakpoint
-- Archived as completed: when they were archived.
UPDATE "tasks" SET "done_at" = "archived_at" WHERE "archived_at" IS NOT NULL AND "archived_done" = true;
