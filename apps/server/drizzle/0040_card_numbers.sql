-- Card numbers (see packages/model/src/refs.ts). This only adds: columns, a table and indexes. Nothing is filled in here: the
-- letters and numbers of what exists already are given by the server as it starts (src/boards/numbering.ts), since the
-- order of cards made in one moment is the order the outline shows them, which is worked out in code.
CREATE TABLE "task_moves" (
	"from_board_id" text NOT NULL,
	"from_task_id" text NOT NULL,
	"from_number" integer,
	"to_board_id" text NOT NULL,
	"to_task_id" text NOT NULL,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_moves_from_board_id_from_task_id_pk" PRIMARY KEY("from_board_id","from_task_id")
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "past_codes" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "next_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "task_moves" ADD CONSTRAINT "task_moves_from_board_id_boards_id_fk" FOREIGN KEY ("from_board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_moves" ADD CONSTRAINT "task_moves_to_board_id_boards_id_fk" FOREIGN KEY ("to_board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_moves_number_idx" ON "task_moves" USING btree ("from_board_id","from_number");--> statement-breakpoint
CREATE INDEX "task_moves_to_idx" ON "task_moves" USING btree ("to_board_id","to_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "boards_code_idx" ON "boards" USING btree ("workspace_id","code") WHERE "boards"."workspace_id" is not null and "boards"."code" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_number_idx" ON "tasks" USING btree ("board_id","number") WHERE "tasks"."number" is not null;--> statement-breakpoint
CREATE INDEX "tasks_unnumbered_idx" ON "tasks" USING btree ("board_id") WHERE "tasks"."number" is null;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_code_check" CHECK ("boards"."code" is null or "boards"."code" ~ '^[A-Z][A-Z0-9]{1,4}$');