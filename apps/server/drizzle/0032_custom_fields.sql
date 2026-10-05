CREATE TABLE "board_fields" (
	"board_id" text NOT NULL,
	"field_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"front" boolean DEFAULT false NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "board_fields_board_id_field_id_pk" PRIMARY KEY("board_id","field_id")
);
--> statement-breakpoint
CREATE TABLE "fields" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"owner_id" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fields_space_check" CHECK (("fields"."workspace_id" is null) <> ("fields"."owner_id" is null))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "custom" jsonb;--> statement-breakpoint
ALTER TABLE "board_fields" ADD CONSTRAINT "board_fields_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_fields" ADD CONSTRAINT "board_fields_field_id_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fields" ADD CONSTRAINT "fields_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_fields_field_idx" ON "board_fields" USING btree ("field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fields_workspace_name_idx" ON "fields" USING btree ("workspace_id",lower("name")) WHERE "fields"."workspace_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "fields_owner_name_idx" ON "fields" USING btree ("owner_id",lower("name")) WHERE "fields"."owner_id" is not null;