/**
 * Who is asking: every request is one of four categories.
 *
 * - `human`: a person reading in a browser.
 * - `crawler`: a search engine or an AI company collecting pages ahead of
 *   time (search index, AI search index, training corpus, knowledge base).
 * - `agent`: an AI product fetching a page now, because a person asked it
 *   something or gave it a task.
 * - `automation`: every other program (SEO tools, link previews, monitors,
 *   scanners, scripts). Not reported as readership.
 *
 * To tell a crawler from an agent, ask whether a person is waiting on this
 * request. Zod-free and dependency-free: the API builds its query-time
 * fallback from the same pattern strings.
 */

export const TRAFFIC_CATEGORIES = [
    "human",
    "crawler",
    "agent",
    "automation",
] as const
export type TrafficCategory = (typeof TRAFFIC_CATEGORIES)[number]

export const TRAFFIC_KINDS = {
    human: [],
    crawler: ["search", "ai_search", "training", "ingest"],
    agent: ["assistant", "coding", "browser", "unidentified"],
    automation: [
        "seo",
        "preview",
        "ads",
        "monitor",
        "scanner",
        "archiver",
        "feed",
        "http_client",
        "headless",
        "impersonator",
        // A page read by a browser user agent whose browser never reported
        // the view (classification version 3): a person's view is the one
        // their browser reports, so the read alone is a program.
        "unreported_browser",
        "unidentified",
    ],
} as const satisfies Record<TrafficCategory, readonly string[]>
export type TrafficKind = (typeof TRAFFIC_KINDS)[TrafficCategory][number]

/** Which rule decided the category. */
export const TRAFFIC_SIGNALS = [
    "user_agent",
    "signature",
    "accept",
    "browser",
    "none",
] as const
export type TrafficSignal = (typeof TRAFFIC_SIGNALS)[number]

export type TrafficEntry = {
    id: string
    name: string
    operator: string
    category: Exclude<TrafficCategory, "human">
    kind: TrafficKind
    /** Case-insensitive, RE2-compatible (no lookaround, no named groups):
     *  the same string runs in JavaScript, in the CDN route and in HogQL. */
    pattern: string
    /** The operator fetches from its own servers and publishes their
     *  addresses here. Absent for products that run on the user's machine
     *  and for operators that publish nothing; those are never IP-checked. */
    ipRanges?: string
}

const OPENAI_GPTBOT = "https://openai.com/gptbot.json"
const OPENAI_SEARCHBOT = "https://openai.com/searchbot.json"
const OPENAI_USER = "https://openai.com/chatgpt-user.json"
const ANTHROPIC = "https://claude.com/crawling/bots.json"
const PERPLEXITY_BOT = "https://www.perplexity.ai/perplexitybot.json"
const PERPLEXITY_USER = "https://www.perplexity.ai/perplexity-user.json"
const GOOGLE_COMMON =
    "https://developers.google.com/static/crawling/ipranges/common-crawlers.json"
const GOOGLE_SPECIAL =
    "https://developers.google.com/static/crawling/ipranges/special-crawlers.json"
const GOOGLE_USER_FETCHERS =
    "https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers-google.json"
const GOOGLE_USER_AGENTS =
    "https://developers.google.com/static/crawling/ipranges/user-triggered-agents.json"
const BING = "https://www.bing.com/toolbox/bingbot.json"
const APPLE = "https://search.developer.apple.com/applebot.json"
const COMMON_CRAWL = "https://index.commoncrawl.org/ccbot.json"
const DUCKASSIST = "https://duckduckgo.com/duckassistbot.json"

type Row = [
    id: string,
    name: string,
    operator: string,
    kind: TrafficKind,
    pattern: string,
    ipRanges?: string,
]

// Order matters inside a table: the first matching row wins, so a product's
// specific token sits above the broader token it contains (Claude Code
// above Claude-User). Every pattern is anchored on a product token, never a
// bare word such as "Cursor" or "Code", which ordinary browsers and editors
// also carry.
const AGENTS: Row[] = [
    [
        "claude-code",
        "Claude Code",
        "Anthropic",
        "coding",
        "^Claude-User \\(claude-code/|^claude-code/|^claude-cli/",
    ],
    [
        "github-copilot",
        "GitHub Copilot",
        "GitHub",
        "coding",
        "\\bGitHubCopilot",
    ],
    [
        "opencode",
        "OpenCode",
        "SST",
        "coding",
        "^opencode[/-]|\\bOpenCode-User/",
    ],
    ["cursor", "Cursor", "Anysphere", "coding", "^Cursor/\\d"],
    ["devin", "Devin", "Cognition", "coding", "^Devin\\b"],
    [
        "gemini-cli",
        "Gemini CLI",
        "Google",
        "coding",
        "\\bGoogleAgent-URLContext\\b",
    ],
    [
        "antigravity",
        "Antigravity",
        "Google",
        "coding",
        "\\bGoogle-Jetski-Antigravity\\b",
    ],
    ["zcode", "ZCode", "ZCode", "coding", "\\bZCode-WebFetch/"],
    ["qoder", "Qoder CLI", "Alibaba", "coding", "^qodercli(?:cn)?/"],
    ["qwen-code", "Qwen Code", "Alibaba", "coding", "^QwenCode/"],
    ["kiro", "Kiro", "Amazon", "coding", "^KiroServer/"],
    ["augment", "Augment", "Augment Code", "coding", "^Augment-WebFetch/"],
    [
        "deepseek-harness",
        "DeepSeek harness",
        "DeepSeek",
        "coding",
        "^deepseek-harness/",
    ],
    [
        "chatgpt-user",
        "ChatGPT",
        "OpenAI",
        "assistant",
        "\\bChatGPT-User\\b",
        OPENAI_USER,
    ],
    [
        "claude-user",
        "Claude",
        "Anthropic",
        "assistant",
        "\\bClaude-User\\b|\\bClaude-Web\\b",
        ANTHROPIC,
    ],
    [
        "perplexity-user",
        "Perplexity",
        "Perplexity",
        "assistant",
        "\\bPerplexity-User\\b|\\bPerplexityUser/",
        PERPLEXITY_USER,
    ],
    ["mistral-user", "Le Chat", "Mistral", "assistant", "\\bMistralAI-User\\b"],
    [
        "duckassist",
        "DuckAssist",
        "DuckDuckGo",
        "assistant",
        "\\bDuckAssistBot\\b",
        DUCKASSIST,
    ],
    [
        "meta-fetcher",
        "Meta AI",
        "Meta",
        "assistant",
        "\\bmeta-externalfetcher\\b",
    ],
    [
        "notebooklm",
        "NotebookLM",
        "Google",
        "assistant",
        "\\bGoogle-NotebookLM\\b",
        GOOGLE_USER_FETCHERS,
    ],
    [
        "gemini-deep-research",
        "Gemini Deep Research",
        "Google",
        "assistant",
        "\\bGemini-Deep-Research\\b",
    ],
    [
        "google-agent",
        "Google Agent",
        "Google",
        "browser",
        "\\bGoogle-Agent\\b",
        GOOGLE_USER_AGENTS,
    ],
    ["amazon-user", "Amazon", "Amazon", "assistant", "\\bAmzn-User\\b"],
    ["exa-user", "Exa", "Exa", "assistant", "\\bExaUser\\b"],
    ["grok-agent", "Grok", "xAI", "assistant", "\\bgrok-agent/"],
    [
        "amazon-quick",
        "Amazon Quick",
        "Amazon",
        "assistant",
        "^amazon-Quick-on-behalf-of-",
    ],
    [
        "amazon-agentcore-browser",
        "Amazon Bedrock AgentCore Browser",
        "Amazon",
        "browser",
        "\\bAmazon-Bedrock-AgentCore-Browser\\b",
    ],
    [
        "minimax-agent",
        "MiniMax Agent",
        "MiniMax",
        "assistant",
        "^MiniMaxAgent\\b",
    ],
    ["shap-user", "Shap", "Shap", "assistant", "\\bShap-User/"],
    ["kimi-user", "Kimi", "Moonshot AI", "assistant", "\\bKimi-User/"],
    ["liner-user", "Liner", "Liner", "assistant", "\\bLiner-User/"],
    ["kagi-fetcher", "Kagi", "Kagi", "assistant", "^kagi-fetcher\\b"],
    ["tabstack", "Tabstack", "Mozilla", "assistant", "^Mozilla-Tabstack/"],
]

const CRAWLERS: Row[] = [
    // AI search indexes
    [
        "oai-searchbot",
        "OAI-SearchBot",
        "OpenAI",
        "ai_search",
        "\\bOAI-SearchBot\\b",
        OPENAI_SEARCHBOT,
    ],
    [
        "claude-searchbot",
        "Claude-SearchBot",
        "Anthropic",
        "ai_search",
        "\\bClaude-SearchBot\\b",
        ANTHROPIC,
    ],
    [
        "perplexitybot",
        "PerplexityBot",
        "Perplexity",
        "ai_search",
        "\\bPerplexityBot\\b",
        PERPLEXITY_BOT,
    ],
    ["youbot", "YouBot", "You.com", "ai_search", "\\bYouBot\\b"],
    ["phindbot", "PhindBot", "Phind", "ai_search", "\\bPhindBot\\b"],
    ["exa-searchbot", "ExaSearchBot", "Exa", "ai_search", "\\bExaSearchBot\\b"],
    ["tavilybot", "TavilyBot", "Tavily", "ai_search", "\\bTavilyBot\\b"],
    ["linkupbot", "LinkupBot", "Linkup", "ai_search", "\\bLinkupBot\\b"],
    ["shapbot", "ShapBot", "Shap", "ai_search", "\\bShapBot/"],
    [
        "kimi-searchbot",
        "Kimi-SearchBot",
        "Moonshot AI",
        "ai_search",
        "\\bKimi-SearchBot/",
    ],
    [
        "mistral-index",
        "MistralAI-Index",
        "Mistral",
        "ai_search",
        "\\bMistralAI-Index/",
    ],
    ["linerbot", "LinerBot", "Liner", "ai_search", "\\bLinerBot/"],
    [
        "amazon-searchbot",
        "Amzn-SearchBot",
        "Amazon",
        "ai_search",
        "\\bAmzn-SearchBot\\b",
    ],
    // Training corpora
    ["gptbot", "GPTBot", "OpenAI", "training", "\\bGPTBot\\b", OPENAI_GPTBOT],
    [
        "claudebot",
        "ClaudeBot",
        "Anthropic",
        "training",
        "\\bClaudeBot\\b|^anthropic-ai\\b",
        ANTHROPIC,
    ],
    [
        "meta-externalagent",
        "Meta-ExternalAgent",
        "Meta",
        "training",
        "\\bmeta-externalagent\\b|\\bFacebookBot\\b",
    ],
    ["bytespider", "Bytespider", "ByteDance", "training", "\\bBytespider\\b"],
    ["ccbot", "CCBot", "Common Crawl", "training", "\\bCCBot\\b", COMMON_CRAWL],
    [
        "cohere",
        "Cohere",
        "Cohere",
        "training",
        "\\bcohere-ai\\b|\\bcohere-training-data-crawler\\b",
    ],
    ["amazonbot", "Amazonbot", "Amazon", "training", "\\bAmazonbot\\b"],
    [
        "googleother",
        "GoogleOther",
        "Google",
        "training",
        "\\bGoogleOther\\b",
        GOOGLE_COMMON,
    ],
    [
        "reflectionbot",
        "Reflectionbot",
        "Reflection AI",
        "training",
        "\\bReflectionbot\\b",
    ],
    ["diffbot", "Diffbot", "Diffbot", "training", "\\bDiffbot\\b"],
    ["ai2bot", "Ai2Bot", "Allen Institute for AI", "training", "\\bAi2Bot\\b"],
    ["pangubot", "PanguBot", "Huawei", "training", "\\bPanguBot\\b"],
    ["timpibot", "Timpibot", "Timpi", "training", "\\bTimpibot\\b"],
    [
        "webz",
        "Webz.io",
        "Webz.io",
        "training",
        "\\bomgili(?:bot)?\\b|\\bwebzio-extended\\b",
    ],
    ["imagesiftbot", "ImagesiftBot", "Hive", "training", "\\bImagesiftBot\\b"],
    [
        "elevenlabs-crawler",
        "ElevenlabsCrawler",
        "ElevenLabs",
        "training",
        "\\bElevenlabsCrawler/",
    ],
    ["kimibot", "KimiBot", "Moonshot AI", "training", "\\bKimiBot/"],
    [
        "mistral-training",
        "MistralAI-Training",
        "Mistral",
        "training",
        "\\bMistralAI-Training/",
    ],
    [
        "clueweb",
        "ClueWeb-Crawler",
        "Carnegie Mellon University",
        "training",
        "^ClueWeb-Crawler/",
    ],
    [
        "dataset-crawler",
        "Dataset crawler",
        "Various",
        "training",
        "^ICC-Crawler/|\\bVelenPublicWebCrawler\\b|\\bimg2(?:dataset|downloader)\\b|\\blaion-huggingface-processor\\b|\\bSBIntuitionsBot/",
    ],
    // Knowledge bases and retrieval pipelines a site owner or their
    // customer pointed at the site
    [
        "google-cloudvertexbot",
        "Google-CloudVertexBot",
        "Google",
        "ingest",
        "\\bGoogle-CloudVertexBot\\b",
        GOOGLE_SPECIAL,
    ],
    [
        "azure-ai-search",
        "AzureAI-SearchBot",
        "Microsoft",
        "ingest",
        "\\bAzureAI-SearchBot\\b",
    ],
    [
        "amazon-bedrock",
        "Amazon Bedrock",
        "Amazon",
        "ingest",
        "^amazon-bedrock-knowledgebase\\b|^amazon-kendra\\b|^amazon-QBusiness\\b",
    ],
    [
        "cloudflare-ai-search",
        "Cloudflare AI Search",
        "Cloudflare",
        "ingest",
        "^Cloudflare-(?:AutoRAG|AI-Search)\\b",
    ],
    ["firecrawl", "Firecrawl", "Firecrawl", "ingest", "\\bFirecrawlAgent\\b"],
    ["context7", "Context7", "Upstash", "ingest", "^Context7\\b"],
    [
        "atlassian-bot",
        "atlassian-bot",
        "Atlassian",
        "ingest",
        "\\batlassian-bot\\b",
    ],
    // Search engines. Their index also feeds AI answers, but their own
    // documentation describes them as search crawlers.
    [
        "googlebot",
        "Googlebot",
        "Google",
        "search",
        "\\bGooglebot\\b|\\bGoogle-InspectionTool\\b|\\bStorebot-Google\\b",
        GOOGLE_COMMON,
    ],
    ["bingbot", "Bingbot", "Microsoft", "search", "\\bbingbot\\b", BING],
    ["applebot", "Applebot", "Apple", "search", "\\bApplebot\\b", APPLE],
    ["duckduckbot", "DuckDuckBot", "DuckDuckGo", "search", "\\bDuckDuckBot\\b"],
    [
        "yandexbot",
        "YandexBot",
        "Yandex",
        "search",
        "\\bYandex[a-z]*Bot\\b|\\bYandexImages\\b",
    ],
    ["baiduspider", "Baiduspider", "Baidu", "search", "\\bBaiduspider\\b"],
    ["bravebot", "Bravebot", "Brave", "search", "\\bBravebot\\b"],
    ["petalbot", "PetalBot", "Huawei", "search", "\\bPetalBot\\b"],
    ["sogou", "Sogou", "Sogou", "search", "\\bSogou web spider\\b"],
    ["yisouspider", "YisouSpider", "Alibaba", "search", "\\bYisouSpider\\b"],
    ["seznambot", "SeznamBot", "Seznam", "search", "\\bSeznamBot\\b"],
    ["naverbot", "Yeti", "Naver", "search", "\\bYeti/\\d"],
    ["qwantbot", "Qwantbot", "Qwant", "search", "\\bQwantbot\\b"],
    ["mojeekbot", "MojeekBot", "Mojeek", "search", "\\bMojeekBot\\b"],
    [
        "coccocbot",
        "coccocbot",
        "Cốc Cốc",
        "search",
        "\\bcoccocbot|(?:^|compatible; )(?:image\\.?)?coccoc/",
    ],
    [
        "meta-webindexer",
        "Meta-WebIndexer",
        "Meta",
        "search",
        "\\bmeta-webindexer\\b",
    ],
    [
        "algolia-crawler",
        "Algolia Crawler",
        "Algolia",
        "search",
        "\\bAlgolia Crawler\\b",
    ],
    ["coveobot", "Coveobot", "Coveo", "search", "\\bCoveobot/"],
    [
        "tiktokspider",
        "TikTokSpider",
        "ByteDance",
        "search",
        "\\bTikTokSpider\\b",
    ],
    ["ibou", "ibou-search", "ibou", "search", "\\bibou-search/"],
]

/** Automation that names itself. Checked with the tables above, before the
 *  markdown rule: a link preview never becomes an agent by its Accept. */
const NAMED_AUTOMATION: Row[] = [
    [
        "semrushbot",
        "SemrushBot",
        "Semrush",
        "seo",
        "\\bSemrushBot\\b|\\bSiteAuditBot\\b|\\bSplitSignalBot\\b",
    ],
    [
        "ahrefsbot",
        "AhrefsBot",
        "Ahrefs",
        "seo",
        "\\bAhrefs(?:Bot|SiteAudit)\\b",
    ],
    ["mj12bot", "MJ12bot", "Majestic", "seo", "\\bMJ12bot\\b"],
    ["dotbot", "DotBot", "Moz", "seo", "\\bDotBot\\b|\\brogerbot\\b"],
    [
        "dataforseobot",
        "DataForSeoBot",
        "DataForSEO",
        "seo",
        "\\bDataForSeoBot\\b",
    ],
    ["blexbot", "BLEXBot", "WebMeUp", "seo", "\\bBLEXBot\\b"],
    [
        "screaming-frog",
        "Screaming Frog",
        "Screaming Frog",
        "seo",
        "\\bScreaming Frog SEO Spider\\b",
    ],
    ["serpstatbot", "serpstatbot", "Serpstat", "seo", "\\bserpstatbot\\b"],
    ["barkrowler", "Barkrowler", "Babbar", "seo", "\\bBarkrowler\\b"],
    [
        "seranking",
        "SE Ranking",
        "SE Ranking",
        "seo",
        "\\bSERankingBacklinksBot\\b",
    ],
    ["sistrix", "SISTRIX", "SISTRIX", "seo", "\\bSISTRIX\\b"],
    [
        "slackbot",
        "Slackbot",
        "Slack",
        "preview",
        "\\bSlackbot\\b|\\bSlack-ImgProxy\\b",
    ],
    ["twitterbot", "Twitterbot", "X", "preview", "\\bTwitterbot\\b"],
    ["discordbot", "Discordbot", "Discord", "preview", "\\bDiscordbot\\b"],
    ["linkedinbot", "LinkedInBot", "LinkedIn", "preview", "\\bLinkedInBot\\b"],
    ["telegrambot", "TelegramBot", "Telegram", "preview", "\\bTelegramBot\\b"],
    ["whatsapp", "WhatsApp", "Meta", "preview", "^WhatsApp/"],
    [
        "facebook-preview",
        "Facebook link preview",
        "Meta",
        "preview",
        "\\bfacebookexternalhit\\b|^Facebot\\b",
    ],
    ["bingpreview", "BingPreview", "Microsoft", "preview", "\\bBingPreview\\b"],
    [
        "skype-preview",
        "Skype link preview",
        "Microsoft",
        "preview",
        "\\bSkypeUriPreview\\b",
    ],
    [
        "google-preview",
        "Google preview",
        "Google",
        "preview",
        "\\bGoogle-PageRenderer\\b|\\bGoogleImageProxy\\b|\\bgooglemessages\\b|\\bGoogle Web Preview\\b",
    ],
    [
        "vercel-screenshot",
        "Vercel screenshot",
        "Vercel",
        "preview",
        "^vercel-screenshot\\b",
    ],
    ["iframely", "Iframely", "Iframely", "preview", "\\bIframely\\b"],
    [
        "google-ads",
        "Google Ads",
        "Google",
        "ads",
        "\\bAdsBot-Google\\b|\\bMediapartners-Google\\b|\\bGoogle-Adwords\\b|^Google-Display-Ads-Bot\\b|\\bGoogle-Ads-Conversions\\b",
    ],
    ["oai-adsbot", "OAI-AdsBot", "OpenAI", "ads", "\\bOAI-AdsBot\\b"],
    ["meta-ads", "Meta ads", "Meta", "ads", "\\bmeta-externalads\\b"],
    [
        "uptimerobot",
        "UptimeRobot",
        "UptimeRobot",
        "monitor",
        "\\bUptimeRobot\\b",
    ],
    ["pingdom", "Pingdom", "SolarWinds", "monitor", "\\bPingdom\\b"],
    ["statuscake", "StatusCake", "StatusCake", "monitor", "\\bStatusCake\\b"],
    ["checkly", "Checkly", "Checkly", "monitor", "\\bCheckly\\b"],
    ["datadog", "Datadog Synthetics", "Datadog", "monitor", "\\bDatadog\\b"],
    [
        "better-stack",
        "Better Stack",
        "Better Stack",
        "monitor",
        "\\bBetter ?Stack\\b|\\bBetter Uptime\\b",
    ],
    ["site24x7", "Site24x7", "Zoho", "monitor", "\\bSite24x7\\b"],
    ["gtmetrix", "GTmetrix", "GTmetrix", "monitor", "\\bGTmetrix\\b"],
    [
        "lighthouse",
        "Lighthouse",
        "Google",
        "monitor",
        "\\bChrome-Lighthouse\\b|\\bGoogle Page Speed Insights\\b|\\bGoogle-Site-Verification\\b|\\bGoogle Search Console\\b|\\bGoogle-Structured-Data-Testing-Tool\\b",
    ],
    [
        "cloudflare-monitor",
        "Cloudflare monitor",
        "Cloudflare",
        "monitor",
        "\\bCloudflare-Healthchecks\\b|\\bCloudflareObservatory\\b",
    ],
    ["lychee", "lychee", "lychee", "monitor", "^lychee/"],
    [
        "consul",
        "Consul health check",
        "HashiCorp",
        "monitor",
        "^Consul Health Check$",
    ],
    ["catchpoint", "Catchpoint", "Catchpoint", "monitor", "\\bCatchpoint\\b"],
    ["leakix", "LeakIX", "LeakIX", "scanner", "\\bl9(?:scan|explore|tcpid)\\b"],
    ["censys", "Censys", "Censys", "scanner", "\\bCensysInspect\\b"],
    ["zgrab", "zgrab", "ZMap", "scanner", "\\bzgrab\\b"],
    ["nuclei", "Nuclei", "ProjectDiscovery", "scanner", "\\bNuclei\\b"],
    ["nmap", "Nmap", "Nmap", "scanner", "\\bNmap Scripting Engine\\b"],
    ["masscan", "masscan", "masscan", "scanner", "\\bmasscan\\b"],
    ["expanse", "Expanse", "Palo Alto Networks", "scanner", "\\bExpanse\\b"],
    [
        "internet-measurement",
        "InternetMeasurement",
        "InternetMeasurement",
        "scanner",
        "\\bInternetMeasurement\\b",
    ],
    ["detectify", "Detectify", "Detectify", "scanner", "\\bDetectify\\b"],
    ["acunetix", "Acunetix", "Invicti", "scanner", "\\bAcunetix\\b"],
    [
        "internet-archive",
        "Internet Archive",
        "Internet Archive",
        "archiver",
        "\\barchive\\.org_bot\\b|\\bia_archiver\\b",
    ],
    ["turnitin", "Turnitin", "Turnitin", "archiver", "^Turnitin"],
    [
        "feed-reader",
        "Feed reader",
        "Various",
        "feed",
        "^FeedFetcher-Google\\b|\\bFeedly\\b|\\bFeedbin\\b|\\bInoreader\\b|\\bNewsBlur\\b",
    ],
]

/** HTTP libraries and headless browsers: programs with no product behind
 *  them. Checked after the markdown rule, so a script that asks for
 *  markdown is an agent and one that does not is automation. */
const GENERIC_CLIENTS: Row[] = [
    ["curl", "curl", "curl", "http_client", "^curl/"],
    ["wget", "Wget", "GNU", "http_client", "^Wget/"],
    [
        "python",
        "Python",
        "Python",
        "http_client",
        "^python-requests/|^python-httpx/|^Python-urllib/|^Python/|\\baiohttp/",
    ],
    ["go", "Go", "Go", "http_client", "^Go-http-client/"],
    [
        "node",
        "Node.js",
        "Node.js",
        "http_client",
        "^(?:node|undici|node-fetch)\\b",
    ],
    ["axios", "axios", "axios", "http_client", "^axios/"],
    ["got", "got", "got", "http_client", "^got\\b"],
    ["bun", "Bun", "Bun", "http_client", "^Bun/"],
    ["deno", "Deno", "Deno", "http_client", "^Deno/"],
    [
        "java",
        "Java",
        "Java",
        "http_client",
        "^okhttp/|^Java/|^Apache-HttpClient/",
    ],
    ["php", "PHP", "PHP", "http_client", "^GuzzleHttp/|^PHP/"],
    ["rust", "Rust", "Rust", "http_client", "^reqwest/"],
    [
        "ruby",
        "Ruby",
        "Ruby",
        "http_client",
        "^Ruby\\b|^Faraday\\b|^rest-client/",
    ],
    ["perl", "Perl", "Perl", "http_client", "\\blibwww-perl/"],
    ["dart", "Dart", "Dart", "http_client", "^Dart/"],
    [
        "api-client",
        "API client",
        "Various",
        "http_client",
        "^PostmanRuntime/|^insomnia/|^HTTPie/",
    ],
    ["powershell", "PowerShell", "Microsoft", "http_client", "\\bPowerShell/"],
    [
        "scrapy",
        "Scrapy",
        "Scrapy",
        "http_client",
        "\\bScrapy/|^colly\\b|^crawl4ai|\\bHTTrack\\b",
    ],
    ["lua", "Lua", "Lua", "http_client", "^lua-resty-http/"],
    ["aria2", "aria2", "aria2", "http_client", "^aria2/"],
    [
        "workflow-runner",
        "Workflow runner",
        "Various",
        "http_client",
        "^n8n$|^Google-Cloud-(?:Scheduler|Tasks)$",
    ],
    [
        "edge-fetch",
        "Edge fetch",
        "Various",
        "http_client",
        "^Amazon CloudFront$|^Vercel Edge Functions$",
    ],
    // An app's own network stack fetches programmatically even when a
    // person is using the app; a page opened in its built-in browser sends
    // a browser user agent and counts as human.
    [
        "native-app",
        "Native app",
        "Various",
        "http_client",
        "\\bCFNetwork/|\\bDalvik/",
    ],
    [
        "headless-browser",
        "Headless browser",
        "Various",
        "headless",
        "\\bHeadlessChrome/|\\bPhantomJS/|\\bPlaywright/|\\bPuppeteer\\b|\\bSelenium\\b|\\bCypress/",
    ],
]

function entries(
    category: TrafficEntry["category"],
    rows: Row[],
): TrafficEntry[] {
    return rows.map(([id, name, operator, kind, pattern, ipRanges]) => ({
        id,
        name,
        operator,
        category,
        kind,
        pattern,
        ...(ipRanges ? { ipRanges } : {}),
    }))
}

/** Every product that identifies itself, in match order. */
export const TRAFFIC_ENTRIES: readonly TrafficEntry[] = [
    ...entries("agent", AGENTS),
    ...entries("crawler", CRAWLERS),
    ...entries("automation", NAMED_AUTOMATION),
]
export const TRAFFIC_GENERIC_CLIENTS: readonly TrafficEntry[] = entries(
    "automation",
    GENERIC_CLIENTS,
)

/**
 * A browser user agent: the Mozilla prefix, a rendering engine, and nothing
 * that names a program. Exported as strings so the API's query-time
 * fallback applies the same test (all three must hold: prefix and engine
 * match, automation does not).
 */
export const BROWSER_PREFIX_PATTERN = "^Mozilla/[45]\\.0 \\("
export const BROWSER_ENGINE_PATTERN =
    "\\(KHTML, like Gecko\\)|Gecko/\\d|Trident/\\d"
export const BROWSER_AUTOMATION_PATTERN =
    "[a-z]bot/|(?:^|[^a-z])bot\\b|crawl|spider|scrap|fetch|headless|https?://|[a-z0-9]@[a-z0-9-]+\\.[a-z]|compatible; [^M]"

const compile = (pattern: string) =>
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- every pattern is a constant in this module, never request input
    new RegExp(pattern, "i")
const compiledEntries = TRAFFIC_ENTRIES.map((entry) => ({
    entry,
    test: compile(entry.pattern),
}))
const compiledClients = TRAFFIC_GENERIC_CLIENTS.map((entry) => ({
    entry,
    test: compile(entry.pattern),
}))
const browserPrefix = compile(BROWSER_PREFIX_PATTERN)
const browserEngine = compile(BROWSER_ENGINE_PATTERN)
const browserAutomation = compile(BROWSER_AUTOMATION_PATTERN)

/** The self-identified product behind a user agent, if any. */
export function matchTrafficEntry(userAgent: string): TrafficEntry | null {
    return (
        compiledEntries.find(({ test }) => test.test(userAgent))?.entry ?? null
    )
}

export function isBrowserUserAgent(userAgent: string): boolean {
    return (
        browserPrefix.test(userAgent) &&
        browserEngine.test(userAgent) &&
        !browserAutomation.test(userAgent)
    )
}

/**
 * Whether an Accept header ranks markdown above HTML. Browsers never do;
 * AI tools that read pages do. A header that names markdown and no HTML
 * also counts. `text/plain` and wildcards are neither.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
    if (!accept) return false
    let markdown: { q: number; index: number } | null = null
    let html: { q: number; index: number } | null = null
    for (const [index, part] of accept.toLowerCase().split(",").entries()) {
        const [type = "", ...params] = part.split(";").map((p) => p.trim())
        const quality = params.find((param) => param.startsWith("q="))
        const parsed = quality ? Number(quality.slice(2)) : 1
        const q = Number.isNaN(parsed) ? 1 : parsed
        if (q <= 0) continue
        if (type === "text/markdown" || type === "text/x-markdown") {
            if (!markdown || q > markdown.q) markdown = { q, index }
        } else if (type === "text/html") {
            if (!html || q > html.q) html = { q, index }
        }
    }
    if (!markdown) return false
    if (!html) return true
    return (
        markdown.q > html.q ||
        (markdown.q === html.q && markdown.index < html.index)
    )
}

/** Keyed by request input, so a Map: a plain object would also answer
 *  for inherited names such as "constructor". Operators that sign requests (HTTP Message Signatures) and name
 *  themselves in `Signature-Agent` while sending a browser user agent. */
const SIGNED_AGENTS = new Map<string, TrafficEntry>(
    Object.entries({
        "chatgpt.com": {
            id: "chatgpt-agent",
            name: "ChatGPT agent",
            operator: "OpenAI",
            category: "agent",
            kind: "browser",
            pattern: "",
        },
        "agent.bot.goog": {
            id: "google-agent",
            name: "Google Agent",
            operator: "Google",
            category: "agent",
            kind: "browser",
            pattern: "",
        },
        // Hosted browsers other companies' agents drive: the signature names
        // the platform, not the agent running on it.
        "browserbase.com": {
            id: "browserbase",
            name: "Browserbase",
            operator: "Browserbase",
            category: "agent",
            kind: "browser",
            pattern: "",
        },
        "api.manus.im": {
            id: "manus",
            name: "Manus",
            operator: "Manus",
            category: "agent",
            kind: "browser",
            pattern: "",
        },
    }),
)

/** Agents that send a browser user agent but an Accept header no browser
 *  sends, compared with whitespace removed. */
const ACCEPT_FINGERPRINTS = new Map<string, TrafficEntry>(
    Object.entries({
        "text/markdown;q=1.0,text/x-markdown;q=0.9,text/plain;q=0.8,text/html;q=0.7,*/*;q=0.1":
            {
                id: "opencode",
                name: "OpenCode",
                operator: "SST",
                category: "agent",
                kind: "coding",
                pattern: "",
            },
    }),
)

export const BROWSER_CHECKS = [
    "consistent",
    "plain_text_first",
    "client_hints_mismatch",
    "no_fetch_metadata",
    "no_accept_language",
] as const
export type BrowserCheck = (typeof BROWSER_CHECKS)[number]

/**
 * Whether a browser user agent's headers look like a browser's. Recorded
 * beside the classification, not folded into it: a proxy that strips
 * `sec-fetch-*` would otherwise turn every reader behind it into
 * automation. Null when the user agent is not a browser's.
 */
export function browserCheck(
    userAgent: string,
    header: (name: string) => string | null,
): BrowserCheck | null {
    if (!isBrowserUserAgent(userAgent)) return null
    const accept = header("accept")?.toLowerCase() ?? ""
    const plain = accept.indexOf("text/plain")
    const html = accept.indexOf("text/html")
    if (plain !== -1 && (html === -1 || plain < html)) return "plain_text_first"
    // Only Chromium sends client hints.
    if (header("sec-ch-ua") && !/Chrome\//.test(userAgent))
        return "client_hints_mismatch"
    // Every current browser sends fetch metadata over HTTPS: Chrome since
    // 76, Firefox since 90, Safari since 16.4.
    const chrome = Number(/Chrome\/(\d+)/.exec(userAgent)?.[1] ?? 0)
    const firefox = Number(/Firefox\/(\d+)/.exec(userAgent)?.[1] ?? 0)
    const safari = Number(
        /Version\/(\d+)[\d.]* .*Safari\//.exec(userAgent)?.[1] ?? 0,
    )
    if (
        !header("sec-fetch-mode") &&
        (chrome >= 80 || firefox >= 90 || safari >= 17)
    )
        return "no_fetch_metadata"
    if (!header("accept-language")) return "no_accept_language"
    return "consistent"
}

export type TrafficClassification = {
    category: TrafficCategory
    kind: TrafficKind | null
    /** Registry id ("claudebot"), or null when no product was identified. */
    id: string | null
    name: string | null
    operator: string | null
    /** true: the address is in the operator's published ranges. false: it
     *  is provably not (an impersonator). null: not checked, or the product
     *  cannot be checked. */
    verified: boolean | null
    signal: TrafficSignal
}

/**
 * Classify one request. Checks run in order and the first answer wins:
 * a product that identifies itself (user agent, then a signed
 * `Signature-Agent`), an Accept header that prefers markdown, a generic
 * HTTP client, a browser, and otherwise unidentified automation.
 *
 * `ipInRanges` is the caller's answer for the matched entry's published
 * ranges (see `matchTrafficEntry`): true inside, false outside a current
 * range file, null when it could not be checked. Only false changes the
 * category: a crawler name used from an address its operator does not own
 * is an impersonator.
 */
export function classifyTraffic(input: {
    userAgent: string
    accept?: string | null
    /** `Signature-Agent`, passed only when the request also carries
     *  `Signature` and `Signature-Input`. */
    signatureAgent?: string | null
    ipInRanges?: boolean | null
}): TrafficClassification {
    const userAgent = input.userAgent.trim()
    const entry = matchTrafficEntry(userAgent)
    if (entry) {
        if (entry.ipRanges && input.ipInRanges === false) {
            return {
                category: "automation",
                kind: "impersonator",
                id: entry.id,
                name: entry.name,
                operator: null,
                verified: false,
                signal: "user_agent",
            }
        }
        return {
            category: entry.category,
            kind: entry.kind,
            id: entry.id,
            name: entry.name,
            operator: entry.operator,
            verified: entry.ipRanges && input.ipInRanges === true ? true : null,
            signal: "user_agent",
        }
    }
    if (input.signatureAgent) {
        const host = /(?:https?:\/\/)?([a-z0-9.-]+)/i
            .exec(
                input.signatureAgent.replace(/^[\w-]+=/, "").replace(/"/g, ""),
            )?.[1]
            ?.toLowerCase()
        const signed = host ? SIGNED_AGENTS.get(host) : undefined
        if (signed) {
            return {
                category: signed.category,
                kind: signed.kind,
                id: signed.id,
                name: signed.name,
                operator: signed.operator,
                // The signature itself is not validated here.
                verified: null,
                signal: "signature",
            }
        }
    }
    const fingerprinted = ACCEPT_FINGERPRINTS.get(
        (input.accept ?? "").toLowerCase().replace(/\s/g, ""),
    )
    if (fingerprinted) {
        return {
            category: fingerprinted.category,
            kind: fingerprinted.kind,
            id: fingerprinted.id,
            name: fingerprinted.name,
            operator: fingerprinted.operator,
            verified: null,
            signal: "accept",
        }
    }
    if (prefersMarkdown(input.accept)) {
        return {
            category: "agent",
            kind: "unidentified",
            id: null,
            name: null,
            operator: null,
            verified: null,
            signal: "accept",
        }
    }
    const client = compiledClients.find(({ test }) =>
        test.test(userAgent),
    )?.entry
    if (client) {
        return {
            category: "automation",
            kind: client.kind,
            id: client.id,
            name: client.name,
            operator: null,
            verified: null,
            signal: "user_agent",
        }
    }
    if (isBrowserUserAgent(userAgent)) {
        return {
            category: "human",
            kind: null,
            id: null,
            name: null,
            operator: null,
            verified: null,
            signal: "browser",
        }
    }
    return {
        category: "automation",
        kind: "unidentified",
        id: null,
        name: null,
        operator: null,
        verified: null,
        signal: "none",
    }
}

/** AI products whose answers link to pages. A click from one is a human
 *  visit with a source, recorded beside the category, not as one. */
export const AI_REFERRAL_PLATFORMS = [
    "openai",
    "anthropic",
    "perplexity",
    "google",
    "microsoft",
    "meta",
    "you",
    "other",
] as const
export type AiReferralPlatform = (typeof AI_REFERRAL_PLATFORMS)[number]

const AI_REFERRER_HOSTS = new Map<string, AiReferralPlatform>(
    Object.entries({
        "chat.openai.com": "openai",
        "chatgpt.com": "openai",
        "claude.ai": "anthropic",
        "perplexity.ai": "perplexity",
        "gemini.google.com": "google",
        "bard.google.com": "google",
        "copilot.microsoft.com": "microsoft",
        "meta.ai": "meta",
        "you.com": "you",
        "poe.com": "other",
        "phind.com": "other",
        "chat.mistral.ai": "other",
        "grok.com": "other",
    }),
)

const AI_UTM_SOURCES = new Map<string, AiReferralPlatform>(
    Object.entries({
        "chat.openai.com": "openai",
        "chatgpt.com": "openai",
        chatgpt: "openai",
        claude: "anthropic",
        "claude.ai": "anthropic",
        perplexity: "perplexity",
        "perplexity.ai": "perplexity",
        gemini: "google",
        copilot: "microsoft",
        "meta.ai": "meta",
        "you.com": "you",
    }),
)

/**
 * The AI product a visit came from: its referrer, or the `utm_source` some
 * products add when they suppress the referrer. Null for every other visit.
 */
export function aiReferral(input: {
    referer: string | null
    requestPath: string
}): { platform: AiReferralPlatform; detection: "referrer" | "utm" } | null {
    if (input.referer && URL.canParse(input.referer)) {
        const platform = AI_REFERRER_HOSTS.get(
            new URL(input.referer).hostname.toLowerCase().replace(/^www\./, ""),
        )
        if (platform) return { platform, detection: "referrer" }
    }
    if (URL.canParse(input.requestPath, "https://docs.invalid")) {
        const source = new URL(
            input.requestPath,
            "https://docs.invalid",
        ).searchParams
            .get("utm_source")
            ?.toLowerCase()
        const platform = source ? AI_UTM_SOURCES.get(source) : undefined
        if (platform) return { platform, detection: "utm" }
    }
    return null
}
