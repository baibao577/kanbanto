ALTER TABLE "attachments" ADD COLUMN "comment_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "draft" boolean DEFAULT false NOT NULL;