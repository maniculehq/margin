import { getRouteApi, useLocation } from "@tanstack/react-router"
import type { Translations } from "fumadocs-ui/i18n"
import { createContext, use } from "react"

/**
 * Framework-owned chrome copy, localised per site locale. fumadocs' own
 * strings (TOC heading, search dialog, pagination, theme switcher…) travel
 * through `RootProvider`'s `i18n.translations` (FUMADOCS_TRANSLATIONS below);
 * everything the framework renders itself reads `useChromeStrings()`.
 * Unknown locales fall back to English.
 */
export const CHROME_LOCALES = ["en", "fr", "es", "zh"] as const
export type ChromeLocale = (typeof CHROME_LOCALES)[number]

export interface ChromeStrings {
    search: string
    assistant: string
    /** Chat role label for the visitor's own messages. */
    you: string
    askQuestion: string
    askAssistant: string
    askAiAboutCode: string
    reportIssue: string
    suggestions: string
    maximize: string
    minimize: string
    copyPage: string
    copyPageMarkdown: string
    openInChatGPT: string
    openInClaude: string
    connectMcp: string
    wasHelpful: string
    yes: string
    no: string
    thanksFeedback: string
    suggestEdits: string
    raiseIssue: string
    previous: string
    next: string
    onThisPage: string
    pageNotFound: string
    pageNotFoundBody: string
    openRss: string
    tryIt: string
    deprecated: string
    showFullPrompt: string
    collapsePrompt: string
    copied: string
    language: string
    backToHome: string
    skipToContent: string
    aiDisclaimer: string
    close: string
    lastUpdatedOn: string
    /** Search dialog empty state; the quoted query follows. */
    nothingFor: string
    /** Search dialog footer key hints + result count label. */
    select: string
    open: string
    results: string
    /** Assistant input placeholder while an answer streams. */
    aiAnswering: string
    /** Assistant search-tool chip states; the quoted query follows. */
    searchFailed: string
    searching: string
    searched: string
    helpful: string
    notHelpful: string
    /** Assistant input actions + streaming abort. */
    retry: string
    clearChat: string
    abortAnswer: string
    /** Assistant transport error heading; the error name follows. */
    requestFailed: string
    copyFailed: string
    pageLoadFailed: string
}

const en: ChromeStrings = {
    search: "Search...",
    assistant: "Assistant",
    you: "You",
    askQuestion: "Ask a question",
    askAssistant: "Ask Assistant",
    askAiAboutCode: "Ask AI about this code",
    reportIssue: "Report issue",
    suggestions: "Suggestions",
    maximize: "Maximize",
    minimize: "Minimize",
    copyPage: "Copy page",
    copyPageMarkdown: "Copy page as Markdown for LLMs",
    openInChatGPT: "Open in ChatGPT",
    openInClaude: "Open in Claude",
    connectMcp: "Connect MCP server",
    wasHelpful: "Was this page helpful?",
    yes: "Yes",
    no: "No",
    thanksFeedback: "Thanks for your feedback!",
    suggestEdits: "Suggest edits",
    raiseIssue: "Raise issue",
    previous: "Previous",
    next: "Next",
    onThisPage: "On this page",
    pageNotFound: "Page not found",
    pageNotFoundBody:
        "The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.",
    openRss: "Open RSS feed",
    tryIt: "Try it",
    deprecated: "Deprecated",
    showFullPrompt: "Show full prompt",
    collapsePrompt: "Collapse prompt",
    copied: "Copied!",
    language: "Language",
    backToHome: "Back to home",
    skipToContent: "Skip to content",
    aiDisclaimer: "AI can be inaccurate, please verify the answers.",
    close: "Close",
    lastUpdatedOn: "Last updated on",
    nothingFor: "Nothing for",
    select: "Select",
    open: "Open",
    results: "Results",
    aiAnswering: "AI is answering...",
    searchFailed: "Failed to search",
    searching: "Searching",
    searched: "Searched",
    helpful: "Helpful",
    notHelpful: "Not helpful",
    retry: "Retry",
    clearChat: "Clear chat",
    abortAnswer: "Abort answer",
    requestFailed: "Request failed",
    copyFailed: "Couldn't copy to the clipboard.",
    pageLoadFailed: "Couldn't load this page's content.",
}

export const CHROME_STRINGS: Record<ChromeLocale, ChromeStrings> = {
    en,
    fr: {
        search: "Rechercher...",
        assistant: "Assistant",
        you: "Vous",
        askQuestion: "Poser une question",
        askAssistant: "Demander à l'assistant",
        askAiAboutCode: "Demander à l'IA à propos de ce code",
        reportIssue: "Signaler un problème",
        suggestions: "Suggestions",
        maximize: "Agrandir",
        minimize: "Réduire",
        copyPage: "Copier la page",
        copyPageMarkdown: "Copier la page en Markdown pour les LLM",
        openInChatGPT: "Ouvrir dans ChatGPT",
        openInClaude: "Ouvrir dans Claude",
        connectMcp: "Connecter le serveur MCP",
        wasHelpful: "Cette page vous a-t-elle été utile ?",
        yes: "Oui",
        no: "Non",
        thanksFeedback: "Merci pour votre retour !",
        suggestEdits: "Suggérer des modifications",
        raiseIssue: "Signaler un problème",
        previous: "Précédent",
        next: "Suivant",
        onThisPage: "Sur cette page",
        pageNotFound: "Page introuvable",
        pageNotFoundBody:
            "La page que vous recherchez a peut-être été supprimée, renommée ou est temporairement indisponible.",
        openRss: "Ouvrir le flux RSS",
        tryIt: "Essayer",
        deprecated: "Obsolète",
        showFullPrompt: "Afficher le prompt complet",
        collapsePrompt: "Replier le prompt",
        copied: "Copié !",
        language: "Langue",
        backToHome: "Retour à l'accueil",
        skipToContent: "Aller au contenu",
        aiDisclaimer: "L'IA peut se tromper, veuillez vérifier les réponses.",
        close: "Fermer",
        lastUpdatedOn: "Dernière mise à jour le",
        nothingFor: "Aucun résultat pour",
        select: "Sélectionner",
        open: "Ouvrir",
        results: "Résultats",
        aiAnswering: "L'IA répond...",
        searchFailed: "Échec de la recherche",
        searching: "Recherche de",
        searched: "Recherche effectuée pour",
        helpful: "Utile",
        notHelpful: "Pas utile",
        retry: "Réessayer",
        clearChat: "Effacer la conversation",
        abortAnswer: "Interrompre la réponse",
        requestFailed: "Échec de la requête",
        copyFailed: "Impossible de copier dans le presse-papiers.",
        pageLoadFailed: "Impossible de charger le contenu de cette page.",
    },
    es: {
        search: "Buscar...",
        assistant: "Asistente",
        you: "Tú",
        askQuestion: "Haz una pregunta",
        askAssistant: "Preguntar al asistente",
        askAiAboutCode: "Preguntar a la IA sobre este código",
        reportIssue: "Informar de un problema",
        suggestions: "Sugerencias",
        maximize: "Maximizar",
        minimize: "Minimizar",
        copyPage: "Copiar página",
        copyPageMarkdown: "Copiar página como Markdown para LLM",
        openInChatGPT: "Abrir en ChatGPT",
        openInClaude: "Abrir en Claude",
        connectMcp: "Conectar servidor MCP",
        wasHelpful: "¿Te ha resultado útil esta página?",
        yes: "Sí",
        no: "No",
        thanksFeedback: "¡Gracias por tu opinión!",
        suggestEdits: "Sugerir cambios",
        raiseIssue: "Abrir una incidencia",
        previous: "Anterior",
        next: "Siguiente",
        onThisPage: "En esta página",
        pageNotFound: "Página no encontrada",
        pageNotFoundBody:
            "La página que buscas puede haber sido eliminada, renombrada o no estar disponible temporalmente.",
        openRss: "Abrir feed RSS",
        tryIt: "Probar",
        deprecated: "Obsoleto",
        showFullPrompt: "Mostrar el prompt completo",
        collapsePrompt: "Contraer el prompt",
        copied: "¡Copiado!",
        language: "Idioma",
        backToHome: "Volver al inicio",
        skipToContent: "Saltar al contenido",
        aiDisclaimer: "La IA puede equivocarse; verifica las respuestas.",
        close: "Cerrar",
        lastUpdatedOn: "Última actualización el",
        nothingFor: "Nada para",
        select: "Seleccionar",
        open: "Abrir",
        results: "Resultados",
        aiAnswering: "La IA está respondiendo...",
        searchFailed: "Error en la búsqueda",
        searching: "Buscando",
        searched: "Búsqueda realizada de",
        helpful: "Útil",
        notHelpful: "No útil",
        retry: "Reintentar",
        clearChat: "Borrar conversación",
        abortAnswer: "Detener la respuesta",
        requestFailed: "Error en la solicitud",
        copyFailed: "No se pudo copiar al portapapeles.",
        pageLoadFailed: "No se pudo cargar el contenido de esta página.",
    },
    zh: {
        search: "搜索...",
        assistant: "助手",
        you: "您",
        askQuestion: "提问",
        askAssistant: "询问助手",
        askAiAboutCode: "向 AI 询问这段代码",
        reportIssue: "报告问题",
        suggestions: "建议",
        maximize: "最大化",
        minimize: "最小化",
        copyPage: "复制页面",
        copyPageMarkdown: "以 Markdown 格式复制页面（供 LLM 使用）",
        openInChatGPT: "在 ChatGPT 中打开",
        openInClaude: "在 Claude 中打开",
        connectMcp: "连接 MCP 服务器",
        wasHelpful: "此页面对您有帮助吗？",
        yes: "是",
        no: "否",
        thanksFeedback: "感谢您的反馈！",
        suggestEdits: "建议修改",
        raiseIssue: "提交问题",
        previous: "上一页",
        next: "下一页",
        onThisPage: "本页内容",
        pageNotFound: "页面未找到",
        pageNotFoundBody: "您访问的页面可能已被删除、更名或暂时不可用。",
        openRss: "打开 RSS 订阅",
        tryIt: "试一试",
        deprecated: "已弃用",
        showFullPrompt: "显示完整提示词",
        collapsePrompt: "收起提示词",
        copied: "已复制！",
        language: "语言",
        backToHome: "返回首页",
        skipToContent: "跳到内容",
        aiDisclaimer: "AI 可能不准确，请核实答案。",
        close: "关闭",
        lastUpdatedOn: "最后更新于",
        nothingFor: "未找到",
        select: "选择",
        open: "打开",
        results: "结果",
        aiAnswering: "AI 正在回答...",
        searchFailed: "搜索失败",
        searching: "正在搜索",
        searched: "已搜索",
        helpful: "有帮助",
        notHelpful: "没有帮助",
        retry: "重试",
        clearChat: "清空对话",
        abortAnswer: "中止回答",
        requestFailed: "请求失败",
        copyFailed: "无法复制到剪贴板。",
        pageLoadFailed: "无法加载此页面的内容。",
    },
}

/**
 * fumadocs-ui built-in strings per locale (keys are fuma-translate's
 * `Text(note)` encoding, see `fumadocs-ui/dist/.translations/keys.js`).
 * English needs no overrides — the raw keys ARE the English copy.
 */
export const FUMADOCS_TRANSLATIONS: Record<
    ChromeLocale,
    Partial<Translations>
> = {
    en: { displayName: "English" },
    fr: {
        displayName: "Français",
        "On this page(table of contents)": "Sur cette page",
        "Table of Contents(inline table of contents)": "Table des matières",
        "No Headings(table of contents)": "Aucun titre",
        "Search(search dialog)": "Rechercher",
        "Search(search trigger)": "Rechercher",
        "No results found(search dialog)": "Aucun résultat",
        "Open Search(search trigger)(aria-label)": "Ouvrir la recherche",
        "Close Search(search dialog)(aria-label)": "Fermer la recherche",
        "Next Page(pagination)": "Suivant",
        "Previous Page(pagination)": "Précédent",
        "Copy Markdown(page actions)": "Copier en Markdown",
        "View as Markdown(page actions)": "Afficher en Markdown",
        "Open in ChatGPT(page actions)": "Ouvrir dans ChatGPT",
        "Open in Claude(page actions)": "Ouvrir dans Claude",
        "Last updated on(page footer)": "Dernière mise à jour le",
        "Edit on GitHub(edit page)": "Modifier sur GitHub",
        "Page Not Found(404 page)": "Page introuvable",
        "Back to Home(404 page)": "Retour à l'accueil",
        "The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)":
            "La page que vous recherchez a peut-être été supprimée, renommée ou est temporairement indisponible.",
        "Toggle Theme(theme switcher)(aria-label)": "Changer de thème",
        "Light(theme switcher)(aria-label)": "Clair",
        "Dark(theme switcher)(aria-label)": "Sombre",
        "System(theme switcher)(aria-label)": "Système",
        "Open Sidebar(sidebar)(aria-label)": "Ouvrir le menu",
        "Close Sidebar(sidebar)(aria-label)": "Fermer le menu",
        "Close Sidebar(aria-label)": "Fermer le menu",
        "Collapse Sidebar(sidebar)(aria-label)": "Replier le menu",
        "Toggle Menu(mobile menu)(aria-label)": "Menu",
        "Copy Text(code block)(aria-label)": "Copier",
        "Copied Text(code block)(aria-label)": "Copié",
        "Copy Anchor Link(heading anchor)(aria-label)": "Copier le lien",
        "Copy Link(accordion)(aria-label)": "Copier le lien",
        "Close Banner(banner)(aria-label)": "Fermer la bannière",
        "Choose a language(language switcher)": "Choisir une langue",
        "Choose a language(language switcher)(aria-label)":
            "Choisir une langue",
        "Ask AI(AI chat button)": "Demander à l'IA",
    },
    es: {
        displayName: "Español",
        "On this page(table of contents)": "En esta página",
        "Table of Contents(inline table of contents)": "Índice",
        "No Headings(table of contents)": "Sin encabezados",
        "Search(search dialog)": "Buscar",
        "Search(search trigger)": "Buscar",
        "No results found(search dialog)": "Sin resultados",
        "Open Search(search trigger)(aria-label)": "Abrir búsqueda",
        "Close Search(search dialog)(aria-label)": "Cerrar búsqueda",
        "Next Page(pagination)": "Siguiente",
        "Previous Page(pagination)": "Anterior",
        "Copy Markdown(page actions)": "Copiar Markdown",
        "View as Markdown(page actions)": "Ver como Markdown",
        "Open in ChatGPT(page actions)": "Abrir en ChatGPT",
        "Open in Claude(page actions)": "Abrir en Claude",
        "Last updated on(page footer)": "Última actualización el",
        "Edit on GitHub(edit page)": "Editar en GitHub",
        "Page Not Found(404 page)": "Página no encontrada",
        "Back to Home(404 page)": "Volver al inicio",
        "The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)":
            "La página que buscas puede haber sido eliminada, renombrada o no estar disponible temporalmente.",
        "Toggle Theme(theme switcher)(aria-label)": "Cambiar tema",
        "Light(theme switcher)(aria-label)": "Claro",
        "Dark(theme switcher)(aria-label)": "Oscuro",
        "System(theme switcher)(aria-label)": "Sistema",
        "Open Sidebar(sidebar)(aria-label)": "Abrir menú",
        "Close Sidebar(sidebar)(aria-label)": "Cerrar menú",
        "Close Sidebar(aria-label)": "Cerrar menú",
        "Collapse Sidebar(sidebar)(aria-label)": "Contraer menú",
        "Toggle Menu(mobile menu)(aria-label)": "Menú",
        "Copy Text(code block)(aria-label)": "Copiar",
        "Copied Text(code block)(aria-label)": "Copiado",
        "Copy Anchor Link(heading anchor)(aria-label)": "Copiar enlace",
        "Copy Link(accordion)(aria-label)": "Copiar enlace",
        "Close Banner(banner)(aria-label)": "Cerrar banner",
        "Choose a language(language switcher)": "Elige un idioma",
        "Choose a language(language switcher)(aria-label)": "Elige un idioma",
        "Ask AI(AI chat button)": "Preguntar a la IA",
    },
    zh: {
        displayName: "中文",
        "On this page(table of contents)": "本页内容",
        "Table of Contents(inline table of contents)": "目录",
        "No Headings(table of contents)": "没有标题",
        "Search(search dialog)": "搜索",
        "Search(search trigger)": "搜索",
        "No results found(search dialog)": "未找到结果",
        "Open Search(search trigger)(aria-label)": "打开搜索",
        "Close Search(search dialog)(aria-label)": "关闭搜索",
        "Next Page(pagination)": "下一页",
        "Previous Page(pagination)": "上一页",
        "Copy Markdown(page actions)": "复制 Markdown",
        "View as Markdown(page actions)": "以 Markdown 查看",
        "Open in ChatGPT(page actions)": "在 ChatGPT 中打开",
        "Open in Claude(page actions)": "在 Claude 中打开",
        "Last updated on(page footer)": "最后更新于",
        "Edit on GitHub(edit page)": "在 GitHub 上编辑",
        "Page Not Found(404 page)": "页面未找到",
        "Back to Home(404 page)": "返回首页",
        "The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.(404 page)":
            "您访问的页面可能已被删除、更名或暂时不可用。",
        "Toggle Theme(theme switcher)(aria-label)": "切换主题",
        "Light(theme switcher)(aria-label)": "浅色",
        "Dark(theme switcher)(aria-label)": "深色",
        "System(theme switcher)(aria-label)": "跟随系统",
        "Open Sidebar(sidebar)(aria-label)": "打开侧边栏",
        "Close Sidebar(sidebar)(aria-label)": "关闭侧边栏",
        "Close Sidebar(aria-label)": "关闭侧边栏",
        "Collapse Sidebar(sidebar)(aria-label)": "收起侧边栏",
        "Toggle Menu(mobile menu)(aria-label)": "菜单",
        "Copy Text(code block)(aria-label)": "复制",
        "Copied Text(code block)(aria-label)": "已复制",
        "Copy Anchor Link(heading anchor)(aria-label)": "复制链接",
        "Copy Link(accordion)(aria-label)": "复制链接",
        "Close Banner(banner)(aria-label)": "关闭横幅",
        "Choose a language(language switcher)": "选择语言",
        "Choose a language(language switcher)(aria-label)": "选择语言",
        "Ask AI(AI chat button)": "询问 AI",
    },
}

/** "fr-CA" → "fr"; unknown tags → "en". */
export function resolveChromeLocale(
    language: string | undefined,
): ChromeLocale {
    const base = (language ?? "en").toLowerCase().split(/[-_]/)[0]
    return CHROME_LOCALES.find((locale) => locale === base) ?? "en"
}

export function chromeStringsFor(language: string | undefined): ChromeStrings {
    return CHROME_STRINGS[resolveChromeLocale(language)]
}

/**
 * Locale display label: endonym with an initial capital ("Français", not
 * Intl's lowercase "français"); unknown tags show verbatim.
 */
export function localeLabel(locale: string): string {
    try {
        const label =
            new Intl.DisplayNames([locale], { type: "language" }).of(locale) ??
            locale
        return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1)
    } catch {
        // Well-formed but invalid tags ("en-12") make both Intl.DisplayNames
        // and toLocaleUpperCase throw RangeError — show the tag verbatim.
        return locale.charAt(0).toUpperCase() + locale.slice(1)
    }
}

const rootRoute = getRouteApi("__root__")

/**
 * Locale tag a pathname is served under: a first segment naming a
 * non-default locale (the same leading-slug rule as source.ts
 * resolveActiveLocale) selects it, anything else is the site's default
 * locale. Pure — shared by useActiveLocale and route `head()` functions,
 * which cannot call hooks.
 */
export function activeLocaleOf(
    pathname: string,
    input: { defaultLanguage: string; pathLocales: readonly string[] },
): string {
    const firstSegment = pathname.split("/")[1] ?? ""
    return (
        input.pathLocales.find((locale) => locale === firstSegment) ??
        input.defaultLanguage
    )
}

/**
 * Locale tag of the page currently on screen. The root loader's `language`
 * is SSR-time state reused across client navigations (a `/fr/...` → `/`
 * navigation would keep French), so the locale is re-derived from the
 * current pathname on every render.
 */
export function useActiveLocale(): string {
    const data = rootRoute.useLoaderData()
    const pathname = useLocation({ select: (location) => location.pathname })
    return activeLocaleOf(pathname, data)
}

/**
 * Locale of the page on screen, provided once by the root route (from
 * useActiveLocale) and by the SSR isolate (src/sandbox/render.tsx), which
 * has no router: article components read chrome copy through it, so they
 * render the same in both trees. Unprovided means English.
 */
export const ChromeLocaleContext = createContext<string | null>(null)

/** Framework chrome copy for the locale of the page on screen. */
export function useChromeStrings(): ChromeStrings {
    return chromeStringsFor(use(ChromeLocaleContext) ?? undefined)
}
