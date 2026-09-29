CREATE TABLE "board_activity" (
	"id" uuid PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"command" text NOT NULL,
	"items" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_activity" ADD CONSTRAINT "board_activity_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_activity" ADD CONSTRAINT "board_activity_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_activity_board_idx" ON "board_activity" USING btree ("board_id","at");