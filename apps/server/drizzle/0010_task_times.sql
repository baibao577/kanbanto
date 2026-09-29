-- Start and due can now also be a moment with a time ("2026-10-15T07:30:00Z"). Existing dates keep their exact
-- YYYY-MM-DD form, whatever the database's date style.
ALTER TABLE "tasks" ALTER COLUMN "start" SET DATA TYPE text USING to_char("start", 'YYYY-MM-DD');--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "due" SET DATA TYPE text USING to_char("due", 'YYYY-MM-DD');
