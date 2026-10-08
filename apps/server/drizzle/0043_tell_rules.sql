CREATE TABLE "board_rule_mutes" (
	"rule_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "board_rule_mutes_rule_id_user_id_pk" PRIMARY KEY("rule_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "rule_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "said" jsonb;--> statement-breakpoint
ALTER TABLE "board_rule_mutes" ADD CONSTRAINT "board_rule_mutes_rule_id_board_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."board_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_rule_mutes" ADD CONSTRAINT "board_rule_mutes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_rule_mutes_user_idx" ON "board_rule_mutes" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_rule_id_board_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."board_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_rule_idx" ON "notifications" USING btree ("rule_id");