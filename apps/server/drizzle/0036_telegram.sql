CREATE TABLE "telegram_bots" (
	"webhook_id" uuid PRIMARY KEY NOT NULL,
	"bot_id" bigint NOT NULL,
	"bot_name" text NOT NULL,
	"chat_id" bigint,
	"chat_kind" text,
	"chat_name" text,
	"connected_by" bigint,
	"takes_cards" boolean DEFAULT true NOT NULL,
	"cards_to" text,
	"read_from" bigint,
	"problem" text
);
--> statement-breakpoint
CREATE TABLE "telegram_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"webhook_id" uuid NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_id" bigint NOT NULL,
	"answer_id" bigint,
	"board_id" text NOT NULL,
	"task_id" text NOT NULL,
	"writer_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"wrote" jsonb NOT NULL,
	"undone" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "telegram_bots" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "telegram_reminders" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "telegram_mentions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "telegram_follows" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "telegram_bots" ADD CONSTRAINT "telegram_bots_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_cards" ADD CONSTRAINT "telegram_cards_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_cards" ADD CONSTRAINT "telegram_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_bots_bot_idx" ON "telegram_bots" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "telegram_bots_chat_idx" ON "telegram_bots" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "telegram_cards_message_idx" ON "telegram_cards" USING btree ("webhook_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_cards_answer_idx" ON "telegram_cards" USING btree ("webhook_id","answer_id");