CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"priority" integer NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"requested_by" uuid,
	"uses_own_key" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_senders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"provider" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"key_hint" text NOT NULL,
	"from_address" text NOT NULL,
	"last_error" text,
	"failing_since" timestamp with time zone,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_senders_user_unique" UNIQUE NULLS NOT DISTINCT("user_id")
);
--> statement-breakpoint
CREATE TABLE "email_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_invites" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "email_daily_budget" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "email_monthly_budget" integer DEFAULT 2800 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "user_monthly_allowance" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "brand_name" text DEFAULT 'Kankan' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "brand_color" text DEFAULT '#3b5bdb' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "email_footer" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_senders" ADD CONSTRAINT "email_senders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_senders" ADD CONSTRAINT "email_senders_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_tokens" ADD CONSTRAINT "email_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_outbox_due_idx" ON "email_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "email_outbox_requested_idx" ON "email_outbox" USING btree ("requested_by","created_at");--> statement-breakpoint
CREATE INDEX "email_outbox_created_idx" ON "email_outbox" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "email_tokens_user_idx" ON "email_tokens" USING btree ("user_id");