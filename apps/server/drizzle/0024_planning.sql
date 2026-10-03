CREATE TABLE "planning_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"person_id" uuid,
	"start" date NOT NULL,
	"end" date NOT NULL,
	"pct" smallint NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "planning_blocks_pct_check" CHECK ("planning_blocks"."pct" in (25, 50, 75, 100)),
	CONSTRAINT "planning_blocks_dates_check" CHECK ("planning_blocks"."start" <= "planning_blocks"."end")
);
--> statement-breakpoint
CREATE TABLE "planning_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planning_people" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"role_id" uuid,
	"hours_per_day" numeric(4, 1) DEFAULT 8 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planning_projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"client" text DEFAULT '' NOT NULL,
	"planned_md" numeric(9, 2),
	"color" text NOT NULL,
	"position" text NOT NULL,
	"finished_at" timestamp with time zone,
	"activity_at" timestamp with time zone,
	"activity_by" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planning_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planning_state" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "planner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "planning_blocks" ADD CONSTRAINT "planning_blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_blocks" ADD CONSTRAINT "planning_blocks_project_id_planning_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."planning_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_blocks" ADD CONSTRAINT "planning_blocks_person_id_planning_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."planning_people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_blocks" ADD CONSTRAINT "planning_blocks_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_lines" ADD CONSTRAINT "planning_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_lines" ADD CONSTRAINT "planning_lines_project_id_planning_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."planning_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_lines" ADD CONSTRAINT "planning_lines_person_id_planning_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."planning_people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_people" ADD CONSTRAINT "planning_people_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_people" ADD CONSTRAINT "planning_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_people" ADD CONSTRAINT "planning_people_role_id_planning_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."planning_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_projects" ADD CONSTRAINT "planning_projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_projects" ADD CONSTRAINT "planning_projects_activity_by_users_id_fk" FOREIGN KEY ("activity_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_roles" ADD CONSTRAINT "planning_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_state" ADD CONSTRAINT "planning_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "planning_blocks_workspace_idx" ON "planning_blocks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "planning_blocks_project_idx" ON "planning_blocks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "planning_blocks_person_idx" ON "planning_blocks" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "planning_lines_project_person_idx" ON "planning_lines" USING btree ("project_id","person_id");--> statement-breakpoint
CREATE INDEX "planning_lines_person_idx" ON "planning_lines" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "planning_people_workspace_idx" ON "planning_people" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "planning_people_user_idx" ON "planning_people" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "planning_projects_workspace_idx" ON "planning_projects" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "planning_roles_workspace_idx" ON "planning_roles" USING btree ("workspace_id");--> statement-breakpoint
-- Every workspace gets a plan: its change counter, and the roles a plan starts with.
INSERT INTO "planning_state" ("workspace_id") SELECT "id" FROM "workspaces";--> statement-breakpoint
INSERT INTO "planning_roles" ("id", "workspace_id", "name", "position", "created_at", "updated_at", "version")
SELECT gen_random_uuid(), w."id", r."name", r."position", now(), now(), 1
FROM "workspaces" AS w CROSS JOIN (VALUES ('SE', 'a0'), ('DE', 'a1'), ('SA', 'a2'), ('BA', 'a3')) AS r("name", "position");--> statement-breakpoint
-- Everyone in a workspace is in its plan.
INSERT INTO "planning_people" ("id", "workspace_id", "user_id", "name", "role_id", "hours_per_day", "created_at", "updated_at", "version")
SELECT gen_random_uuid(), m."workspace_id", m."user_id", u."name", NULL, 8, now(), now(), 1
FROM "workspace_members" AS m JOIN "users" AS u ON u."id" = m."user_id";
