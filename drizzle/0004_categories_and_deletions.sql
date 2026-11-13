CREATE TABLE "categories" (
	"owner_id" uuid NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_owner_id_id_pk" PRIMARY KEY("owner_id","id")
);
--> statement-breakpoint
CREATE TABLE "deleted_captures" (
	"capture_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"calendar_event" jsonb,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_captures" ADD CONSTRAINT "deleted_captures_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_owner_name_idx" ON "categories" USING btree ("owner_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "deleted_captures_owner_client_idx" ON "deleted_captures" USING btree ("owner_id","client_id");--> statement-breakpoint
-- The starting list, for every account. Same rows as DEFAULT_CATEGORIES in
-- src/shared/categories.ts (tests/categories.test.ts checks they match).
CREATE FUNCTION "seed_default_categories"(owner uuid) RETURNS void LANGUAGE sql AS $$
	INSERT INTO "categories" ("owner_id", "id", "name", "description", "position") VALUES
		(owner, 'jobs', 'Jobs', 'Offers & applications. His own job search: job offers, job boards, recruiters, applications, interviews, CV, follow-ups with employers.', 0),
		(owner, 'automata', 'Automata', 'Agency prospects & ideas. Automata, his automation and AI agency: prospects, client leads, sales pitches, offers and pricing for clients, agency website and marketing.', 1),
		(owner, 'projects', 'Projects', 'Tools, agents, small products. Things he builds for himself: personal tools, apps, agents, side projects, small products, technical ideas to implement.', 2),
		(owner, 'learning', 'Learning', 'Courses, concepts, resources. Learning material: courses, tutorials, articles, docs, concepts, books, talks, certifications to study.', 3),
		(owner, 'lifestyle', 'Lifestyle', 'Personal tasks & interests. Personal life: errands, sport, health, family, friends, home, travel, admin paperwork, hobbies.', 4),
		(owner, 'other', 'Other', 'Not sure where these go. Anything ambiguous, too short to tell, or fitting none of the above. When in doubt, choose other.', 1000)
	ON CONFLICT DO NOTHING;
$$;--> statement-breakpoint
SELECT "seed_default_categories"("id") FROM "users";--> statement-breakpoint
-- Accounts created later (the owner at boot, test accounts) get the same list, whatever code
-- path inserts them.
CREATE FUNCTION "users_seed_categories"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM "seed_default_categories"(NEW."id");
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_seed_categories" AFTER INSERT ON "users" FOR EACH ROW EXECUTE FUNCTION "users_seed_categories"();--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "category" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "category" SET DATA TYPE text USING "category"::text;--> statement-breakpoint
ALTER TABLE "captures" ALTER COLUMN "category" SET DEFAULT 'other';--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_owner_category_fk" FOREIGN KEY ("owner_id","category") REFERENCES "public"."categories"("owner_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP TYPE "public"."category";
