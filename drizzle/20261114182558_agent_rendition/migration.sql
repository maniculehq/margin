ALTER TYPE "docs_diagnostic_code" ADD VALUE 'agent_rendition_orphaned';--> statement-breakpoint
ALTER TABLE "docs_page" ADD COLUMN "agent_markdown" text;