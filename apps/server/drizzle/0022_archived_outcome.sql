ALTER TABLE "tasks" ADD COLUMN "archived_list" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "archived_done" boolean;--> statement-breakpoint
-- Cards archived before this: keep the list they're in now as where they were archived from.
UPDATE "tasks" AS t SET "archived_list" = l."name", "archived_done" = (l."category" = 'done') FROM "lists" AS l WHERE t."archived_at" IS NOT NULL AND l."board_id" = t."board_id" AND l."id" = t."status";
