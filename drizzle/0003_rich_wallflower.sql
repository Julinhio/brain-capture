CREATE TABLE "capture_events" (
	"capture_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"extraction" text NOT NULL,
	"draft" jsonb NOT NULL,
	"reference_at" timestamp with time zone NOT NULL,
	"time_zone" text NOT NULL,
	"calendar_id" text,
	"google_event_id" text,
	"event_url" text,
	"last_error" jsonb,
	"created_in_calendar_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capture_events" ADD CONSTRAINT "capture_events_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capture_events" ADD CONSTRAINT "capture_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capture_events_owner_idx" ON "capture_events" USING btree ("owner_id");