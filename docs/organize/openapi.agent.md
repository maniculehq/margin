# Generate an API reference from OpenAPI

Generate navigable endpoint pages and a request playground from a local OpenAPI specification. Use this workflow to publish API operations without writing endpoint MDX files.

## Do this

Save the following document as `openapi.yaml` in the configured docs root, beside `docs.json`. Replace `https://api.example.com` with the public API URL before sending a playground request; the specification does not implement an API.

```yaml
openapi: 3.0.3
info:
  title: Users API
  version: 1.0.0
servers:
  - url: https://api.example.com
paths:
  /users:
    get:
      operationId: listUsers
      summary: List users
      description: Return the users visible to the caller.
      responses:
        '200':
          description: A list of users.
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    id:
                      type: string
```

Merge the following navigation into the existing `docs.json`; retain unrelated configuration.

```json
{
  "navigation": {
    "tabs": [
      {
        "tab": "API Reference",
        "openapi": "openapi.yaml",
        "pages": ["GET /users"]
      }
    ]
  }
}
```

Publish or rebuild the docs. Open `/api-reference/list-users`, open the endpoint playground, select the intended server, provide any API credentials, and send the request. The example operation has no parameters or request body.

## Facts

- Discovery scans anywhere under the configured docs root.
- Discovery recognizes `openapi.json`, `openapi.yaml`, `openapi.yml`, `swagger.json`, `swagger.yaml`, and `swagger.yml`, case-insensitively.
- Discovery recognizes dot-prefixed names such as `payments.openapi.yaml`.
- A nonconventional filename such as `api-public.yml` requires an explicit configuration or navigation reference.
- Specifications must use OpenAPI 3.x, in JSON or YAML.
- Each specification is limited to 4,194,304 bytes and 500 operations.
- Local `$ref` references such as `#/components/schemas/User` are supported.
- Operation navigation references use `METHOD /path` strings in `pages`, with an `openapi` context on the node or an ancestor.
- Navigation operation methods are case-insensitive; operation paths must match the specification.
- Navigation `openapi` contexts can identify a specification by source path, configured ID, or generated base path.
- An `openapi` navigation node without `pages` or `groups` automatically lists the document's generated pages.
- Different specifications containing `GET /users` require separate OpenAPI contexts to select the intended operation.
- Top-level `openapi` array entries use `id`, `spec`, `label`, and `path`; use unique IDs and distinct URL folder paths for multiple specifications.
- Explicit specification registration takes precedence over convention discovery.
- Convention discovery assigns `openapi.yaml` the ID `api` and `payments.openapi.yaml` the ID `payments`.
- Two conventional files named `openapi.yaml` in different folders can collide; explicit registration distinguishes the files.
- Generation produces one page per operation, with operation title, description, method, path, parameters, request body, and response definitions.
- Declared tags can group generated pages; tags are optional for the example.
- The single-spec example generates `/api-reference/list-users` from the title `List users`; changing the summary can change the route.
- Multiple convention-discovered specifications sharing a root use `api-reference/<id>` folders; version-scoped specifications use the version directory as a prefix.
- An explicit specification `path` controls the generated base folder.
- Configured navigation determines visibility; generation alone does not make every operation visible.
- `api.playground.display` defaults to `interactive`; only `interactive` provides request execution.
- `api.playground.proxy` defaults to `true`; `api.playground.credentials` defaults to `false`.
- `api.playground.display` values `simple`, `none`, and `auth` omit the interactive console without removing reference content or request examples.
- API authentication is declared through specification security schemes and security requirements; testing requires credentials for the target API.
- Proxied playground requests are restricted to public HTTP(S) origins declared in root, path, or operation server lists.
- Browser-direct requests require `api.playground.proxy: false` and API CORS support.
- `api.playground.credentials: true` includes browser cookies only for browser-direct requests.
- With configured navigation, an ingested document absent from navigation references produces an `openapi_orphaned` warning; generated pages remain URL-reachable but hidden.
- Orphan warnings identify the source specification path in ingest diagnostics and appear in ingest CLI warning output.
- `openapi_orphaned` can also identify a discovered copy skipped because an inferred document ID is already registered.

## Not supported

- Swagger 2.0 documents are not supported, including files named `swagger.yaml`; convert the document to OpenAPI 3.x.
- External `$ref` references are not supported; bundle the specification into one file.
- Bare `GET /users` navigation references without an OpenAPI context do not resolve.
- Generated operation URLs are not guaranteed to match `operationId`.
- The playground does not simulate responses; sending a request contacts the configured API.
- `api.playground.display: "auth"` does not implement docs-visitor authentication or an API login flow.
- Relative servers, unresolved server templates, private targets, and loopback targets do not enter the proxy allowlist.
- A skipped duplicate specification does not acquire generated pages merely because the diagnostic code is `openapi_orphaned`.

## Errors

| Identifier or message | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `openapi_orphaned` | Not applicable | Ingested document is absent from configured navigation references | Add an `openapi` navigation context with operation references, or reference the generated base folder; rebuild. |
| `openapi_orphaned` | Not applicable | Discovered copy has an already registered inferred document ID | Register the copy with a unique top-level `openapi` ID and distinct `path`, or remove the unused copy. |

The unreferenced-document warning for the example label has the following exact message.

```text
OpenAPI document "API Reference" is not referenced by the configured navigation and remains URL-reachable but hidden.
```

## Verify

After publishing, open `/api-reference/list-users` from the API navigation. Confirm `GET /users`, the description `Return the users visible to the caller.`, and a `200` response schema containing an array of objects with a string `id`.

With interactive display enabled, confirm that the playground opens. After replacing the example server URL with the real API URL, send the request and inspect the real API response; the specification alone does not guarantee a successful response.

Check ingest warning output for the specification path. If the operation is missing from navigation, correct the operation reference and OpenAPI context before changing the specification.
