CREATE TYPE "docs_agent_feedback_kind" AS ENUM('incorrect', 'missing', 'outdated', 'unclear', 'other', 'helpful', 'not_helpful');--> statement-breakpoint
CREATE TYPE "docs_agent_feedback_source" AS ENUM('page_widget', 'chat_answer', 'agent', 'mcp');--> statement-breakpoint
CREATE TYPE "docs_build_error_kind" AS ENUM('content', 'internal');--> statement-breakpoint
CREATE TYPE "docs_config_disposition" AS ENUM('supported', 'adapted', 'ignored', 'extended');--> statement-breakpoint
CREATE TYPE "docs_content_version_kind" AS ENUM('production', 'preview');--> statement-breakpoint
CREATE TYPE "docs_content_version_state" AS ENUM('building', 'ready', 'failed', 'superseded');--> statement-breakpoint
CREATE TYPE "docs_diagnostic_code" AS ENUM('config_dual', 'css_multiple', 'css_sanitized', 'css_oversize', 'unknown_field', 'field_invalid', 'js_snippet_rejected', 'logo_multiple', 'asset_missing', 'asset_oversize', 'icon_lib_unsupported', 'icon_unresolved', 'integration_unsupported', 'redirect_invalid', 'redirect_shadows_page', 'head_rejected', 'i18n_deferred', 'locale_shadowed', 'locale_unpartitioned', 'version_ambiguous', 'version_no_default', 'version_multiple_default', 'openapi_orphaned', 'openapi_ref_unresolved', 'theme_unmapped', 'content_suspect', 'link_broken', 'snippet_missing', 'component_unknown', 'esm_stripped', 'unsupported_field', 'freshness_partial', 'ssr_fallback');--> statement-breakpoint
CREATE TYPE "docs_diagnostic_severity" AS ENUM('info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "docs_layout_preset" AS ENUM('neutral', 'editorial', 'warm', 'verdant', 'aspen', 'dusk', 'contrast');--> statement-breakpoint
CREATE TYPE "docs_nav_source" AS ENUM('filesystem', 'config');--> statement-breakpoint
CREATE TYPE "docs_page_kind" AS ENUM('mdx', 'openapi');--> statement-breakpoint
CREATE TYPE "docs_site_analytics_mode" AS ENUM('tenant', 'off');--> statement-breakpoint
CREATE TYPE "docs_site_status" AS ENUM('provisioning', 'active', 'suspended');--> statement-breakpoint
CREATE TABLE "docs_site" (
	"id" varchar(36) PRIMARY KEY,
	"slug" varchar(63) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"repo_owner" varchar(255),
	"repo_name" varchar(255),
	"branch" varchar(255) DEFAULT 'main' NOT NULL,
	"subdir" text DEFAULT '' NOT NULL,
	"status" "docs_site_status" DEFAULT 'provisioning'::"docs_site_status" NOT NULL,
	"analytics_mode" "docs_site_analytics_mode" NOT NULL,
	"webmcp_enabled" boolean DEFAULT false NOT NULL,
	"current_version_id" varchar(36),
	"current_version_seq" bigint DEFAULT 0 NOT NULL,
	"ingest_seq" bigint DEFAULT 0 NOT NULL,
	"first_build_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_asset" (
	"id" varchar(36) PRIMARY KEY,
	"site_id" varchar(36) NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"path" text NOT NULL,
	"content_hash" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" bytea,
	"blob_url" text,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_content_version" (
	"id" varchar(36) PRIMARY KEY,
	"site_id" varchar(36) NOT NULL,
	"commit_sha" varchar(64) NOT NULL,
	"kind" "docs_content_version_kind" DEFAULT 'production'::"docs_content_version_kind" NOT NULL,
	"pr_number" integer,
	"seq" bigint NOT NULL,
	"status" "docs_content_version_state" DEFAULT 'building'::"docs_content_version_state" NOT NULL,
	"error" text,
	"error_kind" "docs_build_error_kind",
	"page_count" integer DEFAULT 0 NOT NULL,
	"pipeline_version" integer DEFAULT 0 NOT NULL,
	"config" jsonb,
	"theme_tokens" jsonb,
	"versions_manifest" jsonb,
	"redirects" jsonb,
	"seo" jsonb,
	"integrations" jsonb,
	"diagnostics" jsonb,
	"locales_manifest" jsonb,
	"theme_css" text,
	"font_css" text DEFAULT '' NOT NULL,
	"font_inputs" jsonb,
	"nav_source" "docs_nav_source",
	"layout_preset" "docs_layout_preset",
	"search_corpus" bytea,
	"search_corpus_url" text,
	"head_committed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"built_at" timestamp,
	CONSTRAINT "docs_content_version_ready_corpus_check" CHECK ("status" <> 'ready' or "search_corpus" is not null or "search_corpus_url" is not null)
);
--> statement-breakpoint
CREATE TABLE "docs_meta" (
	"id" varchar(36) PRIMARY KEY,
	"version_id" varchar(36) NOT NULL,
	"path" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_openapi_document" (
	"id" varchar(36) PRIMARY KEY,
	"version_id" varchar(36) NOT NULL,
	"site_id" varchar(36) NOT NULL,
	"doc_id" varchar(64) NOT NULL,
	"source_path" text NOT NULL,
	"spec_hash" varchar(64) NOT NULL,
	"label" varchar(255) NOT NULL,
	"base_path" text NOT NULL,
	"document" jsonb NOT NULL,
	"servers" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_page" (
	"id" varchar(36) PRIMARY KEY,
	"version_id" varchar(36) NOT NULL,
	"site_id" varchar(36) NOT NULL,
	"kind" "docs_page_kind" DEFAULT 'mdx'::"docs_page_kind" NOT NULL,
	"path" text NOT NULL,
	"version_label" text,
	"locale_label" text,
	"url" text NOT NULL,
	"served_url" text NOT NULL,
	"slugs" jsonb NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text,
	"icon" varchar(255),
	"hidden" boolean,
	"frontmatter" jsonb NOT NULL,
	"source" text NOT NULL,
	"compiled_js" text,
	"hast" jsonb,
	"rail_hast" jsonb,
	"processed_markdown" text NOT NULL,
	"code_examples" jsonb DEFAULT '[]' NOT NULL,
	"openapi_props" jsonb,
	"updates" jsonb,
	"structured_data" jsonb NOT NULL,
	"toc" jsonb NOT NULL,
	"last_modified" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_skill" (
	"id" varchar(36) PRIMARY KEY,
	"site_id" varchar(36) NOT NULL,
	"version_id" varchar(36) NOT NULL,
	"name" varchar(64) NOT NULL,
	"description" text NOT NULL,
	"frontmatter" jsonb NOT NULL,
	"body" text NOT NULL,
	"digest" varchar(71) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs_agent_feedback" (
	"id" varchar(36) PRIMARY KEY,
	"site_id" varchar(36) NOT NULL,
	"version_id" varchar(36),
	"page_url" text NOT NULL,
	"page_exists" boolean NOT NULL,
	"kind" "docs_agent_feedback_kind" NOT NULL,
	"source" "docs_agent_feedback_source" NOT NULL,
	"message" text,
	"suggested_fix" text,
	"agent_name" varchar(255),
	"agent_kind" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_rate_limit" (
	"id" varchar(36) PRIMARY KEY,
	"bucket" varchar(96) NOT NULL,
	"key" varchar(160) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "docs_site_slug_uidx" ON "docs_site" ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "docs_asset_version_path_uidx" ON "docs_asset" ("version_id","path");--> statement-breakpoint
CREATE INDEX "docs_asset_version_hash_idx" ON "docs_asset" ("version_id","content_hash");--> statement-breakpoint
CREATE INDEX "docs_asset_site_hash_idx" ON "docs_asset" ("site_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "docs_content_version_site_sha_kind_uidx" ON "docs_content_version" ("site_id","commit_sha","kind") WHERE "status" <> 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX "docs_content_version_site_seq_uidx" ON "docs_content_version" ("site_id","seq");--> statement-breakpoint
CREATE INDEX "docs_content_version_site_kind_pr_idx" ON "docs_content_version" ("site_id","kind","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX "docs_meta_version_path_uidx" ON "docs_meta" ("version_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "docs_openapi_document_version_docid_uidx" ON "docs_openapi_document" ("version_id","doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "docs_page_version_path_uidx" ON "docs_page" ("version_id","path");--> statement-breakpoint
CREATE INDEX "docs_page_version_served_url_idx" ON "docs_page" ("version_id","served_url");--> statement-breakpoint
CREATE INDEX "docs_page_version_lower_served_url_idx" ON "docs_page" ("version_id",lower("served_url"));--> statement-breakpoint
CREATE UNIQUE INDEX "docs_skill_version_name_uidx" ON "docs_skill" ("version_id","name");--> statement-breakpoint
CREATE INDEX "docs_agent_feedback_site_created_idx" ON "docs_agent_feedback" ("site_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "public_rate_limit_bucket_key_uidx" ON "public_rate_limit" ("bucket","key");--> statement-breakpoint
CREATE INDEX "public_rate_limit_reset_at_idx" ON "public_rate_limit" ("reset_at");--> statement-breakpoint
ALTER TABLE "docs_site" ADD CONSTRAINT "docs_site_current_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "docs_content_version"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "docs_asset" ADD CONSTRAINT "docs_asset_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "docs_site"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_asset" ADD CONSTRAINT "docs_asset_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "docs_content_version"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_content_version" ADD CONSTRAINT "docs_content_version_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "docs_site"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_meta" ADD CONSTRAINT "docs_meta_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "docs_content_version"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_openapi_document" ADD CONSTRAINT "docs_openapi_document_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "docs_content_version"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_openapi_document" ADD CONSTRAINT "docs_openapi_document_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "docs_site"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_page" ADD CONSTRAINT "docs_page_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "docs_content_version"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_page" ADD CONSTRAINT "docs_page_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "docs_site"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_skill" ADD CONSTRAINT "docs_skill_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "docs_content_version"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_skill" ADD CONSTRAINT "docs_skill_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "docs_site"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_agent_feedback" ADD CONSTRAINT "docs_agent_feedback_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "docs_site"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "docs_agent_feedback" ADD CONSTRAINT "docs_agent_feedback_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "docs_content_version"("id") ON DELETE SET NULL;