ALTER TABLE "site_settings" ALTER COLUMN "email_daily_budget" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ALTER COLUMN "email_monthly_budget" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "site_settings" ALTER COLUMN "user_monthly_allowance" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_senders" ADD COLUMN "smtp" jsonb;