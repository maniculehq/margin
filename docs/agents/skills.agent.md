# Publish agent skills

Publish a repository-authored `SKILL.md` and install it into a compatible coding agent. Use a repository skill for task-specific instructions rather than the generated documentation-reading guide.

## Do this

From the documentation root containing `docs.json`, create a self-contained skill. Replace the example task with product-specific instructions and absolute documentation URLs before publishing.

```bash
mkdir -p skills/configure-client
cat > skills/configure-client/SKILL.md <<'SKILL'
---
name: configure-client
description: Configure the product client. Use when adding the client to an application.
---

# Configure the client

1. Read the installation and authentication pages on the documentation site.
2. Follow the documented example for the application's language.
3. Run the example and check its documented success output.
4. Report the result without printing credentials.
SKILL
```

Publish the repository changes through the normal documentation deployment. Set `DOCS_URL` to the deployed documentation root, including any base path and without a trailing slash; inspect the discovery index and the served skill.

```bash
export DOCS_URL="https://docs.example.com"
curl --fail --silent --show-error \
  "$DOCS_URL/.well-known/agent-skills/index.json"
curl --fail --silent --show-error \
  "$DOCS_URL/.well-known/agent-skills/configure-client/SKILL.md"
```

Confirm the index contains `configure-client` and the served file matches the repository file. Use each index entry's absolute `url` for subsequent reads instead of guessing paths.

From the project where the coding agent will work, install with the skills CLI using Node.js 22.20 or later. Select `configure-client` and the target agent when prompted.

```bash
npx skills add "$DOCS_URL"
npx skills list
```

Confirm `configure-client` appears for the selected agent. Open the project in the agent and check its available-skills listing, or ask the agent to identify `configure-client` and its description.

## Facts

- Skill source paths are relative to the documentation root containing `docs.json`.
- Duplicate skill names use precedence `.mintlify/skills/<name>/SKILL.md`, then `skills/<name>/SKILL.md`, then root `SKILL.md`, then root `skill.md`.
- Directory-based skill frontmatter `name` must equal the directory name; root `SKILL.md` and `skill.md` use the frontmatter name.
- Nested skill filenames must be uppercase `SKILL.md`.
- `name` is a required string of 1–64 characters matching lowercase letters, digits, and single hyphens, without leading, trailing, or consecutive hyphens.
- `description` is a required string of 1–1,024 characters.
- `license` is an optional string.
- `compatibility` is an optional string of 1–500 characters.
- `metadata` is an optional mapping of string keys to string values.
- `allowed-tools` is an optional string; Margin does not enforce the agent's interpretation of `allowed-tools`.
- `groups` is an optional array of strings; nonempty `groups` excludes a skill from public serving unless `public: true`.
- `public` is an optional boolean; `public: true` permits public serving even with nonempty `groups`.
- Unknown frontmatter keys are preserved.
- A skill file may contain at most 1,048,576 UTF-8 bytes.
- Invalid YAML, missing or invalid required metadata, directory/name mismatches, oversized files, and lower-precedence duplicates produce `field_invalid` warnings and are skipped without blocking documentation-page publication.
- Skills are excluded from documentation-page ingestion and do not belong in navigation.
- Files beside a skill are excluded from documentation-page ingestion.
- `/skill.md` contains the generated documentation guide and links to available authored skills with an installation command.
- `/.well-known/agent-skills/index.json` follows Agent Skills discovery version 0.2.0 and returns a `skills` array.
- Each discovery entry contains `name`, `type: "skill-md"`, `description`, absolute `url`, and `digest`.
- Each `digest` is `sha256:` followed by 64 lowercase hexadecimal characters over the exact served UTF-8 file bytes, including frontmatter.
- Public authored skills replace the generated skill in `/.well-known/agent-skills/index.json` when at least one public authored skill exists; otherwise the index lists the generated documentation skill.
- `/.well-known/agent-skills/<name>/SKILL.md` serves a named skill, independent of the supported source directory used.
- `/.well-known/skills/index.json` provides a legacy discovery index.
- The skills CLI installs into the current project by default and prompts for skills and compatible agents.
- Served skills belong to the site's selected documentation content version; changed file bytes produce a changed digest after publication.

## Not supported

- Skill publication does not execute instructions or install server-side plugins.
- The skill-serving route does not serve bundled scripts, references, or assets; only `SKILL.md` is served.
- Margin has no reader sign-in to validate `groups` membership.
- A successful documentation build does not prove a skill was accepted.
- Publishing an update does not push changes into an agent's local installation. Re-run installation and confirm the installed content before using changed instructions.

## Errors

| Exact identifier or body | HTTP status | Cause | Fix |
| --- | --- | --- | --- |
| `field_invalid` | Not applicable | Ingestion rejected an invalid or lower-precedence duplicate skill. | Check YAML, metadata constraints, file size, directory/name agreement, and duplicate precedence. |
| `Not Found` | 404 | Requested skill name is unknown or requested file is not `SKILL.md`. | Follow the current discovery entry's URL. |
| Not specified | 404 | Skill surfaces are disabled. | Check whether skill serving is enabled for the deployment. |

## Verify

Check the project-local installation after running the installation command:

```bash
npx skills list
```

The listing must contain `configure-client` for the selected agent. Check the agent's available-skills listing or ask the agent to identify the skill and description to confirm the agent sees the installation.

For publication checks, fetch `/.well-known/agent-skills/index.json` and the named entry's `url`; the expected response is an index entry for `configure-client` and the authored `SKILL.md` bytes. After publishing updates, re-fetch both resources and confirm the new content and digest.

## Related

[Skills CLI installation and agent compatibility](https://github.com/vercel-labs/skills)
