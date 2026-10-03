ALTER TABLE "planning_blocks" ADD COLUMN "slot" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "planning_projects" ADD COLUMN "open_lines" smallint DEFAULT 1 NOT NULL;