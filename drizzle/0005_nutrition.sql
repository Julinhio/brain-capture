CREATE TABLE "nutrition_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"source" text NOT NULL,
	"day" date NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"time_zone" text NOT NULL,
	"title" text NOT NULL,
	"original_text" text DEFAULT '' NOT NULL,
	"data" jsonb NOT NULL,
	"has_photo" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"device" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nutrition_photos" (
	"entry_id" uuid PRIMARY KEY NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nutrition_settings" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"kcal_goal" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "kept_as_note" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "captured_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "nutrition_entries" ADD CONSTRAINT "nutrition_entries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrition_photos" ADD CONSTRAINT "nutrition_photos_entry_id_nutrition_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."nutrition_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrition_settings" ADD CONSTRAINT "nutrition_settings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nutrition_entries_owner_client_idx" ON "nutrition_entries" USING btree ("owner_id","client_id");--> statement-breakpoint
CREATE INDEX "nutrition_entries_owner_day_idx" ON "nutrition_entries" USING btree ("owner_id","day");