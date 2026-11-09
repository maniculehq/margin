# Target content to agents and humans

Use audience wrappers in one MDX source to select content for the browser page and agent Markdown. Use this when the two renditions need different instructions while retaining shared prerequisites and API contracts.

## Do this

Add this MDX to a docs page, then deploy the page:

```mdx
Set the project name to `demo`.

<Human>
  Compare the project name shown in the browser with `demo`.
</Human>

<Agent>
  Read the project name as a string and confirm that it equals `demo`.
</Agent>
```

Keep required information for both audiences outside the wrappers. Use sibling audience blocks instead of nesting opposite audiences.

## Facts

- Unwrapped content appears in both the browser page and agent Markdown.
- `Human` renders its children in the browser page and omits its entire subtree from agent Markdown.
- `Agent` omits its entire subtree from the browser page and includes its children without audience tags in agent Markdown.
- `Visibility` accepts the audience-selecting `for` values `"humans"` and `"agents"`, written as literal lowercase strings.
- `Visibility for="humans"` has the same inclusion behavior as `Human`.
- `Visibility for="agents"` has the same inclusion behavior as `Agent`.
- A missing or unrecognized `Visibility` `for` value does not restrict content to an audience; shared content should remain unwrapped.
- Nested wrappers cannot restore content excluded by an outer wrapper.
- Nesting matching audiences is redundant; nesting opposite audiences omits the inner content from both renditions.
- Ordinary MDX components inside an audience wrapper remain subject to the wrapper's inclusion rule.
- The normal page URL serves the browser rendition; the same page path with `.md` appended serves agent Markdown when the site's Markdown surface is enabled.

## Not supported

- Audience visibility is not access control and does not protect secrets.
- Audience visibility does not select content by detecting the requesting user agent; an agent reading HTML receives the browser rendition.
- `"both"` is not an audience-selecting `Visibility` value. Use unwrapped shared content instead.
- An inner audience wrapper cannot override an excluded outer audience wrapper.

## Verify

Open the normal deployed page URL in a browser. Fetch the `.md` rendition with this command after replacing the example origin and page path:

```bash
curl --fail --silent --show-error \
  'https://docs.example.com/content/visibility.md'
```

For the source in `Do this`, check the following output pattern:

| Content | Browser page | Agent Markdown |
| --- | --- | --- |
| Shared project-name instruction | Present | Present |
| Browser comparison instruction inside `Human` | Present | Absent |
| String comparison instruction inside `Agent` | Absent | Present |

The Markdown output contains the included text without `Human` or `Agent` wrapper tags. If content is absent from both renditions, check for conflicting nested audience wrappers.
