CREATE TABLE "attachment_thumbs" (
	"attachment_id" uuid PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cover" uuid;--> statement-breakpoint
ALTER TABLE "attachment_thumbs" ADD CONSTRAINT "attachment_thumbs_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_cover_attachments_id_fk" FOREIGN KEY ("cover") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;