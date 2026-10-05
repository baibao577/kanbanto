CREATE TABLE "task_followers" (
	"board_id" text NOT NULL,
	"task_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"following" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_followers_board_id_task_id_user_id_pk" PRIMARY KEY("board_id","task_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "changes" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "push_follows" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "task_followers" ADD CONSTRAINT "task_followers_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_followers" ADD CONSTRAINT "task_followers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- People already part of a card's conversation follow it: whoever commented, and whoever was mentioned.
INSERT INTO "task_followers" ("board_id", "task_id", "user_id")
SELECT DISTINCT c."board_id", c."task_id", c."author_id" FROM "comments" c WHERE c."author_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "task_followers" ("board_id", "task_id", "user_id")
SELECT DISTINCT c."board_id", c."task_id", u."id" FROM "comments" c CROSS JOIN LATERAL unnest(c."mentions") AS m("id") JOIN "users" u ON u."id" = m."id"
ON CONFLICT DO NOTHING;
