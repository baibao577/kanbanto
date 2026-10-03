ALTER TABLE "planning_projects" ADD COLUMN "board_id" text;--> statement-breakpoint
ALTER TABLE "planning_projects" ADD CONSTRAINT "planning_projects_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "planning_projects_board_idx" ON "planning_projects" USING btree ("board_id");