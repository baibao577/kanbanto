CREATE TABLE "description_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"task_id" text NOT NULL,
	"text" text NOT NULL,
	"by" uuid,
	"via" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "description_versions" ADD CONSTRAINT "description_versions_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "description_versions" ADD CONSTRAINT "description_versions_by_users_id_fk" FOREIGN KEY ("by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "description_versions_task_idx" ON "description_versions" USING btree ("board_id","task_id","at");