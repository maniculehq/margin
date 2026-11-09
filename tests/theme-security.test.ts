import { describe, expect, it } from "vitest"
import { renderThemeStyle, rewriteRootOverflowLock } from "@/lib/theme-render"

describe("theme token security", () => {
    it("drops token names and values that can escape a declaration block", () => {
        expect(
            renderThemeStyle({
                "--safe": "80rem",
                "--unsafe": "1px}</style><script>alert(1)</script>",
                "--bad;display": "block",
            }),
        ).toBe(":root{--safe:80rem}.dark{}")
    })
})

describe("root overflow lock rewrite", () => {
    it("moves body overflow-x:hidden to html overflow-x:clip", () => {
        expect(
            rewriteRootOverflowLock("body{overflow-x:hidden;color:red}"),
        ).toBe("body{color:red}html{overflow-x:clip}")
    })

    it("handles html,body selector lists, !important and clip", () => {
        expect(
            rewriteRootOverflowLock(
                ".a{overflow-x:hidden}\nhtml, body { margin:0; overflow-x: clip !important }",
            ),
        ).toBe(
            ".a{overflow-x:hidden}\nhtml, body { margin:0;}html{overflow-x:clip}",
        )
    })

    it("leaves other overflow axes on root rules untouched", () => {
        const css = "body{overflow-y:hidden}"
        expect(rewriteRootOverflowLock(css)).toBe(css)
    })

    it("leaves overflow-x on non-root selectors untouched", () => {
        const css = ".wrap > body{overflow-x:hidden}"
        expect(rewriteRootOverflowLock(css)).toBe(css)
    })
})
