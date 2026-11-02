CREATE TYPE "public"."capture_kind" AS ENUM('voice', 'text', 'link');--> statement-breakpoint
CREATE TYPE "public"."capture_status" AS ENUM('open', 'done', 'archived');--> statement-breakpoint
CREATE TYPE "public"."category" AS ENUM('jobs', 'automata', 'projects', 'learning', 'lifestyle', 'other');--> statement-breakpoint
CREATE TYPE "public"."category_source" AS ENUM('auto', 'manual', 'fallback');--> statement-breakpoint
CREATE TYPE "public"."classification_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "capture_kind" NOT NULL,
	"title" text,
	"title_manual" boolean DEFAULT false NOT NULL,
	"text" text NOT NULL,
	"original_text" text NOT NULL,
	"url" text,
	"category" "category" DEFAULT 'other' NOT NULL,
	"category_source" "category_source" DEFAULT 'fallback' NOT NULL,
	"classification_status" "classification_status" DEFAULT 'pending' NOT NULL,
	"classification_attempts" integer DEFAULT 0 NOT NULL,
	"status" "capture_status" DEFAULT 'open' NOT NULL,
	"duration_ms" integer,
	"device" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "captures_owner_client_idx" ON "captures" USING btree ("owner_id","client_id");--> statement-breakpoint
CREATE INDEX "captures_owner_status_created_idx" ON "captures" USING btree ("owner_id","status","created_at");--> statement-breakpoint
CREATE INDEX "captures_classification_idx" ON "captures" USING btree ("classification_status") WHERE "captures"."classification_status" <> 'done';--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");