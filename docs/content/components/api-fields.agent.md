# Document API fields and examples

Build a hand-authored request and response reference with MDX field and example components. Use this approach when endpoint content is not generated from an API contract.

## Do this

Insert this complete MDX fragment into a documentation page. The `POST /projects` operation, identifiers, and data are fictional; the fragment documents an example and does not create an endpoint.

````mdx
## Create a project

This fictional POST /projects operation accepts a JSON body and returns
an object containing the created project.

### Request body

<ParamField body="name" type="string" required>
  Name of the project to create.
</ParamField>

### Response fields

<ResponseField name="project" type="object">
  The newly created project.
  <Expandable title="project properties">
    <ResponseField name="id" type="string">
      Identifier assigned to the project.
    </ResponseField>
    <ResponseField name="name" type="string">
      Name supplied in the request.
    </ResponseField>
  </Expandable>
</ResponseField>

<RequestExample>
  Send a JSON body containing the project name.

  ```json title="Request body"
  { "name": "Docs" }
  ```
</RequestExample>

<ResponseExample>
  The example response contains the created project.

  ```json title="Response body"
  { "project": { "id": "proj_demo", "name": "Docs" } }
  ```
</ResponseExample>
````

## Facts

- `ParamField` and `ResponseField` accept the same props and render the same field block.
- `path`, `query`, `body`, and `header` are string props for parameter names in those request locations; `name` is a string prop for a field without a location.
- Field-name precedence is the first defined value among `path`, `query`, `body`, `header`, and `name`, in that order. Author only one name prop per field.
- Location props select a displayed field name, not a location label. Identify the location in prose when needed.
- `type` is a string displayed in a type chip; `type` has no fixed vocabulary or validation.
- `required` and `deprecated` accept booleans or strings. A supplied value displays the corresponding label unless the value is boolean `false`.
- Bare `required` and `required={true}` display the required label. Omitted `required` and `required={false}` suppress the label. `required="false"` still displays the label. The same rules apply to `deprecated`.
- `default` accepts a string, number, or boolean and displays `default: <value>`. `0` and `false` display; omitted or null values do not display.
- Field `children` contain MDX descriptions and can contain nested fields.
- `Expandable` groups child fields in a collapsible block. `Expandable` accepts `title` as a string and `defaultOpen` as a boolean.
- `Expandable` starts closed unless `defaultOpen={true}` is set. The default control label is “Show child attributes”; opening the block changes “Show” to “Hide”.
- Nested field names display exactly as authored; a nested `id` name is not automatically prefixed with `project.`.
- `RequestExample` and `ResponseExample` each accept `children` and use the same visual grouping as `CodeGroup`.
- Label examples with headings or prose inside the example wrappers. Label code fences with `title="…"`.
- Use an explicit `CodeGroup` inside an example wrapper for multiple tabbed fences. Give every fence inside `CodeGroup` a `title="…"`.
- Top-level `RequestExample` and `ResponseExample` appear in the desktop right-hand rail instead of the table of contents on default, non-editorial pages. Examples remain inline at their authored position on smaller screens.
- Example wrappers nested inside another component remain inline.
- Wide, center, frame, and editorial page layouts show examples inline because those layouts hide the rail.
- A top-level `Panel` supplies rail content instead of automatically placing top-level request and response examples in the rail. Examples outside that panel remain inline.

## Not supported

- Field and example components do not define a live endpoint, validate requests, or generate an API contract.
- `RequestExample` does not send requests; `ResponseExample` does not check responses.
- A `title` prop on `RequestExample` or `ResponseExample` does not supply an example heading.
- Field nesting does not infer a schema or generate child fields. Author every child field explicitly.

## Verify

Preview the authored page at desktop and mobile widths. Confirm the request field displays `name`, `string`, and `required`; expand `project properties` to see `id` and `name`; confirm each example appears in the rail or inline according to page layout and wrapper placement.
