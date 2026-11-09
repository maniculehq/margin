import {
    array,
    boolean,
    literal,
    looseObject,
    maxLength,
    never,
    nullish,
    null as nullSchema,
    number,
    object,
    string,
    union,
} from "zod/mini"

/** Static MDX expressions shared by ingest classification and framework SSR.
 * Only data is admitted — literals, `undefined`, and arrays/objects built
 * from them; anything executable uses the compiled-JS path so the
 * DB-credentialed server never evaluates tenant code. */

export type StaticMdxValue =
    | string
    | number
    | boolean
    | null
    | undefined
    | StaticMdxValue[]
    | { [key: string]: StaticMdxValue }

const literalSchema = object({
    type: literal("Literal"),
    value: union([string(), number(), boolean(), nullSchema()]),
})

const signedNumberSchema = object({
    type: literal("UnaryExpression"),
    operator: union([literal("-"), literal("+")]),
    argument: object({ type: literal("Literal"), value: number() }),
})

const flatTemplateSchema = object({
    type: literal("TemplateLiteral"),
    expressions: array(never()).check(maxLength(0)),
    quasis: array(object({ value: object({ cooked: nullish(string()) }) })),
})

const undefinedIdentifierSchema = object({
    type: literal("Identifier"),
    name: literal("undefined"),
})

// Holes (`[1,,2]`) parse as null elements — rejected by the element schema
// refinement below since a hole is not an expression node.
const arraySchema = object({
    type: literal("ArrayExpression"),
    elements: array(looseObject({ type: string() })),
})

// Plain data properties only: no spread, computed keys, getters/setters, or
// methods. Shorthand `{ a }` is an Identifier value and fails below unless
// it is literally `undefined`.
const objectSchema = object({
    type: literal("ObjectExpression"),
    properties: array(
        object({
            type: literal("Property"),
            kind: literal("init"),
            method: literal(false),
            computed: literal(false),
            key: union([
                object({ type: literal("Identifier"), name: string() }),
                object({
                    type: literal("Literal"),
                    value: union([string(), number()]),
                }),
            ]),
            value: looseObject({ type: string() }),
        }),
    ),
})

export type StaticMdxExpressionResult =
    | { ok: true; value: StaticMdxValue }
    | { ok: false }

export function evaluateStaticMdxExpression(
    expression: unknown,
): StaticMdxExpressionResult {
    const literal = literalSchema.safeParse(expression)
    if (literal.success) return { ok: true, value: literal.data.value }
    const signed = signedNumberSchema.safeParse(expression)
    if (signed.success) {
        return {
            ok: true,
            value:
                signed.data.operator === "-"
                    ? -signed.data.argument.value
                    : signed.data.argument.value,
        }
    }
    const template = flatTemplateSchema.safeParse(expression)
    if (template.success) {
        return {
            ok: true,
            value: template.data.quasis
                .map((quasi) => quasi.value.cooked ?? "")
                .join(""),
        }
    }
    if (undefinedIdentifierSchema.safeParse(expression).success)
        return { ok: true, value: undefined }
    const array = arraySchema.safeParse(expression)
    if (array.success) {
        const values: StaticMdxValue[] = []
        for (const element of array.data.elements) {
            const evaluated = evaluateStaticMdxExpression(element)
            if (!evaluated.ok) return { ok: false }
            values.push(evaluated.value)
        }
        return { ok: true, value: values }
    }
    const object = objectSchema.safeParse(expression)
    if (object.success) {
        const value: { [key: string]: StaticMdxValue } = {}
        for (const property of object.data.properties) {
            const key =
                property.key.type === "Identifier"
                    ? property.key.name
                    : String(property.key.value)
            if (key === "__proto__") return { ok: false }
            const evaluated = evaluateStaticMdxExpression(property.value)
            if (!evaluated.ok) return { ok: false }
            value[key] = evaluated.value
        }
        return { ok: true, value }
    }
    return { ok: false }
}

/** Structural subset of estree's Expression union (this package carries no
 * @types/estree); assignable wherever estree expects an Expression. */
export type StaticMdxEstree =
    | { type: "Literal"; value: string | number | boolean | null }
    | { type: "Identifier"; name: "undefined" }
    | { type: "ArrayExpression"; elements: StaticMdxEstree[] }
    | {
          type: "ObjectExpression"
          properties: Array<{
              type: "Property"
              kind: "init"
              method: false
              shorthand: false
              computed: false
              key: { type: "Literal"; value: string }
              value: StaticMdxEstree
          }>
      }

/** Minimal estree for a static value — the inverse of
 * evaluateStaticMdxExpression, used by ingest to re-emit admitted attribute
 * expressions without acorn position junk. Every node it produces round-trips
 * through the evaluator above. */
export function staticMdxValueToEstree(value: StaticMdxValue): StaticMdxEstree {
    if (value === undefined) return { type: "Identifier", name: "undefined" }
    if (Array.isArray(value))
        return {
            type: "ArrayExpression",
            elements: value.map(staticMdxValueToEstree),
        }
    if (typeof value === "object" && value !== null)
        return {
            type: "ObjectExpression",
            properties: Object.entries(value).map(([key, entry]) => ({
                type: "Property",
                kind: "init",
                method: false,
                shorthand: false,
                computed: false,
                key: { type: "Literal", value: key },
                value: staticMdxValueToEstree(entry),
            })),
        }
    return { type: "Literal", value }
}
