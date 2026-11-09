CREATE TABLE "docs_blob_namespace" (
	"database_fingerprint" varchar(64) PRIMARY KEY,
	"namespace" varchar(36) NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL
);
