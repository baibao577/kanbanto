ALTER TABLE "board_invites" ADD COLUMN "link_shown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Invites made before this was tracked: assume the link may have been shown (the safe side).
UPDATE "board_invites" SET "link_shown" = true WHERE "kind" = 'email';
