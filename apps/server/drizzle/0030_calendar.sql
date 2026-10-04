CREATE TABLE "calendar_boards" (
	"user_id" uuid NOT NULL,
	"board_id" text NOT NULL,
	"off" boolean DEFAULT false NOT NULL,
	"synced_seq" bigint,
	CONSTRAINT "calendar_boards_user_id_board_id_pk" PRIMARY KEY("user_id","board_id")
);
--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"google_email" text,
	"refresh_token_encrypted" text NOT NULL,
	"calendar_id" text,
	"last_error" text,
	"failing_since" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"user_id" uuid NOT NULL,
	"board_id" text NOT NULL,
	"task_id" text NOT NULL,
	"part" text NOT NULL,
	"event_id" text NOT NULL,
	"sent_hash" text,
	CONSTRAINT "calendar_events_user_id_board_id_task_id_part_pk" PRIMARY KEY("user_id","board_id","task_id","part")
);
--> statement-breakpoint
CREATE TABLE "calendar_feeds" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_feeds_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "calendar_links" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "google_client_id" text;--> statement-breakpoint
ALTER TABLE "site_settings" ADD COLUMN "google_client_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "calendar_boards" ADD CONSTRAINT "calendar_boards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_boards" ADD CONSTRAINT "calendar_boards_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;