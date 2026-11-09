import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock"
import defaultMdxComponents from "fumadocs-ui/mdx"
import type { ElementContent, Root, RootContent } from "hast"
import { toJsxRuntime } from "hast-util-to-jsx-runtime"
import {
    Children,
    type ComponentProps,
    isValidElement,
    type ReactNode,
    Suspense,
    use,
    useDeferredValue,
    useState,
} from "react"
import { Fragment, jsx, jsxs } from "react/jsx-runtime"
import { remark } from "remark"
import remarkGfm from "remark-gfm"
import remarkRehype from "remark-rehype"
import { visit } from "unist-util-visit"

export interface Processor {
    process: (content: string) => Promise<ReactNode>
}

export function rehypeWrapWords() {
    return (tree: Root) => {
        visit(tree, ["text", "element"], (node, index, parent) => {
            if (node.type === "element" && node.tagName === "pre") return "skip"
            if (node.type !== "text" || !parent || index === undefined) return

            const words = node.value.split(/(?=\s)/)

            // Create new span nodes for each word and whitespace
            const newNodes: ElementContent[] = words.flatMap((word) => {
                if (word.length === 0) return []

                return {
                    type: "element",
                    tagName: "span",
                    properties: {
                        class: "animate-fd-fade-in",
                    },
                    children: [{ type: "text", value: word }],
                }
            })

            Object.assign(node, {
                type: "element",
                tagName: "span",
                properties: {},
                children: newNodes,
            } satisfies RootContent)
            return "skip"
        })
    }
}

function createProcessor(): Processor {
    const processor = remark()
        .use(remarkGfm)
        .use(remarkRehype)
        .use(rehypeWrapWords)

    return {
        async process(content) {
            const nodes = processor.parse({ value: content })
            const hast = await processor.run(nodes)

            return toJsxRuntime(hast, {
                development: false,
                jsx,
                jsxs,
                Fragment,
                components: {
                    ...defaultMdxComponents,
                    pre: Pre,
                    img: undefined, // use JSX
                },
            })
        },
    }
}

function Pre(props: ComponentProps<"pre">) {
    const code = Children.only(props.children)
    if (!isValidElement<ComponentProps<"code">>(code)) return null
    const codeProps = code.props
    const content = codeProps.children
    if (typeof content !== "string") return null

    let lang =
        codeProps.className
            ?.split(" ")
            .find((v) => v.startsWith("language-"))
            ?.slice("language-".length) ?? "text"

    if (lang === "mdx") lang = "md"

    return <DynamicCodeBlock lang={lang} code={content.trimEnd()} />
}

const processor = createProcessor()

export function Markdown({ text }: { text: string }) {
    const deferredText = useDeferredValue(text)
    // use() needs one stable promise per text across renders. It lives with
    // the message (freed on unmount) rather than in a module Map that grew
    // by one full-text entry per streamed chunk; the cap keeps a long answer
    // at the 32 newest, which always covers the deferred and current text.
    const [cache] = useState(() => new Map<string, Promise<ReactNode>>())

    return (
        <Suspense fallback={<p className="invisible">{text}</p>}>
            <Renderer text={deferredText} cache={cache} />
        </Suspense>
    )
}

function Renderer({
    text,
    cache,
}: {
    text: string
    cache: Map<string, Promise<ReactNode>>
}) {
    let result = cache.get(text)
    if (result === undefined) {
        result = processor.process(text)
        if (cache.size >= 32) {
            const oldest = cache.keys().next().value
            if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(text, result)
    }
    return use(result)
}
