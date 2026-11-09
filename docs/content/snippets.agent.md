# Reuse content with snippets

Share an MDX fragment between pages by placing the fragment under `snippets/` and referencing it from each consuming page. Use fragments for repeated text and code examples; use admitted local code components for executable behavior.

## Do this

Run this shell command from the docs root to create one fragment and two consuming pages. The fragment is expanded at the next docs ingest.

```sh
mkdir -p snippets guides
cat > snippets/retry-note.mdx <<'EOF'
<Note>
  Before retrying a write, check whether the first request succeeded.
</Note>
EOF
cat > guides/create-record.mdx <<'EOF'
---
title: "Create a record"
---

import RetryNote from '/snippets/retry-note.mdx'

Check the write response before proceeding.

<RetryNote />
EOF
cat > guides/update-record.mdx <<'EOF'
---
title: "Update a record"
---

Check the update response before proceeding.

<Snippet file="retry-note.mdx" />
EOF
```

Ingest the docs using the existing deployment workflow, then open both consuming pages and confirm that both contain the retry note. Edit `snippets/retry-note.mdx` and ingest again to update both copies.

## Facts

- `snippets/**/*.mdx` and `snippets/**/*.md` fragments are expanded at ingest and do not serve as standalone pages.
- A default import from an MDX fragment needs no explicit default export in the fragment.
- Imported snippet paths use `/snippets/…` or `snippets/…` and include the file extension.
- `<Snippet file="retry-note.mdx" />` resolves under `snippets/`; `/snippets/` and `snippets/` prefixes are accepted in `file` values.
- A `Snippet` file reference without an extension tries `.mdx` before `.md`.
- Static props on imported fragment tags substitute matching fragment expressions, including inside fenced code; dynamic props do not resolve at ingest.
- Code modules under `snippets/` accept `.js`, `.jsx`, `.ts`, and `.tsx` extensions.
- Default and named exports from code modules are imported with matching default or named imports and invoked as JSX components.
- Named component exports from MDX snippets use the executable code-component path; static exported MDX constants can resolve at ingest.
- Code modules can import other modules with `/snippets/…` or `snippets/…` paths.
- Built-in documentation components such as `Note` and `Card` are available without imports inside code snippets.
- Ambient React support includes `React`, the JSX runtime, `useState`, `useEffect`, `useMemo`, `useCallback`, `useRef`, `useReducer`, `useContext`, `useId`, `useTransition`, and `useSyncExternalStore`.
- Code snippets execute in the visitor's browser or a restricted render isolate, not the application's server process.
- The render isolate has a 250 ms render budget and a 128 MB heap cap.
- A declined isolate render retains the client-only rendering path.
- Browser-only work belongs in effects or event handlers rather than render-time code.
- Snippet source reaches the visitor's browser and must not contain secrets.

A minimal executable module uses an ambient hook without a React import.

```tsx
// snippets/Counter.tsx
export default function Counter() {
  const [count, setCount] = useState(0)
  return (
    <button onClick={() => setCount(count + 1)}>
      Count: {count}
    </button>
  )
}
```

A consuming page imports and invokes the default export.

```mdx
---
title: "Try the counter"
---

import Counter from '/snippets/Counter.tsx'

Click the button to increment its count.

<Counter />
```

## Not supported

- Arbitrary server-side execution or host access from snippet code.
- `process`, `require`, `fetch`, timers, DOM, or filesystem access inside the render isolate.
- Relative-path imports, package imports, URL imports, or Node built-ins in code modules.
- Making package imports admissible by installing dependencies.
- Namespace imports such as `import * as Widgets` from code snippets.
- Computed `Snippet` file attributes or `..` traversal in `Snippet` paths.
- Runtime updates to expanded fragments without another ingest.

## Errors

Ingest diagnostics are not HTTP responses; HTTP status does not apply. A page can still serve after a missing import or rejected module drops snippet content.

| Exact identifier or message | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `snippet_missing` | N/A | Missing imported file or named MDX export | Correct the path, extension, or exported name |
| `js_snippet_rejected` | N/A | Module or MDX component export failed compilation | Fix syntax and keep imports under `/snippets/` |
| `namespace imports from snippets are not supported: Widgets` | N/A | Namespace import bound to `Widgets` | Use a default or named import |
| `<Snippet> requires a literal "file" attribute` | N/A | Missing or computed file attribute | Use `file="retry-note.mdx"` |
| `snippet path may not traverse directories: ../retry-note.mdx` | N/A | `..` in a file reference | Reference from the `snippets/` root |
| `missing snippet file: retry-note.mdx` | N/A | Unresolved `Snippet` file reference | Add the file or correct the reference |

## Verify

After ingest, open both consuming pages and check for the retry note. A successful page load without the note is not a successful transclusion.

For the optional counter component, open the consuming page after ingest and click the button once. Success is a change from `Count: 0` to `Count: 1`.
