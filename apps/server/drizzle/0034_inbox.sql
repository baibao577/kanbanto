ALTER TABLE "boards" ADD COLUMN "inbox_of" uuid;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_inbox_of_users_id_fk" FOREIGN KEY ("inbox_of") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "boards_inbox_of_idx" ON "boards" USING btree ("inbox_of") WHERE "boards"."inbox_of" is not null;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_inbox_check" CHECK ("boards"."inbox_of" is null or ("boards"."visibility" = 'private' and "boards"."workspace_id" is null and "boards"."public_link" = false and "boards"."archived_at" is null));--> statement-breakpoint
-- The board each person had chosen as their Inbox becomes their Inbox for good, when it already was theirs alone:
-- in Personal, nobody else on it, no link, code or invite to it, not public, not archived.
UPDATE "boards" b SET "inbox_of" = u."id", "visibility" = 'private'
FROM "users" u
WHERE u."inbox_board_id" = b."id"
  AND b."workspace_id" IS NULL AND b."archived_at" IS NULL AND b."public_link" = false
  AND b."visibility" IN ('private', 'invited')
  AND (SELECT count(*) FROM "board_members" m WHERE m."board_id" = b."id") = 1
  AND EXISTS (SELECT 1 FROM "board_members" m WHERE m."board_id" = b."id" AND m."user_id" = u."id" AND m."role" = 'owner')
  AND NOT EXISTS (SELECT 1 FROM "board_invites" i WHERE i."board_id" = b."id" AND i."revoked_at" IS NULL);--> statement-breakpoint
-- Any other chosen board stays an ordinary board: that person gets a new Inbox the first time one is needed.
UPDATE "users" u SET "inbox_board_id" = NULL
WHERE u."inbox_board_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "boards" b WHERE b."id" = u."inbox_board_id" AND b."inbox_of" = u."id");
