CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"task_id" text NOT NULL,
	"user_id" uuid,
	"day" date NOT NULL,
	"minutes" integer NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"edited_by" uuid,
	"via" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_entries_minutes_check" CHECK ("time_entries"."minutes" between 1 and 1440)
);
--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_entries_task_idx" ON "time_entries" USING btree ("board_id","task_id");--> statement-breakpoint
CREATE INDEX "time_entries_board_user_idx" ON "time_entries" USING btree ("board_id","user_id");--> statement-breakpoint
CREATE INDEX "time_entries_user_day_idx" ON "time_entries" USING btree ("user_id","day");