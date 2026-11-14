import FumaLink from "fumadocs-core/link"
import { Accordions } from "fumadocs-ui/components/accordion"
import { Callout } from "fumadocs-ui/components/callout"
import {
    CodeBlock,
    CodeBlockTab,
    CodeBlockTabs,
    CodeBlockTabsList,
    CodeBlockTabsTrigger,
    Pre,
} from "fumadocs-ui/components/codeblock"
import {
    File as FumaFile,
    Files as FumaFiles,
    Folder as FumaFolder,
} from "fumadocs-ui/components/files"
import { ImageZoom } from "fumadocs-ui/components/image-zoom"
import { Steps } from "fumadocs-ui/components/steps"
import {
    Tab as FumaTab,
    Tabs as FumaTabs,
    TabsList,
    TabsTrigger,
} from "fumadocs-ui/components/tabs"
import {
    AccordionContent,
    AccordionHeader,
    AccordionItem,
    AccordionTrigger,
} from "fumadocs-ui/components/ui/accordion"
import defaultMdxComponents from "fumadocs-ui/mdx"
import type { MDXComponents } from "mdx/types"
import {
    Children,
    type ComponentProps,
    cloneElement,
    createContext,
    type ElementType,
    isValidElement,
    type ReactNode,
    use,
    useContext,
    useRef,
    useState,
} from "react"
import {
    array,
    object,
    string,
    catch as zodCatch,
    enum as zodEnum,
} from "zod/mini"
import { AISearchActionsContext } from "@/components/ai/search-context"
import {
    BugIcon,
    chromeIcon,
    chromeIconSvg,
    MessageCircleIcon,
} from "@/components/chrome-icons"
import { GitHub } from "@/components/github-repo"
import { buttonVariants } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard"
import { basePath, stripBase, useBasePath, withBase } from "@/lib/base-path"
import { useChromeStrings } from "@/lib/chrome-strings"
import { cn } from "@/lib/cn"
import { iconIsImageRef, trustedInlineSvg } from "@/lib/docs-icon"
import type { BrowserEvent } from "@/routes/api/agent.event"
import type { AllowedMdxComponent } from "@/types/docs"
import { Mermaid } from "./mermaid"
import { View, ViewGroup } from "./view-group"

// Mirrors the ingest scheme allow-list (src/types/docs-shared.ts isAllowedUrl):
// editor deep links (cursor://…/mcp/install, vscode:mcp/install) are how
// authored pages ship MCP one-click setup — inert outside the matching app.
const safeHrefSchema =
    /^https?:\/\/|^mailto:|^cursor:|^vscode:|^vscode-insiders:|^#|^\/(?!\/)|^\.\.?\//i

/**
 * Mintlify content names icons as strings (Font Awesome-ish). Map the common
 * ones onto lucide; an unknown name renders NO icon — never the raw string.
 */
const CARD_ICON_NAMES: Record<string, string> = {
    terminal: "terminal",
    plug: "plug",
    browser: "app-window",
    "app-window": "app-window",
    window: "app-window",
    code: "code",
    rocket: "rocket",
    book: "book-open",
    "book-open": "book-open",
    envelope: "mail",
    mail: "mail",
    gear: "settings",
    settings: "settings",
    key: "key",
    globe: "globe",
    database: "database",
    shield: "shield",
    "paper-plane": "send",
    send: "send",
    wrench: "wrench",
    bolt: "zap",
    zap: "zap",
    users: "users",
    file: "file-text",
    document: "file-text",
    lightbulb: "lightbulb",
    puzzle: "puzzle",
    "puzzle-piece": "puzzle",
    "chart-line": "chart-line",
    graph: "chart-line",
}
const CARD_ICONS = Object.fromEntries(
    Object.entries(CARD_ICON_NAMES).map(([alias, name]) => [
        alias,
        chromeIcon(name),
    ]),
)

/**
 * `legacyIconClass` sizes the legacy name fallback's span: the svg inside
 * fills it, so a wrapper's own svg sizing (app.css's 20px card icon) needs
 * the span to match or flex shrinks the glyph.
 */
function iconFromName(
    icon: ReactNode,
    base: string,
    legacyIconClass?: string,
): ReactNode {
    if (typeof icon !== "string") return icon
    const value = icon.trim()
    // Ingest resolves icon names to inline Hugeicons SVG (and asset paths to
    // hashed URLs) — cards execute client-side, so the name → SVG map never
    // ships to the browser.
    // A static expression attribute (icon={"<svg …"}) skips ingest's
    // string-attribute rewrite, so gate the sink like docsIconNode does.
    if (value.startsWith("<svg")) {
        const svg = trustedInlineSvg(value)
        if (!svg) return undefined
        return (
            <span
                className="inline-flex size-4 [&>svg]:size-full"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: SVGs are produced at ingest from the committed icon map, not raw site input
                dangerouslySetInnerHTML={{ __html: svg }} // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- `svg` passed trustedInlineSvg (no scripts, handlers, refs or CSS fetches)
            />
        )
    }
    if (value.startsWith("/") || /^https?:\/\//i.test(value))
        // Image icons (platform logos on download cards) render at
        // ~32px, object-contain so odd aspect ratios (Tux,
        // Windows) neither collapse nor balloon.
        // biome-ignore lint/performance/noImgElement: site icon assets are served from the docs asset store, not next/image
        return (
            <img
                src={withBase(value, base)}
                alt=""
                className="size-8 object-contain"
            />
        )
    // Legacy content versions stored before ingest-side resolution.
    const LucideCard = CARD_ICONS[value.toLowerCase()]
    return LucideCard ? <LucideCard className={legacyIconClass} /> : undefined
}

/**
 * fumadocs' Callout for the authored callout components: `data-callout`
 * keys the per-tone CSS in app.css (tones are Mintlify's component names —
 * richer than fumadocs' type palette, e.g. Note=blue vs Info=neutral share
 * type="info"), and the icon set is outline instead of fumadocs'
 * filled glyphs. --callout-color still comes from fumadocs' type. The icon's
 * top margin is half of what one line leaves over its 18px, so it centres on
 * the first line at whatever line height a theme gives the callout.
 */
const calloutIconClass =
    "mt-[calc((1lh-1.125rem)/2)] size-4.5 -me-0.5 shrink-0 text-(--callout-color)"
const CalloutInfoIcon = chromeIcon("info")
const CalloutTipIcon = chromeIcon("lightbulb")
const CalloutWarningIcon = chromeIcon("triangle-alert")
const CalloutCheckIcon = chromeIcon("circle-check")
const CalloutErrorIcon = chromeIcon("circle-x")
const CALLOUT_ICONS: Record<string, ReactNode> = {
    note: <CalloutInfoIcon className={calloutIconClass} />,
    info: <CalloutInfoIcon className={calloutIconClass} />,
    tip: <CalloutTipIcon className={calloutIconClass} />,
    warning: <CalloutWarningIcon className={calloutIconClass} />,
    check: <CalloutCheckIcon className={calloutIconClass} />,
    success: <CalloutCheckIcon className={calloutIconClass} />,
    error: <CalloutErrorIcon className={calloutIconClass} />,
    idea: <CalloutTipIcon className={calloutIconClass} />,
}

function TintedCallout({
    tone,
    ...props
}: ComponentProps<typeof Callout> & { tone?: string }) {
    const key = tone ?? props.type ?? "info"
    return (
        <Callout
            {...props}
            className={cn("callout", props.className)}
            data-callout={key}
            data-callout-type={key}
            icon={CALLOUT_ICONS[key] ?? CALLOUT_ICONS.info}
        />
    )
}

/** MDX boolean-ish attribute: bare (`horizontal`), boolean, or "true". */
function flagProp(value: unknown): boolean {
    return value === true || value === "" || value === "true"
}

const CardArrowIcon = chromeIcon("arrow-up-right")

/**
 * Card rendered locally instead of via fumadocs' Card: fumadocs
 * hardcodes the title as an h3 (and emits it even untitled), so every card
 * title entered the outline one level below the officials' H2 (* all four mirrors' card grids). Markup and classes mirror fumadocs
 * card.js exactly (root data-card + child order), so the app.css card
 * selectors (#nd-page [data-card] > …) keep working.
 */
function IconCard({
    icon,
    // FontAwesome style variant ("solid"/"regular"…) — the committed icon
    // map ships one style, so the prop is accepted and has no visual effect.
    iconType: _iconType,
    color,
    img,
    cta,
    title,
    description,
    href,
    horizontal,
    arrow,
    className,
    children,
}: {
    icon?: ReactNode
    iconType?: string
    /** Card color — tints the icon. */
    color?: string
    img?: string
    cta?: ReactNode
    title?: ReactNode
    description?: ReactNode
    href?: string
    /** Horizontal card: compact row, icon beside the text. */
    horizontal?: boolean | string
    /** Force (true) or suppress (false) the top-right link arrow. */
    arrow?: boolean | string
    className?: string
    children?: ReactNode
}) {
    const external = typeof href === "string" && /^https?:\/\//i.test(href)
    // Cards size their icon 20px (app.css); match the legacy span to it.
    const base = useBasePath()
    const resolvedIcon = iconFromName(icon, base, "size-5")
    const isHorizontal = flagProp(horizontal)
    const showArrow = arrow === undefined ? external : flagProp(arrow)
    const Root = href === undefined ? "div" : FumaLink
    const body = (
        <div
            data-component-part="card-content-container"
            className={cn("min-w-0", isHorizontal && "flex-1")}
        >
            {title !== undefined && title !== null && title !== "" ? (
                // Card title: 16px/600 (an h2 upstream); the
                // description and body copy read 16px in the muted tone.
                <span
                    data-component-part="card-title"
                    className="not-prose mb-1 block font-semibold text-base"
                >
                    {title}
                </span>
            ) : null}
            {description ? (
                <p className="my-0! text-base text-fd-muted-foreground">
                    {description}
                </p>
            ) : null}
            <div
                data-component-part="card-content"
                className="prose prose-no-margin text-base text-fd-muted-foreground leading-6 empty:hidden"
            >
                {typeof img === "string" &&
                img.startsWith("/_assets/") &&
                !isHorizontal ? (
                    // Card img= — a full-bleed thumbnail above the body.
                    // biome-ignore lint/performance/noImgElement: site thumbnails come from the docs asset store, not next/image
                    <img
                        src={withBase(img, base)}
                        alt=""
                        data-component-part="card-image"
                        className="-mx-4 -mt-4 mb-3 w-[calc(100%+2rem)] max-w-none rounded-t-xl object-cover"
                    />
                ) : null}
                {children}
                {cta ? (
                    <span
                        data-component-part="card-cta"
                        className="mt-auto flex items-center gap-1 pt-2 font-medium text-fd-foreground text-sm"
                    >
                        {cta}
                        <span
                            aria-hidden
                            className="text-fd-muted-foreground transition-transform group-hover:translate-x-0.5"
                        >
                            ›
                        </span>
                    </span>
                ) : null}
            </div>
        </div>
    )
    return (
        <Root
            {...(href === undefined ? {} : { href })}
            data-card
            // Cards: flex column (CTA anchors to the bottom of
            // equal-height grid rows), hover marked by a primary border
            // instead of fumadocs' gray wash. Horizontal cards swap to a
            // compact icon-beside-text row.
            className={cn(
                "card @max-lg:col-span-full block rounded-xl border bg-fd-card p-4 text-fd-card-foreground transition-colors",
                "group relative flex",
                isHorizontal ? "flex-row items-start gap-3" : "flex-col",
                href !== undefined &&
                    "hover:border-fd-primary/50 hover:bg-fd-card",
                className,
            )}
        >
            {showArrow ? (
                <CardArrowIcon className="absolute end-4 top-4 size-4 text-fd-muted-foreground" />
            ) : null}
            {resolvedIcon ? (
                <div
                    data-component-part="card-icon"
                    className={cn(
                        "not-prose w-fit rounded-lg border bg-fd-muted p-1.5 text-fd-muted-foreground shadow-md [&_svg]:size-4",
                        isHorizontal ? "shrink-0" : "mb-2",
                    )}
                    style={color ? { color } : undefined}
                >
                    {resolvedIcon}
                </div>
            ) : null}
            {body}
        </Root>
    )
}

/**
 * GitHub new-issue URL for the current page (routes/$.tsx issueUrl) — the
 * code block "Report issue" action appends the snippet. Null when the site
 * is not repo-bound, which hides the action.
 */
export const CodeIssueContext = createContext<string | null>(null)

/** Plain text of a Shiki-rendered code tree (line spans + "\n" nodes). */
function codeText(node: ReactNode): string {
    if (typeof node === "string" || typeof node === "number")
        return String(node)
    if (Array.isArray(node)) return node.map(codeText).join("")
    if (isValidElement<{ children?: ReactNode }>(node))
        return codeText(node.props.children)
    return ""
}

/**
 * Code block action cluster: fumadocs' copy button (the
 * default child) plus "Ask AI about this code" when the Assistant exists and
 * "Report issue" when the site is repo-bound. Copy-only otherwise.
 */
function CodeBlockActions(props: {
    className?: string
    children?: ReactNode
    code: ReactNode
    /** Shiki's language id, when the compiled block carries one. */
    language: string | null
}) {
    const assistant = use(AISearchActionsContext)
    const issueUrl = use(CodeIssueContext)
    const strings = useChromeStrings()
    const action = buttonVariants({
        color: "ghost",
        size: "icon-sm",
        className: "text-fd-muted-foreground [&_svg]:size-3.5",
    })
    return (
        // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: observes clicks bubbling from native buttons, which keyboard activation also fires; the div itself is not interactive
        <div
            className={cn(
                "code-block-actions flex items-center gap-0.5 empty:hidden",
                props.className,
            )}
            // fumadocs' copy button (the slot children) is the one button
            // here without a data-code-action; observe its clicks as they
            // bubble rather than re-implementing it. Only the language and
            // whether the block sits in a code group leave — never the code.
            // fumadocs sets data-checked only once writeText resolves, so a
            // rejected clipboard write never reports a copy.
            onClick={(event) => {
                const button =
                    event.target instanceof Element
                        ? event.target.closest("button:not([data-code-action])")
                        : null
                if (!button) return
                const beacon = JSON.stringify({
                    type: "code_copied",
                    // The router's path, as every page_path is.
                    page_path:
                        stripBase(location.pathname, basePath()) ??
                        location.pathname,
                    language: props.language,
                    in_code_group:
                        event.currentTarget.closest('[role="tabpanel"]') !==
                        null,
                } satisfies BrowserEvent)
                const observer = new MutationObserver(() => {
                    if (!button.hasAttribute("data-checked")) return
                    observer.disconnect()
                    if (
                        !navigator.sendBeacon(
                            withBase("/api/agent/event"),
                            beacon,
                        )
                    )
                        void fetch(withBase("/api/agent/event"), {
                            method: "POST",
                            body: beacon,
                            keepalive: true,
                        }).catch(() => {})
                })
                observer.observe(button, {
                    attributes: true,
                    attributeFilter: ["data-checked"],
                })
                setTimeout(() => observer.disconnect(), 3_000)
            }}
        >
            {props.children}
            {assistant ? (
                <button
                    type="button"
                    aria-label={strings.askAiAboutCode}
                    title={strings.askAiAboutCode}
                    data-code-action="ask-ai"
                    className={action}
                    onClick={() =>
                        assistant.ask(
                            `${strings.askAiAboutCode}:\n\n\`\`\`\n${codeText(props.code).trim()}\n\`\`\``,
                        )
                    }
                >
                    <MessageCircleIcon />
                </button>
            ) : null}
            {issueUrl ? (
                <button
                    type="button"
                    aria-label={strings.reportIssue}
                    title={strings.reportIssue}
                    data-code-action="report-issue"
                    className={action}
                    onClick={() => {
                        // Page-prefilled issue URL + the snippet, built at
                        // click time (opening synchronously keeps popup
                        // blockers quiet).
                        const url = new URL(issueUrl)
                        const body = url.searchParams.get("body") ?? ""
                        url.searchParams.set(
                            "body",
                            `${body}\n\nCode:\n\n\`\`\`\n${codeText(props.code).trim().slice(0, 2000)}\n\`\`\``,
                        )
                        const win = window.open(url.href, "_blank")
                        if (win) win.opener = null
                    }}
                >
                    <BugIcon />
                </button>
            ) : null}
        </div>
    )
}

/**
 * `pre:` override — fumadocs' CodeBlock plus the `expandable` fence
 * treatment: ingest stamps `data-expandable` on fences carrying the
 * modifier; collapsed blocks show a ~320px window with a sticky
 * "Show all N lines" bar. Non-expandable blocks keep fumadocs' 600px cap.
 */
function DocsCodeBlock({ children, ...props }: ComponentProps<"pre">) {
    const [expanded, setExpanded] = useState(false)
    // Ingest only stamps a language-* class when shiki's addLanguageClass is
    // on; without one the copy event reports a null language.
    const language =
        /(?:^|\s)language-([a-z0-9][a-z0-9+#._-]{0,31})(?:\s|$)/
            .exec(props.className?.toLowerCase() ?? "")
            ?.at(1) ?? null
    // biome-ignore lint/correctness/noComponentHookFactories: CodeBlock's Actions slot needs this block's code and language; pre-existing, it remounts only when the block re-renders.
    const Actions = (slot: { className?: string; children?: ReactNode }) => (
        <CodeBlockActions {...slot} code={children} language={language} />
    )
    const hooked = {
        ...props,
        "data-component-part": "code-block-root",
        className: cn("code-block", props.className),
    }
    if (!("data-expandable" in props))
        return (
            <CodeBlock {...hooked} Actions={Actions}>
                <Pre>{children}</Pre>
            </CodeBlock>
        )
    const code = isValidElement<{ children?: ReactNode }>(children)
        ? children
        : null
    // Shiki emits one span per line with "\n" text nodes between — count
    // elements only.
    const lineCount = code
        ? Children.toArray(code.props.children).filter((child) =>
              isValidElement(child),
          ).length
        : 0
    return (
        <CodeBlock
            {...hooked}
            Actions={Actions}
            viewportProps={{
                className: expanded ? "max-h-none" : "max-h-80",
            }}
        >
            <Pre>{children}</Pre>
            <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="-mb-3.5 sticky inset-x-0 bottom-0 w-full border-t bg-fd-card py-2 font-sans text-fd-muted-foreground text-xs transition-colors hover:text-fd-accent-foreground"
            >
                {expanded ? "Collapse" : `Show all ${lineCount} lines`}
            </button>
        </CodeBlock>
    )
}

/**
 * Code-group tabs carry per-language icons. fumadocs' trigger children are
 * labels only, so a glyph is derived at render time from the committed map.
 * Unknown labels get no icon.
 */
const CODE_TAB_ICON_RULES: [RegExp, string][] = [
    [/\.(?:ts|tsx|mts|cts)$|typescript/i, "file-code"],
    [/\.(?:js|jsx|mjs|cjs)$|javascript/i, "file-code"],
    [/\.json[c5]?$/i, "braces"],
    [/terminal|shell|bash|zsh|^sh$|curl|cli|command/i, "terminal"],
    [/windows/i, "app-window"],
    [/mac|linux|unix/i, "globe"],
    [/docker|container/i, "container"],
    [/npm|pnpm|yarn|^bunx?\b|package/i, "package"],
    [/\.(?:toml|ya?ml|ini|cfg|conf)$|config/i, "settings"],
]

function CodeTabTrigger(props: ComponentProps<typeof CodeBlockTabsTrigger>) {
    const label = typeof props.value === "string" ? props.value : ""
    const rule = CODE_TAB_ICON_RULES.find(([pattern]) => pattern.test(label))
    const svg = rule ? chromeIconSvg(rule[1]) : null
    return (
        <CodeBlockTabsTrigger {...props}>
            {svg ? (
                // code-tab-icon: warm-preset CSS hides these — maple
                // tabs are label-only; other presets keep language icons.
                <span
                    className="code-tab-icon inline-flex size-3.5 shrink-0 [&>svg]:size-full"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: SVGs come from the committed icon map, not site input
                    dangerouslySetInnerHTML={{ __html: svg }}
                />
            ) : null}
            {props.children}
        </CodeBlockTabsTrigger>
    )
}

/**
 * Demo videos autoplay muted inline; a bare MDX <video> renders an
 * unsized empty box. Authored attributes win over the playback defaults.
 */
function DocsVideo(props: ComponentProps<"video">) {
    const base = useBasePath()
    return (
        <video
            autoPlay
            muted
            loop
            playsInline
            {...props}
            src={
                props.src === undefined ? undefined : withBase(props.src, base)
            }
            poster={
                props.poster === undefined
                    ? undefined
                    : withBase(props.poster, base)
            }
            className={cn("w-full rounded-xl", props.className)}
        >
            {/* Authored <source> children: ingest rewrites their src to
                /_assets/… like the video's own. */}
            {Children.map(props.children, (child) =>
                isValidElement<ComponentProps<"source">>(child) &&
                child.type === "source" &&
                child.props.src !== undefined
                    ? cloneElement(child, {
                          src: withBase(child.props.src, base),
                      })
                    : child,
            )}
        </video>
    )
}

/**
 * After the ingest pipeline normalizes fence meta, a CodeGroup's children
 * compile to a single self-bordered <CodeBlockTabs>; this wrapper only
 * provides spacing and the group semantics. Pre-normalization versions
 * (immutable, until re-ingested) still stack bare figures — flatten their
 * margins so the stack reads as one block.
 */
function CodeGroup({ children }: { children?: ReactNode }) {
    return (
        // biome-ignore lint/a11y/useSemanticElements: fieldset is for form controls; group is the correct role for a code-example cluster
        <div
            className="my-4 [&_figure]:my-0 [&>*]:my-0"
            role="group"
            aria-label="Code examples"
        >
            {children}
        </div>
    )
}

const COLUMN_CLASSES: Record<number, string> = {
    1: "grid-cols-1",
    2: "grid-cols-1 @lg:grid-cols-2",
    3: "grid-cols-1 @md:grid-cols-2 @xl:grid-cols-3",
    4: "grid-cols-1 @md:grid-cols-2 @xl:grid-cols-4",
}

function Columns({
    children,
    cols,
}: {
    children?: ReactNode
    // With MDX expressions enabled, `cols={2}` arrives as a number.
    cols?: string | number
}) {
    const count = Number(cols)
    const columns =
        Number.isInteger(count) && count >= 1 && count <= 4 ? count : 2
    return (
        <div className="@container my-4">
            <div className={`columns grid gap-4 ${COLUMN_CLASSES[columns]}`}>
                {children}
            </div>
        </div>
    )
}

function Badge({ children }: { children?: ReactNode }) {
    // Neutral gray pill — the pink tint made "Required" badges
    // read as links.
    return (
        <span
            data-badge=""
            className="inline-flex items-center rounded-full border bg-fd-muted px-2 py-0.5 font-medium text-fd-muted-foreground text-xs"
        >
            {children}
        </span>
    )
}

/**
 * ParamField/ResponseField — a definition block for one API or
 * CLI parameter: monospace name, muted type/default/required chips, markdown
 * description as children.
 */
function ParamField({
    path,
    query,
    body,
    header,
    name,
    type,
    required,
    deprecated,
    children,
    ...rest
}: {
    path?: string
    query?: string
    body?: string
    header?: string
    name?: string
    type?: string
    required?: boolean | string
    deprecated?: boolean | string
    default?: string | number | boolean
    children?: ReactNode
}) {
    const paramName = path ?? query ?? body ?? header ?? name ?? ""
    const defaultValue = rest.default
    return (
        <div className="field my-4 border-fd-border border-b pb-4 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                {/* Emphasis: the flag NAME is bare primary mono;
                    the type sits in the gray chip (we had it reversed). */}
                <code className="font-mono font-semibold text-fd-primary text-sm">
                    {paramName}
                </code>
                {type ? (
                    <span className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-fd-muted-foreground text-xs">
                        {type}
                    </span>
                ) : null}
                {defaultValue !== undefined && defaultValue !== null ? (
                    <span className="font-mono text-fd-muted-foreground text-xs">
                        default: {String(defaultValue)}
                    </span>
                ) : null}
                {required !== undefined && required !== false ? (
                    <span className="font-medium text-red-600 text-xs dark:text-red-400">
                        required
                    </span>
                ) : null}
                {deprecated !== undefined && deprecated !== false ? (
                    <span className="font-medium text-amber-600 text-xs dark:text-amber-400">
                        deprecated
                    </span>
                ) : null}
            </div>
            {children ? (
                <div className="mt-1.5 text-fd-muted-foreground text-sm [&>p]:my-1">
                    {children}
                </div>
            ) : null}
        </div>
    )
}

function Frame({
    children,
    caption,
    hint,
}: {
    children?: ReactNode
    caption?: string
    /** Frame hint — a secondary muted line under the caption. */
    hint?: string
}) {
    // Frame is a bare rounded image, not a padded bordered card;
    // media fills the frame (videos get playback attributes via the `video`
    // intrinsic override below).
    return (
        <figure className="frame my-6">
            <div className="overflow-hidden rounded-xl [&_img]:my-0 [&_img]:w-full [&_video]:my-0 [&_video]:w-full">
                {children}
            </div>
            {caption ? (
                <figcaption className="pt-3 text-center text-fd-muted-foreground text-sm">
                    {caption}
                </figcaption>
            ) : null}
            {hint ? (
                <div className="pt-1 text-center text-fd-muted-foreground/70 text-xs">
                    {hint}
                </div>
            ) : null}
        </figure>
    )
}

function Tooltip({ children, tip }: { children?: ReactNode; tip: string }) {
    return (
        <span
            className="tooltip group relative inline-flex border-b border-dotted"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus — keyboard users need the trigger tabbable
            tabIndex={0}
        >
            {children}
            <span
                role="tooltip"
                className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-max max-w-64 -translate-x-1/2 rounded-md bg-fd-foreground px-2 py-1 text-xs text-fd-background group-hover:block group-focus:block"
            >
                {tip}
            </span>
        </span>
    )
}

/**
 * Update (changelog entries): the two-column treatment — a sticky
 * left rail holding the bordered date pill (`label`), the release title
 * (`description`) and plain tag labels, with the entry body in the right
 * column (audit: the mirror linearized everything into one column and
 * duplicated the title). data-update-tags feeds the Filters rail
 * (components/changelog-filters.tsx); the label doubles as the anchor id
 * the RSS feed links to.
 */
function Update({
    children,
    label,
    date,
    description,
    tags,
}: {
    children?: ReactNode
    label?: string
    date?: string
    description?: string
    tags?: unknown
}) {
    const parsedTags = zodCatch(array(string()), []).parse(tags ?? [])
    const anchor = (label ?? date ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
    return (
        <section
            id={anchor || undefined}
            // JSON, not comma-joined: tags may legitimately contain commas
            // and the Filters rail must round-trip them as single tags.
            data-update-tags={JSON.stringify(parsedTags)}
            className="update my-8 flex scroll-mt-[calc(7rem+var(--fd-banner-height,0px))] flex-col gap-4 border-b pb-8 last:border-b-0 md:flex-row md:gap-8"
        >
            <div className="shrink-0 md:w-40">
                <div className="flex flex-row flex-wrap items-center gap-2 md:sticky md:top-24 md:flex-col md:items-start md:gap-3">
                    {label || date ? (
                        // Update label: a 10% primary fill, no
                        // border, never wrapping ("September 18, 2026" broke
                        // onto two lines inside a bordered box).
                        <span className="whitespace-nowrap rounded-lg bg-fd-primary/10 px-2 py-1 font-medium text-fd-primary text-sm">
                            {label ?? date}
                        </span>
                    ) : null}
                    {description ? (
                        <span className="font-medium text-fd-muted-foreground text-xs">
                            {description}
                        </span>
                    ) : null}
                    {parsedTags.map((tag) => (
                        <span
                            key={tag}
                            className="text-fd-muted-foreground text-xs"
                        >
                            {tag}
                        </span>
                    ))}
                </div>
            </div>
            <div className="min-w-0 flex-1">{children}</div>
        </section>
    )
}

/**
 * Authors write <Tabs><Tab title="…">; fumadocs' simple mode derives
 * values from item labels with a first-whitespace-only escape, so "macOS &
 * Linux" became a Radix id with spaces (an invalid aria-controls id list),
 * and Radix left inactive panels empty in SSR HTML — crawlers and no-JS
 * readers never saw the Windows/Docker instructions. Render the list and
 * triggers here with slugified, de-duplicated values, force-mount every
 * panel (fumadocs' TabsContent hides inactive ones with
 * data-[state=inactive]:hidden), and give same-label groups a shared,
 * persisted groupId so every "Windows" tab on a page switches together —
 * the scheme code fences already use (docs-ingest remark-code-group-tabs).
 */
function Tabs({ children, items, ...props }: ComponentProps<typeof FumaTabs>) {
    const basePath = useBasePath()
    const kids = Children.toArray(children).filter(
        isValidElement<{
            title?: unknown
            icon?: ReactNode
            value?: string
            forceMount?: true
        }>,
    )
    const seen = new Map<string, number>()
    const tabs = kids.map((child, index) => {
        const authored = child.props.title ?? child.props.value
        const label =
            typeof authored === "string"
                ? authored
                : (items?.[index] ?? `Tab ${index + 1}`)
        const base =
            label
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "") || `tab-${index + 1}`
        const count = (seen.get(base) ?? 0) + 1
        seen.set(base, count)
        return {
            label,
            // Tab icon= renders before the label.
            icon: iconFromName(child.props.icon, basePath),
            value: count > 1 ? `${base}-${count}` : base,
        }
    })
    const groupId =
        tabs.length > 1
            ? tabs
                  .map((tab) => tab.value)
                  .sort()
                  .join("+")
            : undefined
    // An authored defaultValue names a tab by its label or original value;
    // translate it to the slug the panels now carry (fumadocs' Tabs is
    // uncontrolled — there is no `value` prop to map).
    const slugOf = (authored: string | undefined) =>
        authored === undefined
            ? undefined
            : (tabs.find(
                  (tab, index) =>
                      tab.label === authored ||
                      kids[index]?.props.value === authored,
              )?.value ?? authored)
    return (
        // .docs-tabs keys the bare-underline restyle in app.css (the default
        // renders content tabs as an underlined row, not fumadocs' boxed
        // gray container). CodeBlockTabs stay boxed and unaffected.
        <FumaTabs
            groupId={groupId}
            persist
            {...props}
            defaultValue={slugOf(props.defaultValue) ?? tabs[0]?.value}
            className={cn("tabs docs-tabs", props.className)}
        >
            <TabsList>
                {tabs.map((tab) => (
                    <TabsTrigger key={tab.value} value={tab.value}>
                        {tab.icon ? (
                            <span className="inline-flex items-center gap-1.5 [&_svg]:size-4">
                                <span className="tab-icon contents">
                                    {tab.icon}
                                </span>
                                {tab.label}
                            </span>
                        ) : (
                            tab.label
                        )}
                    </TabsTrigger>
                ))}
            </TabsList>
            {kids.map((child, index) =>
                cloneElement(child, {
                    key: tabs[index]?.value,
                    value: tabs[index]?.value,
                    forceMount: true,
                }),
            )}
        </FumaTabs>
    )
}

function Tab({
    title: _title,
    icon: _icon,
    ...props
}: ComponentProps<typeof FumaTab> & { title?: string; icon?: ReactNode }) {
    return <FumaTab {...props} />
}

/**
 * Authored Step carries a title (plus icon/stepNumber/titleSize); fumadocs
 * Step is a bare children-only div, so the fd-step wrapper renders here —
 * its CSS marker (base.css ::before counter) needs the class, and the
 * overrides need a real element: `stepNumber` seeds the CSS counter
 * (counter-set lands before the ::before increment), `icon` replaces the
 * number bubble (app.css blanks the counter under [data-step-icon]).
 */
function Step({
    children,
    title,
    icon,
    stepNumber,
    titleSize,
}: {
    children?: ReactNode
    title?: string
    icon?: ReactNode
    stepNumber?: number | string
    titleSize?: string
}) {
    const resolvedIcon = iconFromName(icon, useBasePath())
    const parsedNumber = Number(stepNumber)
    const TitleTag = titleSize === "h2" || titleSize === "h3" ? titleSize : "p"
    return (
        <div
            className="step fd-step"
            {...(resolvedIcon ? { "data-step-icon": "" } : {})}
            style={
                Number.isFinite(parsedNumber) && parsedNumber > 0
                    ? { counterSet: `step ${parsedNumber - 1}` }
                    : undefined
            }
        >
            {resolvedIcon ? (
                <span
                    aria-hidden
                    className="-start-4 absolute flex size-8 items-center justify-center rounded-full bg-fd-secondary text-fd-secondary-foreground [&_svg]:size-4"
                >
                    {resolvedIcon}
                </span>
            ) : null}
            {title ? (
                <TitleTag
                    className={cn(
                        "font-medium",
                        TitleTag !== "p" && "not-prose mb-2 text-fd-foreground",
                        TitleTag === "h2" && "text-xl",
                        TitleTag === "h3" && "text-lg",
                    )}
                >
                    {title}
                </TitleTag>
            ) : null}
            {children}
        </div>
    )
}

function SafeLink({ href, children, ...props }: ComponentProps<"a">) {
    const base = useBasePath()
    // No href: a fragment target (`<a id="details">`), harmless as is.
    if (!href) return <a {...props}>{children}</a>
    // Classify what the browser will resolve: it strips leading/trailing
    // spaces and C0 controls, drops tabs and newlines anywhere, and reads
    // "\" like "/" in http(s) URLs. A leading "//" (in any of those
    // disguises) is another host, so it is refused like any unsafe href.
    // Plain relative paths ("guide", "?tab=2") carry no scheme: no colon
    // before the first "/", "?" or "#". (No URL parsing: this also renders
    // in the SSR isolate, which has no URL.)
    const resolved = href
        // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers strip exactly these C0 controls
        .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
        .replace(/[\t\n\r]/g, "")
    if (
        /^[/\\]{2}/.test(resolved) ||
        (!safeHrefSchema.test(resolved) && /^[^/?#]*:/.test(resolved))
    )
        return (
            <span id={props.id} className={props.className}>
                {children}
            </span>
        )
    // Match fumadocs' Link (used inside Cards/prev-next): external targets
    // open in a new tab — plain markdown links were the inconsistent ones.
    const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(resolved)
    return (
        <a
            href={withBase(href, base)}
            {...(external
                ? { target: "_blank", rel: "noreferrer noopener" }
                : {})}
            {...props}
            className={cn("link", props.className)}
        >
            {children}
        </a>
    )
}

// Authors may write a bare <Accordion> with no surrounding <AccordionGroup>,
// but fumadocs' Accordion is a radix item that throws outside its Accordions
// root. Track group membership so standalone accordions self-wrap.
const InsideAccordionGroup = createContext(false)

function AccordionGroup(props: ComponentProps<typeof Accordions>) {
    return (
        <InsideAccordionGroup.Provider value={true}>
            <Accordions
                {...props}
                className={cn("accordion-group", props.className)}
            />
        </InsideAccordionGroup.Provider>
    )
}

/**
 * fumadocs' docs-level Accordion recomposed over the ui primitives with ONE
 * change: `asChild` renders the header as a div instead of Radix's fixed
 * h3, which put every accordion question into the document outline —
 * official accordion labels are not headings. Hash auto-open
 * keeps working: Accordions scans [data-accordion-value] on mount, and the
 * div still carries the id + value.
 */
function AccordionEntry({
    title,
    id,
    value,
    children,
    ...props
}: Omit<ComponentProps<typeof AccordionItem>, "value" | "title"> & {
    title?: ReactNode
    id?: string
    value?: string
    children?: ReactNode
}) {
    const resolvedValue = value ?? String(title)
    return (
        <AccordionItem
            value={resolvedValue}
            {...props}
            className={cn("accordion", props.className)}
        >
            <AccordionHeader asChild>
                <div id={id} data-accordion-value={resolvedValue}>
                    <AccordionTrigger>{title}</AccordionTrigger>
                    {id ? <AccordionCopyButton id={id} /> : null}
                </div>
            </AccordionHeader>
            <AccordionContent>
                <div className="prose-no-margin px-4 pb-2 text-[0.9375rem]">
                    {children}
                </div>
            </AccordionContent>
        </AccordionItem>
    )
}

/**
 * Copy-failure toast title, rendered by the root Toaster — which sits under
 * the router, so it reads the current pathname's locale. The MDX components
 * that raise it also render in the router-less SSR sandbox and can't call
 * useChromeStrings themselves.
 */
function CopyFailedTitle() {
    return useChromeStrings().copyFailed
}

const CopiedIcon = chromeIcon("check")
const CopyLinkIcon = chromeIcon("link")

function AccordionCopyButton({ id }: { id: string }) {
    const clipboard = useCopyToClipboard(1_500)
    const copied = clipboard.state === "copied"
    return (
        <button
            type="button"
            aria-label="Copy Link"
            className="me-2 rounded-md p-2 text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
            onClick={() => {
                const url = new URL(window.location.href)
                url.hash = id
                void clipboard.copy(url.toString()).then((ok) => {
                    if (!ok) {
                        toast.add({
                            title: <CopyFailedTitle />,
                            type: "error",
                        })
                    }
                })
            }}
        >
            {copied ? (
                <CopiedIcon className="size-3.5" />
            ) : (
                <CopyLinkIcon className="size-3.5" />
            )}
        </button>
    )
}

function AccordionOrStandalone(props: ComponentProps<typeof AccordionEntry>) {
    const grouped = useContext(InsideAccordionGroup)
    if (grouped) return <AccordionEntry {...props} />
    return (
        <Accordions type="single" collapsible>
            <AccordionEntry {...props} />
        </Accordions>
    )
}

/**
 * Expandable — collapsible nested-attribute block, used inside
 * ParamField/ResponseField trees ("Show child attributes").
 */
function Expandable({
    title,
    defaultOpen,
    children,
}: {
    title?: string
    defaultOpen?: boolean
    children?: ReactNode
}) {
    return (
        <details
            className="expandable group my-3 rounded-lg border border-fd-border"
            open={defaultOpen === true}
        >
            <summary className="cursor-pointer select-none px-3 py-2 font-medium text-fd-muted-foreground text-sm group-open:border-fd-border group-open:border-b">
                <span className="group-open:hidden">Show </span>
                <span className="hidden group-open:inline">Hide </span>
                {title ?? "child attributes"}
            </summary>
            <div className="px-3 py-1">{children}</div>
        </details>
    )
}

/** Icon — inline icon, resolved from the Hugeicons map at ingest. */
function DocsIcon({
    icon,
    size,
    color,
}: {
    icon?: string
    size?: number | string
    color?: string
    iconType?: string
}) {
    const base = useBasePath()
    const parsed = Number(size)
    const dimension =
        Number.isFinite(parsed) && parsed > 0 && parsed <= 128 ? parsed : 16
    const trimmed = icon?.trim()
    // Image refs (ingest-hashed /_assets URLs, allow-listed https) render as
    // a sized image; Card already does this, <Icon> never did.
    if (trimmed && iconIsImageRef(trimmed)) {
        return (
            // biome-ignore lint/performance/noImgElement: site icon assets are served from the docs asset store, not next/image
            <img
                src={withBase(trimmed, base)}
                alt=""
                aria-hidden
                // not-prose: prose's block-image margins (2em above and
                // below) lifted the inline icon off its text line.
                className="not-prose inline-block shrink-0 object-contain align-[-0.125em]"
                style={{ width: dimension, height: dimension }}
            />
        )
    }
    // Ingest resolves `icon="rocket"` to the map's inline SVG before the
    // body is stored (docs-ingest icons.ts); a name that survived is one the
    // map lacks.
    const svg = trustedInlineSvg(trimmed)
    if (!svg) return null
    return (
        <span
            className="icon inline-flex shrink-0 align-[-0.125em] [&>svg]:size-full"
            style={{ width: dimension, height: dimension, color }}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: SVGs come from the committed icon map, not site input
            dangerouslySetInnerHTML={{ __html: svg }}
        />
    )
}

/** Prompt's deep-link actions: label and URL prefix, the prompt appended
 * URL-encoded. */
const PROMPT_DEEP_LINKS = {
    cursor: {
        label: "Open in Cursor",
        href: "cursor://anysphere.cursor-deeplink/prompt?text=",
    },
    claude: { label: "Open in Claude Code", href: "claude://code/new?q=" },
    codex: { label: "Open in Codex", href: "codex://threads/new?prompt=" },
} as const

/**
 * Prompt — a compact AI-prompt card (the mirror dumped
 * entire agent-setup prompts inline, 2.5× the official body length). The
 * body clamps to a preview with a fade + explicit expand control; Copy is
 * always present, and `actions` entries `"cursor"`, `"claude"` and
 * `"codex"` add each client's prompt deep link, in the authored order. The
 * full text stays in the (overflow-clipped) DOM, so Copy and the deep links
 * always carry the whole prompt.
 */
function Prompt({
    description,
    children,
    actions,
}: {
    description?: string
    children?: ReactNode
    actions?: unknown
}) {
    const bodyRef = useRef<HTMLDivElement>(null)
    const clipboard = useCopyToClipboard(1_500)
    const copied = clipboard.state === "copied"
    const parsedActions = zodCatch(
        array(zodEnum(["copy", "cursor", "claude", "codex"])),
        ["copy"],
    ).parse(actions ?? ["copy"])
    // Prompt never shows the prompt text: one row with the
    // description and the actions; the body stays in the DOM (hidden) so
    // copy/deeplink read the authored text with its line structure.
    const promptText = () => bodyRef.current?.innerText ?? ""
    return (
        <div
            className="prompt my-6 flex flex-wrap items-center gap-x-6 gap-y-4 rounded-2xl border border-fd-border p-4"
            data-component-part="prompt"
        >
            <div
                className="not-prose flex min-w-0 flex-1 items-start gap-2 text-sm"
                data-component-part="prompt-description"
            >
                {description ?? "Prompt"}
            </div>
            <div
                className="ms-auto flex shrink-0 items-center gap-1.5 print:hidden"
                data-component-part="prompt-actions-wrapper"
            >
                <button
                    type="button"
                    data-component-part="prompt-action-copy-button"
                    aria-label="Copy prompt"
                    className="inline-flex h-[26px] shrink-0 items-center gap-1 rounded-lg bg-margin-button px-2 font-medium text-margin-button-foreground text-xs transition-colors hover:bg-margin-button/90"
                    onClick={() => {
                        const text = promptText()
                        if (!text) return
                        void clipboard.copy(text).then((ok) => {
                            if (!ok) {
                                toast.add({
                                    title: <CopyFailedTitle />,
                                    type: "error",
                                })
                            }
                        })
                    }}
                >
                    {copied ? "Copied" : "Copy prompt"}
                </button>
                {[...new Set(parsedActions)].map((action) =>
                    action === "copy" ? null : (
                        <button
                            key={action}
                            type="button"
                            data-component-part={`prompt-action-${action}-button`}
                            className="inline-flex h-[26px] shrink-0 items-center gap-1 rounded-lg border border-fd-border px-2 font-medium text-fd-foreground text-xs transition-colors hover:bg-fd-accent"
                            onClick={() => {
                                const text = promptText()
                                if (!text) return
                                window.location.href = `${PROMPT_DEEP_LINKS[action].href}${encodeURIComponent(text)}`
                            }}
                        >
                            {PROMPT_DEEP_LINKS[action].label}
                        </button>
                    ),
                )}
            </div>
            {/* innerText of a display:none subtree collapses to textContent
                (no line breaks), so hide it off-canvas instead — inert, so
                links or buttons inside the prompt never take focus. */}
            <div
                ref={bodyRef}
                aria-hidden
                inert
                className="-left-[9999px] absolute h-px w-px overflow-hidden text-sm"
            >
                {children}
            </div>
        </div>
    )
}

function TreeFile({
    name,
    ...props
}: Omit<ComponentProps<typeof FumaFile>, "name"> & { name?: string }) {
    return (
        <FumaFile
            name={name ?? ""}
            {...props}
            className={cn("tree-file", props.className)}
        />
    )
}

function TreeFolder({
    name,
    ...props
}: Omit<ComponentProps<typeof FumaFolder>, "name"> & { name?: string }) {
    return (
        <FumaFolder
            name={name ?? ""}
            {...props}
            className={cn("tree-folder", props.className)}
        />
    )
}

/**
 * FileTree / Tree — member components (<Tree.File>) authorize by
 * their root name at ingest, so the members live on the function object.
 */
const Tree = Object.assign(
    function Tree({ children }: { children?: ReactNode }) {
        return <FumaFiles className="tree my-6">{children}</FumaFiles>
    },
    { File: TreeFile, Folder: TreeFolder },
)

/** PreviewButton — a link styled as a small filled button. */
function PreviewButton({
    href,
    children,
}: {
    href?: string
    children?: ReactNode
}) {
    const base = useBasePath()
    if (!href || !safeHrefSchema.test(href)) return null
    return (
        <a
            href={withBase(href, base)}
            className="my-2 inline-flex items-center gap-1 rounded-full bg-margin-button px-4 py-1.5 font-medium text-margin-button-foreground text-sm no-underline hover:opacity-90"
        >
            {children}
        </a>
    )
}

/**
 * Tile — a visual preview card: a fixed-height preview pane
 * (children, usually an image) above title + description. The grid comes
 * from <Columns>, matching the authoring shape.
 */
function Tile({
    href,
    title,
    description,
    children,
}: {
    href?: string
    title?: string
    description?: string
    children?: ReactNode
}) {
    // Compiled pages can supply runtime hrefs that bypass ingest checks.
    // Allow bare relative paths, but reject unsafe schemes and protocol-relative
    // URLs after browser-style whitespace normalization.
    const normalizedHref =
        typeof href === "string"
            ? href.replace(/[\t\n\r]/g, "").trim()
            : undefined
    const linked =
        normalizedHref !== undefined &&
        normalizedHref.length > 0 &&
        !normalizedHref.startsWith("//") &&
        (safeHrefSchema.test(normalizedHref) ||
            !/^[a-z][a-z0-9+.-]*:/i.test(normalizedHref))
    const Root = linked ? FumaLink : "div"
    return (
        <Root
            {...(linked ? { href: normalizedHref } : {})}
            data-card
            className="tile group block min-w-0 overflow-hidden rounded-xl border bg-fd-card text-fd-card-foreground transition-colors hover:border-fd-primary/50"
        >
            <div className="flex h-40 items-center justify-center overflow-hidden border-b bg-fd-muted/40 p-4 [&_img]:my-0 [&_img]:max-h-full [&_img]:w-auto [&_svg]:max-h-full">
                {children}
            </div>
            {/* Tiles centre the caption under the preview. */}
            <div className="p-4 text-center">
                {title ? (
                    <span className="not-prose mb-1 block font-medium text-sm">
                        {title}
                    </span>
                ) : null}
                {description ? (
                    <p className="my-0! text-fd-muted-foreground text-sm">
                        {description}
                    </p>
                ) : null}
            </div>
        </Root>
    )
}

// ── Color palette (click-to-copy swatches) ──────────────────────────────────
const ColorVariantContext = createContext<"compact" | "table">("compact")

const colorPairSchema = object({ light: string(), dark: string() })

/**
 * One swatch. `value` is a CSS color string or a {light, dark} pair (the
 * pair renders scheme-aware via the .dark class); click copies the hex of
 * the scheme currently on screen.
 */
function ColorItem({ name, value }: { name?: string; value?: unknown }) {
    const variant = useContext(ColorVariantContext)
    const strings = useChromeStrings()
    const clipboard = useCopyToClipboard(1_500)
    const copied = clipboard.state === "copied"
    const pair = colorPairSchema.safeParse(value)
    const light = pair.success
        ? pair.data.light
        : typeof value === "string"
          ? value
          : null
    const dark = pair.success ? pair.data.dark : null
    if (!light) return null
    const copy = () => {
        const active =
            dark && document.documentElement.classList.contains("dark")
                ? dark
                : light
        // "Copied!" stays success-only; a denied clipboard surfaces as a
        // toast.
        void clipboard.copy(active).then((ok) => {
            if (!ok) toast.add({ title: strings.copyFailed, type: "error" })
        })
    }
    // backgroundColor via the style OBJECT: an invalid/hostile value is
    // discarded by CSSOM — it can never smuggle another declaration in.
    const swatch = (className: string) => (
        <>
            <span
                aria-hidden
                className={cn(className, dark && "dark:hidden")}
                style={{ backgroundColor: light }}
            />
            {dark ? (
                <span
                    aria-hidden
                    className={cn(className, "hidden dark:block")}
                    style={{ backgroundColor: dark }}
                />
            ) : null}
        </>
    )
    const label = copied ? strings.copied : (dark ?? light)
    if (variant === "table") {
        return (
            <button
                type="button"
                onClick={copy}
                className="flex w-full items-center gap-3 rounded-lg p-2 text-start transition-colors hover:bg-fd-accent/50"
            >
                {swatch("size-8 shrink-0 rounded-md border")}
                <span className="flex-1 font-medium text-sm">{name}</span>
                <code className="font-mono text-fd-muted-foreground text-xs">
                    {copied
                        ? strings.copied
                        : dark
                          ? `${light} / ${dark}`
                          : light}
                </code>
            </button>
        )
    }
    return (
        <button
            type="button"
            onClick={copy}
            className="group/swatch flex min-w-0 flex-col gap-1.5 text-start"
        >
            {swatch(
                "block h-14 w-full rounded-lg border transition-transform group-hover/swatch:scale-[1.02]",
            )}
            {name ? (
                <span className="truncate font-medium text-xs">{name}</span>
            ) : null}
            <code className="truncate font-mono text-fd-muted-foreground text-xs">
                {label}
            </code>
        </button>
    )
}

/** A titled group of swatches — the table variant's section row. */
function ColorRow({
    title,
    children,
}: {
    title?: string
    children?: ReactNode
}) {
    const variant = useContext(ColorVariantContext)
    return (
        <div className={variant === "table" ? "flex flex-col" : "contents"}>
            {title ? (
                <div className="px-2 pt-3 pb-1 font-medium text-fd-muted-foreground text-xs tracking-wide">
                    {title}
                </div>
            ) : null}
            {variant === "table" ? (
                children
            ) : (
                <div className="col-span-full grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3">
                    {children}
                </div>
            )}
        </div>
    )
}

/**
 * Color — palette container; members live on the function object
 * (<Color.Item>, <Color.Row>) like Tree.File.
 */
const Color = Object.assign(
    function Color({
        variant,
        children,
    }: {
        variant?: string
        children?: ReactNode
    }) {
        const resolved = variant === "table" ? "table" : "compact"
        return (
            <ColorVariantContext.Provider value={resolved}>
                <div
                    className={cn(
                        "not-prose my-6",
                        resolved === "table"
                            ? "flex flex-col rounded-xl border p-2"
                            : "grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-3",
                    )}
                >
                    {children}
                </div>
            </ColorVariantContext.Provider>
        )
    },
    { Item: ColorItem, Row: ColorRow },
)

/**
 * Pipeline vocabulary that is NOT authorable: fumadocs' remarkCodeTab (in
 * the ingest compiler's default chain) emits these into compiled trees for
 * tabbed code groups, so the runtime must render them even though the
 * authoring allow-list rejects them.
 */
const pipelineComponents = {
    // The code-group hooks site stylesheets target.
    CodeBlockTab: (props: ComponentProps<typeof CodeBlockTab>) => (
        <CodeBlockTab data-component-part="code-group-tab-content" {...props} />
    ),
    CodeBlockTabs: (props: ComponentProps<typeof CodeBlockTabs>) => (
        <CodeBlockTabs
            {...props}
            className={cn("code-group", props.className)}
        />
    ),
    CodeBlockTabsList: (props: ComponentProps<typeof CodeBlockTabsList>) => (
        <CodeBlockTabsList
            data-component-part="code-group-tab-bar"
            {...props}
        />
    ),
    CodeBlockTabsTrigger: CodeTabTrigger,
    // remark-view-groups (ingest) wraps consecutive <View> runs in this
    // synthetic selector group; an authored <ViewGroup> never survives the
    // allow-list, so only pipeline-emitted ones render.
    ViewGroup,
    // The ingest compiler renames authored <iframe>, <img>, <video> and <a>
    // JSX to these on the compiled-JS path, which MDX would otherwise emit
    // as bare intrinsics (the same components the element map below uses).
    SandboxedIframe,
    ArticleImage,
    DocsVideo,
    SafeLink,
}

/**
 * Every name in ALLOWED_MDX_COMPONENTS must render — ingest validation admits
 * exactly these, and a missing entry throws _missingMdxReference at render
 * time, killing the whole page. The `satisfies` pin makes an allow-list
 * addition without a runtime mapping a compile error.
 */
const allowedComponents = {
    // Asymmetric authoring (see src/ingest/remark-agent-blocks.ts):
    // <Agent> is agent-only — hidden in the human HTML render.
    Agent: () => null,
    // <Human> is human-only — rendered here, stripped from the agent markdown.
    Human: ({ children }: { children?: ReactNode }) => children,
    // Visibility — the canonical spelling of the Agent/Human pair:
    // for="agents" hides here (the agent markdown keeps it); anything else
    // renders for humans.
    Visibility: ({
        for: audience,
        children,
    }: {
        for?: string
        children?: ReactNode
    }) => (audience === "agents" ? null : children),
    Callout: TintedCallout,
    Note: (props: ComponentProps<typeof Callout>) => (
        <TintedCallout {...props} type="info" tone="note" />
    ),
    // Info is a NEUTRAL gray panel — distinct from the blue Note
    // even though both map to fumadocs' "info" type (CSS overrides the hue).
    Info: (props: ComponentProps<typeof Callout>) => (
        <TintedCallout {...props} type="info" tone="info" />
    ),
    // Green distinguishes Tip from fumadocs' amber "idea"/Warning tone.
    Tip: (props: ComponentProps<typeof Callout>) => (
        <TintedCallout {...props} type="success" tone="tip" />
    ),
    Warning: (props: ComponentProps<typeof Callout>) => (
        <TintedCallout {...props} type="warning" tone="warning" />
    ),
    Check: (props: ComponentProps<typeof Callout>) => (
        <TintedCallout {...props} type="success" tone="check" />
    ),
    Accordion: AccordionOrStandalone,
    AccordionGroup,
    Badge,
    Card: IconCard,
    // CardGroup is the older name for Columns — same grid.
    CardGroup: Columns,
    // Image gets the same zoom + loading treatment as markdown images.
    Image: ArticleImage,
    ParamField,
    ResponseField: ParamField,
    Tab,
    Tabs,
    CodeGroup,
    Columns,
    Frame,
    // Expanded into page content at ingest; never reaches the runtime.
    Snippet: () => null,
    Step,
    Steps,
    Tooltip,
    Update,
    Mermaid,
    Expandable,
    Icon: DocsIcon,
    Prompt,
    Danger: (props: ComponentProps<typeof Callout>) => (
        <TintedCallout {...props} type="error" tone="error" />
    ),
    // These belong in the right example column; until that column
    // exists they render as the same tabbed code group inline.
    RequestExample: CodeGroup,
    ResponseExample: CodeGroup,
    FileTree: Tree,
    Tree,
    PreviewButton,
    // Panel swaps the TOC column; inline passthrough until then.
    Panel: ({ children }: { children?: ReactNode }) => children,
    Tile,
    Color,
    // Content variations — always rendered inside the synthetic
    // <ViewGroup> the ingest pipeline wraps around consecutive Views.
    View,
    // <GitHub.Repo>: live repository card (client-side fetch).
    GitHub,
} satisfies Record<AllowedMdxComponent, ElementType>

/**
 * Per-article image counter. The first image of an article is the likely
 * LCP candidate, so it loads eagerly at high fetch priority; every later one
 * lazy-loads and decodes off the main thread. `ArticleImages` wraps the
 * article body and resets the counter on each of its renders, so the server
 * render and hydration assign identical indexes; each image claims its index
 * once, so a stateful re-render never demotes it. Bodies rendered outside a
 * provider (the 404 page, the page rail) lazy-load every image.
 */
const ArticleImageCounter = createContext<{ current: number } | null>(null)

export function ArticleImages({ children }: { children: ReactNode }) {
    const counter = useRef(0)
    counter.current = 0
    return (
        <ArticleImageCounter.Provider value={counter}>
            {children}
        </ArticleImageCounter.Provider>
    )
}

/**
 * Markdown `img` and the `<Image>` component alike. ImageZoom keeps fumadocs'
 * responsive <img> underneath and passes authored width/height through
 * (ingest emits intrinsic sizes so the article doesn't reflow as images
 * arrive); authored loading/decoding/fetchPriority attributes win.
 */
function ArticleImage({
    alt,
    loading,
    decoding,
    fetchPriority,
    ...props
}: ComponentProps<"img">) {
    const base = useBasePath()
    const counter = useContext(ArticleImageCounter)
    const index = useRef<number | null>(null)
    if (index.current === null) index.current = counter ? counter.current++ : -1
    const first = index.current === 0
    return (
        <ImageZoom
            alt={alt ?? ""}
            loading={loading ?? (first ? "eager" : "lazy")}
            decoding={decoding ?? (first ? "auto" : "async")}
            fetchPriority={fetchPriority ?? (first ? "high" : undefined)}
            {...props}
            src={
                typeof props.src === "string"
                    ? withBase(props.src, base)
                    : props.src
            }
            srcSet={
                props.srcSet === undefined
                    ? assetSrcSet(props.src, props.width, base)
                    : // Each candidate is a URL (data: URLs carry commas),
                      // then descriptors up to the next comma.
                      props.srcSet.replace(
                          /([\s,]*)(\S+)([^,]*,?)/g,
                          (_, lead: string, url: string, rest: string) =>
                              `${lead}${withBase(url, base)}${rest}`,
                      )
            }
        />
    )
}

/** Widths the asset route resizes to (routes/_assets/$hash `?w=`). */
export const ASSET_SRCSET_WIDTHS = [640, 960, 1440, 1920] as const

/**
 * Responsive candidates for stored raster assets: the asset route serves
 * `/_assets/<hash>?w=<width>&f=webp` on demand, so a 3000px screenshot no
 * longer ships at full size to a 648px column. Only widths below the
 * intrinsic width are offered (never upscale); the original stays the
 * largest candidate. SVGs and external URLs are left alone.
 */
function assetSrcSet(
    src: ComponentProps<"img">["src"],
    width: ComponentProps<"img">["width"],
    base: string,
): string | undefined {
    if (typeof src !== "string" || !/^\/_assets\/[0-9a-f]{64}$/.test(src))
        return undefined
    const intrinsic = Number(width)
    if (!Number.isFinite(intrinsic) || intrinsic <= ASSET_SRCSET_WIDTHS[0])
        return undefined
    const url = withBase(src, base)
    const candidates = ASSET_SRCSET_WIDTHS.filter((w) => w < intrinsic).map(
        (w) => `${url}?w=${w}&f=webp ${w}w`,
    )
    candidates.push(`${url} ${Math.round(intrinsic)}w`)
    return candidates.join(", ")
}

/**
 * Video-embed hosts whose players need allow-same-origin to boot (YouTube
 * renders a black frame without it). Everything else keeps the strict
 * sandbox. Cross-origin iframes with allow-same-origin still cannot touch
 * the docs origin; the flag only lets the embed read its own storage.
 */
const SAME_ORIGIN_EMBED_HOSTS = new Set([
    "youtube.com",
    "www.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
    "player.vimeo.com",
    "loom.com",
    "www.loom.com",
])

/**
 * Sandboxed https-only iframe (ingest already rejects other schemes and
 * srcdoc/on* attributes; the sandbox grants allow-same-origin only to the
 * known video-player hosts above, so arbitrary embeds cannot script the
 * docs origin).
 */
function SandboxedIframe({ src, title }: ComponentProps<"iframe">) {
    if (!src || !/^https:\/\//i.test(src)) return null
    // No URL global in the SSR isolate (compiled pages render this too):
    // read the host off the authority, which ends where WHATWG ends it for
    // https (a backslash is a path separator there). Userinfo, encodings or
    // anything else a browser could resolve to another host is ambiguous:
    // no host, so the strict sandbox.
    const authority = /^https:\/\/([^/?#\\]*)/i.exec(src)?.[1] ?? ""
    const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(authority)
        ? authority.replace(/:\d+$/, "").toLowerCase()
        : ""
    const sandbox = SAME_ORIGIN_EMBED_HOSTS.has(host)
        ? "allow-scripts allow-same-origin allow-popups"
        : "allow-scripts allow-popups"
    return (
        <iframe
            src={src}
            title={title ?? "Embedded content"}
            loading="lazy"
            sandbox={sandbox}
            allowFullScreen
            className="my-6 aspect-video w-full rounded-xl border border-fd-border"
        />
    )
}

export function getMDXComponents(components?: MDXComponents) {
    return {
        ...defaultMdxComponents,
        ...pipelineComponents,
        ...allowedComponents,
        a: SafeLink,
        pre: DocsCodeBlock,
        video: DocsVideo,
        iframe: SandboxedIframe,
        // Click-to-zoom on article images (every official site
        // exposes image expanders — 38–413 per site; the mirrors had zero).
        img: ArticleImage,
        ...components,
    } satisfies MDXComponents
}

export const useMDXComponents = getMDXComponents

declare global {
    type MDXProvidedComponents = ReturnType<typeof getMDXComponents>
}
