CREATE TABLE "reminder_sends" (
	"board_id" text NOT NULL,
	"task_id" text NOT NULL,
	"reminder_id" text NOT NULL,
	"fire_at" timestamp with time zone NOT NULL,
	"user_id" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_sends_board_id_task_id_reminder_id_fire_at_pk" PRIMARY KEY("board_id","task_id","reminder_id","fire_at")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reminders" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reminder_emails" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder_sends" ADD CONSTRAINT "reminder_sends_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_sends" ADD CONSTRAINT "reminder_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminder_sends_user_idx" ON "reminder_sends" USING btree ("user_id","sent_at");