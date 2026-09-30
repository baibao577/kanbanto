CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "push_devices_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "vapid_public_key" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "vapid_private_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "push_reminders" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "push_mentions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_devices_user_idx" ON "push_devices" USING btree ("user_id");