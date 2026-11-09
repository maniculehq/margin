import { describe, expect, it } from "vitest"
import { localeCounterparts } from "@/lib/seo"

const versions = (
    entries: Array<[label: string, directory: string, isDefault: boolean]>,
) =>
    entries.map(([label, directory, isDefault], seq) => ({
        label,
        directory,
        default: isDefault,
        seq,
    }))

const urlsByLocale = (
    counterparts: ReturnType<typeof localeCounterparts>,
): Record<string, string> =>
    Object.fromEntries(counterparts.map((entry) => [entry.locale, entry.url]))

describe("localeCounterparts", () => {
    const unversioned = [
        { locale: "en", default: true, versionsManifest: versions([]) },
        { locale: "fr", default: false, versionsManifest: versions([]) },
    ]

    it("swaps only the locale prefix when no locale has version roots", () => {
        expect(
            urlsByLocale(localeCounterparts("/guide", null, unversioned)),
        ).toEqual({
            en: "/guide",
            fr: "/fr/guide",
        })
        expect(
            urlsByLocale(localeCounterparts("/fr/guide", "fr", unversioned)),
        ).toEqual({
            en: "/guide",
            fr: "/fr/guide",
        })
        expect(
            urlsByLocale(localeCounterparts("/fr", "fr", unversioned)),
        ).toEqual({
            en: "/",
            fr: "/fr",
        })
    })

    // The default locale's default version spans its
    // root (unprefixed URLs) while es keeps its default version under /v1.
    const prefixedDefault = [
        {
            locale: "en",
            default: true,
            versionsManifest: versions([["v1", "", true]]),
        },
        {
            locale: "es",
            default: false,
            versionsManifest: versions([
                ["v1", "v1", true],
                ["v0", "v0", false],
            ]),
        },
    ]

    it("lands a default-version page on the locale's version-prefixed default tree", () => {
        expect(
            urlsByLocale(localeCounterparts("/intro", null, prefixedDefault)),
        ).toEqual({ en: "/intro", es: "/es/v1/intro" })
        expect(
            urlsByLocale(
                localeCounterparts("/es/v1/intro", "es", prefixedDefault),
            ),
        ).toEqual({ en: "/intro", es: "/es/v1/intro" })
    })

    it("keeps a non-default version label the target locale lacks so the served filter drops it", () => {
        expect(
            urlsByLocale(
                localeCounterparts("/es/v0/intro", "es", prefixedDefault),
            ),
        ).toEqual({ en: "/v0/intro", es: "/es/v0/intro" })
    })

    const sharedLabels = [
        {
            locale: "en",
            default: true,
            versionsManifest: versions([
                ["v2", "v2", true],
                ["v1", "v1", false],
            ]),
        },
        {
            locale: "de",
            default: false,
            versionsManifest: versions([
                ["v3", "v3", true],
                ["v2", "v2", false],
            ]),
        },
    ]

    it("prefers the same version label over the target's default", () => {
        expect(
            urlsByLocale(localeCounterparts("/v2/intro", null, sharedLabels)),
        ).toEqual({ en: "/v2/intro", de: "/de/v2/intro" })
        expect(
            urlsByLocale(
                localeCounterparts("/de/v3/intro", "de", sharedLabels),
            ),
        ).toEqual({ en: "/v2/intro", de: "/de/v3/intro" })
    })

    it("keeps unversioned pages unprefixed when the default version has its own directory", () => {
        expect(
            urlsByLocale(localeCounterparts("/pricing", null, sharedLabels)),
        ).toEqual({ en: "/pricing", de: "/de/pricing" })
    })
})
