import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseSync } from "vite"
import { describe, expect, it } from "vitest"
import { z } from "zod"

// The /$ loader starts its locale-navigation lookup immediately and read
// `origin` after its first await, racing the rest of the loader. With the
// `const` declared below the closure, the read hit the temporal dead zone
// whenever the lookup won, making multi-locale home pages return 500.
// The race cannot be pinned down from a black-box request, so
// guard the shape itself: a closure invoked where it is written must not
// read a binding its block declares after it.
const routesDir = resolve(import.meta.dirname, "../src/routes")

const node = z.looseObject({ type: z.string() })
const block = z.object({
    type: z.literal("BlockStatement"),
    body: z.array(z.unknown()),
})
const declaration = z.object({
    type: z.literal("VariableDeclaration"),
    declarations: z.array(
        z.looseObject({
            id: z.union([
                z.object({ type: z.literal("Identifier"), name: z.string() }),
                z.looseObject({ type: z.string() }),
            ]),
        }),
    ),
})
const call = z.looseObject({
    type: z.literal("CallExpression"),
    callee: z.unknown(),
})
const parenthesized = z.object({
    type: z.literal("ParenthesizedExpression"),
    expression: z.unknown(),
})
const closure = z.looseObject({
    type: z.enum(["ArrowFunctionExpression", "FunctionExpression"]),
    body: z.unknown(),
})
const functionLike = z.object({
    type: z.enum([
        "ArrowFunctionExpression",
        "FunctionExpression",
        "FunctionDeclaration",
    ]),
})
const identifier = z.object({ type: z.literal("Identifier"), name: z.string() })

/** Child AST nodes of `value`, whatever field holds them. */
function children(value: unknown): unknown[] {
    const parsed = node.safeParse(value)
    if (!parsed.success) return []
    return Object.values(parsed.data).flatMap((field) =>
        (Array.isArray(field) ? field : [field]).filter(
            (child) => node.safeParse(child).success,
        ),
    )
}

/** Names a statement binds with `const`/`let`. */
function declaredNames(statement: unknown): string[] {
    const parsed = declaration.safeParse(statement)
    if (!parsed.success) return []
    return parsed.data.declarations.flatMap(({ id }) => {
        const name = identifier.safeParse(id)
        return name.success ? [name.data.name] : []
    })
}

/** Closures a statement invokes on the spot, e.g.
 * `const x = (async () => {...})()`. Other nested functions are not
 * entered: their calls do not run while the statement does. */
function invokedClosures(value: unknown): unknown[] {
    const invoked = call.safeParse(value)
    if (invoked.success) {
        let callee = invoked.data.callee
        for (
            let inner = parenthesized.safeParse(callee);
            inner.success;
            inner = parenthesized.safeParse(callee)
        )
            callee = inner.data.expression
        const fn = closure.safeParse(callee)
        if (fn.success) return [fn.data]
    }
    if (functionLike.safeParse(value).success) return []
    return children(value).flatMap(invokedClosures)
}

/** A non-computed `obj.name` property or `{ name: … }` key names no binding. */
const staticName = z.union([
    z.looseObject({
        type: z.literal("MemberExpression"),
        computed: z.literal(false),
        property: z.unknown(),
    }),
    z.looseObject({
        type: z.literal("Property"),
        computed: z.literal(false),
        key: z.unknown(),
    }),
])

function referencedNames(value: unknown, names = new Set<string>()) {
    const name = identifier.safeParse(value)
    if (name.success) names.add(name.data.name)
    const fixed = staticName.safeParse(value)
    const skip = fixed.success
        ? "property" in fixed.data
            ? fixed.data.property
            : fixed.data.key
        : undefined
    for (const child of children(value))
        if (child !== skip) referencedNames(child, names)
    return names
}

const declarator = z.looseObject({
    type: z.literal("VariableDeclarator"),
    id: z.unknown(),
})
const withParams = z.looseObject({
    type: z.enum([
        "ArrowFunctionExpression",
        "FunctionExpression",
        "FunctionDeclaration",
    ]),
    params: z.array(z.unknown()),
    id: z.unknown().optional(),
})
const catchClause = z.looseObject({
    type: z.literal("CatchClause"),
    param: z.unknown(),
})

/** Names a closure binds itself (variables, parameters, function names):
 * reading those is never an early read of the enclosing block's binding. */
function boundNames(value: unknown, names = new Set<string>()) {
    const variable = declarator.safeParse(value)
    if (variable.success) referencedNames(variable.data.id, names)
    const fn = withParams.safeParse(value)
    if (fn.success)
        for (const binding of [...fn.data.params, fn.data.id])
            referencedNames(binding, names)
    const caught = catchClause.safeParse(value)
    if (caught.success) referencedNames(caught.data.param, names)
    for (const child of children(value)) boundNames(child, names)
    return names
}

/** `file: name` for every read of a later binding from an invoked closure. */
function earlyReads(file: string): string[] {
    const { program, errors } = parseSync(
        file,
        readFileSync(join(routesDir, file), "utf8"),
        { lang: file.endsWith(".tsx") ? "tsx" : "ts" },
    )
    expect(errors).toEqual([])
    const reads: string[] = []
    const visit = (value: unknown) => {
        const parsed = block.safeParse(value)
        if (parsed.success) {
            const statements = parsed.data.body
            statements.forEach((statement, index) => {
                const later = new Set(
                    statements.slice(index + 1).flatMap(declaredNames),
                )
                for (const closure of invokedClosures(statement)) {
                    const own = boundNames(closure)
                    for (const name of referencedNames(closure))
                        if (later.has(name) && !own.has(name))
                            reads.push(`${file}: ${name}`)
                }
            })
        }
        for (const child of children(value)) visit(child)
    }
    visit(program)
    return reads
}

describe("route loaders", () => {
    it("never read a binding from a closure started before its declaration", () => {
        const files = readdirSync(routesDir, { recursive: true })
            .map(String)
            .filter((file) => /\.tsx?$/.test(file))
        expect(files).toContain("$.tsx")
        expect(files.flatMap(earlyReads)).toEqual([])
    })
})
