import { getBreadcrumbItems } from "fumadocs-core/breadcrumb"
import { DEFAULT_DOCS_TITLE_TEMPLATE, formatDocsPath } from "@/types/docs"
import { type DocPage, slugsToMarkdownPath } from "./agent-content"
import { siteUrlOf } from "./base-path"
import type { DocsContext, SiteSource } from "./source"

export interface PageSeoAlternate {
    language: string
    url: string
    default: boolean
}

export interface PageSeoProvenance {
    name: string
    sourceUrl: string
    license?: { name: string; url: string }
}

export interface PageSeo {
    title: string
    pageTitle: string
    description?: string
    /** Open Graph object type: the site root is the `website`, every other page an `article`. */
    ogType: "website" | "article"
    canonical: string
    /** The site's URL: origin plus base path, no trailing slash. */
    siteUrl: string
    markdownUrl: string
    siteName: string
    language: string
    lastModified: string
    imageUrl: string
    imageAlt: string
    alternates: PageSeoAlternate[]
    /** X/Twitter handle from footer.socials, for twitter:site. */
    twitterSite?: string
    provenance?: PageSeoProvenance
    /** Pre-stringified JSON-LD so the server-function result stays serializable. */
    jsonLd: string
}

/**
 * The same page's URL in every visible locale — the language selector, the
 * page's hreflang links, and the sitemap's xhtml:link alternates all derive
 * from this one mapping. `servedUrl` is the page's own path (locale prefix
 * included for a non-default locale); callers filter the candidates by which
 * URLs actually serve.
 *
 * Version roots are per locale (`localesManifest[].versionsManifest`): a
 * leading segment naming one of the active locale's subdirectory versions is
 * that version's tree, anything else is the locale's unprefixed tree. The
 * counterpart keeps the same label when the target locale has that version;
 * a default-version page otherwise lands on the target's default version,
 * whose URL carries the label prefix when it lives in a subdirectory
 * (`/intro` ↔ `/es/v1/intro`). A non-default version the target lacks keeps
 * its label so the served-URL filter drops it.
 */
export function localeCounterparts<
    T extends {
        locale: string
        default: boolean
        versionsManifest: ReadonlyArray<{
            label: string
            directory: string
            default: boolean
        }>
    },
>(
    servedUrl: string,
    activeLocale: string | null,
    locales: readonly T[],
): Array<{ entry: T; locale: string; default: boolean; url: string }> {
    // Drop the leading /<locale> segment (whole-segment match only) with
    // plain string ops — a RegExp built from the locale trips semgrep's
    // non-literal-regexp rule and recompiles per request.
    const localePrefix = `/${activeLocale}`
    const stripped = !activeLocale
        ? servedUrl
        : servedUrl === localePrefix
          ? "/"
          : servedUrl.startsWith(`${localePrefix}/`)
            ? servedUrl.slice(localePrefix.length)
            : servedUrl
    const slugs = stripped.split("/").filter(Boolean)
    const active = locales.find((entry) =>
        activeLocale ? entry.locale === activeLocale : entry.default,
    )
    const activeVersions = active?.versionsManifest ?? []
    const version = activeVersions.find(
        (entry) => entry.directory.length > 0 && entry.label === slugs[0],
    )
    const rest = version ? slugs.slice(1) : slugs
    // The unprefixed tree IS the default version only when that version
    // spans the locale root (directory ""); with a subdirectory default the
    // unprefixed pages are unversioned and stay unprefixed everywhere.
    const activeDefault = activeVersions.find((entry) => entry.default)
    const inDefaultVersion = version
        ? version.default
        : activeDefault !== undefined && activeDefault.directory.length === 0
    return locales.map((entry) => {
        const sameLabel =
            version !== undefined &&
            entry.versionsManifest.some(
                (candidate) =>
                    candidate.directory.length > 0 &&
                    candidate.label === version.label,
            )
        const targetDefault = entry.versionsManifest.find(
            (candidate) => candidate.default,
        )
        const versionSlugs = sameLabel
            ? [version.label]
            : inDefaultVersion
              ? targetDefault && targetDefault.directory.length > 0
                  ? [targetDefault.label]
                  : []
              : version
                ? [version.label]
                : []
        return {
            entry,
            locale: entry.locale,
            default: entry.default,
            url: `/${[
                ...(entry.default ? [] : [entry.locale]),
                ...versionSlugs,
                ...rest,
            ].join("/")}`,
        }
    })
}

/**
 * Build one connected, server-rendered Schema.org graph and the values shared
 * by HTML, Open Graph, and Twitter metadata. Request-time identity supplies
 * every zero-config default; stored config only overrides explicit facts.
 */
export function buildPageSeo(input: {
    /** The site's URL: origin plus base path (siteUrlFromRequest). */
    siteUrl: string
    ctx: DocsContext
    source: SiteSource
    page: DocPage
    imageUrl: string
    apiReference: boolean
    alternates?: PageSeoAlternate[]
}): PageSeo {
    const siteUrl = input.siteUrl.replace(/\/$/, "")
    const trailingSlash = input.ctx.seo.trailingSlash
    const canonical = siteUrlOf(
        siteUrl,
        formatDocsPath(input.page.url, trailingSlash),
    )
    const siteName = input.ctx.identity.name
    const normalizedPageTitle = input.page.data.pageTitle
        .replace(/\s+/g, " ")
        .trim()
    const normalizedSiteName = siteName.replace(/\s+/g, " ").trim()
    const title =
        input.ctx.seo.titleTemplate === DEFAULT_DOCS_TITLE_TEMPLATE &&
        normalizedPageTitle === normalizedSiteName
            ? normalizedPageTitle
            : input.ctx.seo.titleTemplate
                  .replace("{page}", input.page.data.pageTitle)
                  .replace("{site}", siteName)
                  .replace(/\s+/g, " ")
                  .trim()
    const description =
        input.page.data.description ??
        input.ctx.seo.description ??
        input.ctx.identity.description
    const language =
        input.ctx.activeLocale ??
        input.ctx.localesManifest.find((entry) => entry.default)?.locale ??
        input.ctx.seo.language ??
        "en"
    const lastModified = input.page.data.lastModified.toISOString()

    const pageProvenance = input.page.data.frontmatter.provenance
    const configuredProvenance = input.ctx.seo.provenance
    const provenance =
        pageProvenance && configuredProvenance
            ? {
                  name: configuredProvenance.name,
                  sourceUrl:
                      pageProvenance === true
                          ? `${configuredProvenance.baseUrl.replace(/\/+$/, "")}${input.page.url === "/" ? "" : input.page.url}`
                          : pageProvenance.sourceUrl,
                  ...(configuredProvenance.license
                      ? { license: configuredProvenance.license }
                      : {}),
              }
            : undefined

    const configLogo = input.ctx.config?.logo
    const logoCandidate =
        input.ctx.seo.publisher?.logoUrl ??
        (typeof configLogo === "string" ? configLogo : configLogo?.light)
    let logoUrl: string | undefined
    if (logoCandidate) {
        try {
            // Root-relative paths are the site's own: under its base path.
            const resolved = new URL(
                logoCandidate.startsWith("/") && !logoCandidate.startsWith("//")
                    ? `${siteUrl}${logoCandidate}`
                    : logoCandidate,
                `${siteUrl}/`,
            )
            if (
                (resolved.protocol === "http:" ||
                    resolved.protocol === "https:") &&
                resolved.username.length === 0 &&
                resolved.password.length === 0
            )
                logoUrl = resolved.href
        } catch {
            logoUrl = undefined
        }
    }

    // footer.socials doubles as the publisher's identity graph: Schema.org
    // sameAs and the X handle behind twitter:site.
    const socials = Object.values(input.ctx.config?.footer?.socials ?? {})
        .filter((value): value is string => typeof value === "string")
        .filter((value) => /^https?:\/\//i.test(value))
    const xHandle = socials
        .map(
            (value) =>
                /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i.exec(
                    value,
                )?.[1],
        )
        .find((handle) => handle !== undefined)
    const sameAs = [
        ...new Set([...(input.ctx.seo.publisher?.sameAs ?? []), ...socials]),
    ]

    const publisherId = `${siteUrl}/#publisher`
    const websiteId = `${siteUrl}/#website`
    const webpageId = `${canonical}#webpage`
    const breadcrumbId = `${canonical}#breadcrumb`
    const articleId = `${canonical}#article`
    const imageId = `${canonical}#primaryimage`
    const publisherType = input.ctx.seo.publisher?.type ?? "Organization"
    const publisherNode = {
        "@type": publisherType,
        "@id": publisherId,
        name: input.ctx.seo.publisher?.name ?? siteName,
        url: input.ctx.seo.publisher?.url ?? siteUrl,
        ...(logoUrl
            ? publisherType === "Organization"
                ? { logo: { "@type": "ImageObject", url: logoUrl } }
                : { image: { "@type": "ImageObject", url: logoUrl } }
            : {}),
        ...(sameAs.length > 0 ? { sameAs } : {}),
    }

    const treeCrumbs = getBreadcrumbItems(
        input.page.url,
        input.source.getPageTree(),
        { includePage: true },
    )
    const breadcrumbCandidates = [
        ...(input.page.url === "/" ? [] : [{ name: siteName, url: "/" }]),
        ...treeCrumbs.flatMap((crumb) =>
            typeof crumb.name === "string" && crumb.url
                ? [{ name: crumb.name, url: crumb.url }]
                : [],
        ),
    ]
    const seenBreadcrumbUrls = new Set<string>()
    const breadcrumbs = breadcrumbCandidates.filter((crumb) => {
        if (crumb.url === input.page.url || seenBreadcrumbUrls.has(crumb.url))
            return false
        seenBreadcrumbUrls.add(crumb.url)
        return true
    })
    breadcrumbs.push({
        name: input.page.data.pageTitle,
        url: input.page.url,
    })

    const imageNode = {
        "@type": "ImageObject",
        "@id": imageId,
        url: input.imageUrl,
        contentUrl: input.imageUrl,
        caption: input.page.data.pageTitle,
    }
    const articleTypes = input.apiReference
        ? ["Article", "TechArticle", "APIReference"]
        : ["Article", "TechArticle"]
    const jsonLd = {
        "@context": "https://schema.org",
        "@graph": [
            publisherNode,
            {
                "@type": "WebSite",
                "@id": websiteId,
                url: siteUrl,
                name: siteName,
                inLanguage: language,
                publisher: { "@id": publisherId },
            },
            imageNode,
            {
                "@type": "BreadcrumbList",
                "@id": breadcrumbId,
                itemListElement: breadcrumbs.map((crumb, index) => ({
                    "@type": "ListItem",
                    position: index + 1,
                    name: crumb.name,
                    item: siteUrlOf(
                        siteUrl,
                        formatDocsPath(crumb.url, trailingSlash),
                    ),
                })),
            },
            {
                "@type": "WebPage",
                "@id": webpageId,
                url: canonical,
                name: input.page.data.pageTitle,
                ...(description ? { description } : {}),
                dateModified: lastModified,
                inLanguage: language,
                isPartOf: { "@id": websiteId },
                breadcrumb: { "@id": breadcrumbId },
                primaryImageOfPage: { "@id": imageId },
            },
            {
                "@type": articleTypes,
                "@id": articleId,
                headline: input.page.data.pageTitle,
                ...(description ? { description } : {}),
                url: canonical,
                dateModified: lastModified,
                inLanguage: language,
                mainEntityOfPage: { "@id": webpageId },
                isPartOf: { "@id": websiteId },
                publisher: { "@id": publisherId },
                image: { "@id": imageId },
                ...(provenance
                    ? {
                          isBasedOn: provenance.sourceUrl,
                          ...(provenance.license
                              ? { license: provenance.license.url }
                              : {}),
                      }
                    : {}),
            },
        ],
    }

    return {
        title,
        pageTitle: input.page.data.pageTitle,
        description: description || undefined,
        ogType: input.page.url === "/" ? "website" : "article",
        canonical,
        siteUrl,
        markdownUrl: siteUrl + slugsToMarkdownPath(input.page.slugs).url,
        siteName,
        language,
        lastModified,
        imageUrl: input.imageUrl,
        imageAlt: input.page.data.pageTitle,
        alternates: input.alternates ?? [],
        ...(xHandle ? { twitterSite: `@${xHandle}` } : {}),
        ...(provenance ? { provenance } : {}),
        jsonLd: JSON.stringify(jsonLd),
    }
}
