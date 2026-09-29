ALTER TABLE "board_activity" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "priority" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "inbox_board_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_inbox_board_id_boards_id_fk" FOREIGN KEY ("inbox_board_id") REFERENCES "public"."boards"("id") ON DELETE set null ON UPDATE no action;