ALTER TABLE "calendar_connections" ADD COLUMN "granted_scopes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD COLUMN "calendar_ids" jsonb;