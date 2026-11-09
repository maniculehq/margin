import { pgEnum } from "drizzle-orm/pg-core"
import {
    DOCS_AGENT_FEEDBACK_KINDS,
    DOCS_AGENT_FEEDBACK_SOURCES,
    DOCS_SITE_STATUSES,
} from "../../types/constants"
import {
    CONFIG_DISPOSITIONS,
    DIAGNOSTIC_CODES,
    DIAGNOSTIC_SEVERITIES,
    DOCS_BUILD_ERROR_KINDS,
    DOCS_CONTENT_VERSION_KINDS,
    DOCS_CONTENT_VERSION_STATUSES,
    DOCS_PAGE_KINDS,
    DOCS_SITE_ANALYTICS_MODES,
    LAYOUT_PRESETS,
    NAV_SOURCES,
} from "../../types/docs"

// Every closed set is declared once in src/types so Zod schemas and native
// Postgres enums share a single source of truth.

export const docsSiteStatusEnum = pgEnum("docs_site_status", DOCS_SITE_STATUSES)

export const docsSiteAnalyticsModeEnum = pgEnum(
    "docs_site_analytics_mode",
    DOCS_SITE_ANALYTICS_MODES,
)

// Named *_state (not *_status) to keep the pg type name distinct from the
// docs_content_version table's composite rowtype namespace neighbors.
export const docsContentVersionStatusEnum = pgEnum(
    "docs_content_version_state",
    DOCS_CONTENT_VERSION_STATUSES,
)

export const docsContentVersionKindEnum = pgEnum(
    "docs_content_version_kind",
    DOCS_CONTENT_VERSION_KINDS,
)

export const docsBuildErrorKindEnum = pgEnum(
    "docs_build_error_kind",
    DOCS_BUILD_ERROR_KINDS,
)

export const docsPageKindEnum = pgEnum("docs_page_kind", DOCS_PAGE_KINDS)

export const docsNavSourceEnum = pgEnum("docs_nav_source", NAV_SOURCES)

export const docsDiagnosticSeverityEnum = pgEnum(
    "docs_diagnostic_severity",
    DIAGNOSTIC_SEVERITIES,
)

export const docsDiagnosticCodeEnum = pgEnum(
    "docs_diagnostic_code",
    DIAGNOSTIC_CODES,
)

export const docsConfigDispositionEnum = pgEnum(
    "docs_config_disposition",
    CONFIG_DISPOSITIONS,
)

export const docsLayoutPresetEnum = pgEnum("docs_layout_preset", LAYOUT_PRESETS)

export const docsAgentFeedbackKindEnum = pgEnum(
    "docs_agent_feedback_kind",
    DOCS_AGENT_FEEDBACK_KINDS,
)

export const docsAgentFeedbackSourceEnum = pgEnum(
    "docs_agent_feedback_source",
    DOCS_AGENT_FEEDBACK_SOURCES,
)
