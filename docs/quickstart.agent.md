# Publish your docs on Manicule and confirm an edit is live

Host the latest Margin release on Manicule, open the published site, then push a landing-page edit to the docs branch and confirm it is live.

## Do this

1. Prepare a GitHub account and a repository containing your docs. If you have no docs repository, start from the [Margin template](https://github.com/maniculehq/margin) and its `docs/` folder, or create a repository with a single `index.mdx`.

For a single-page site, use this content in `index.mdx`:

```mdx
# Welcome

This documentation is published from my repository.
```

2. Open [Manicule onboarding](https://app.manicule.com/onboard?product=margin) and sign up or sign in. New users create an organization with the docs product preselected. Confirm that you reach “Where are your docs?”.
3. At “Where are your docs?”, select “Connect GitHub” and install the Manicule GitHub app. Include the repository containing your docs. Manicule reads only the repositories chosen during installation. Confirm that your repository is available at “Deploy your docs from GitHub”.
4. At “Deploy your docs from GitHub”, choose the repository and deploy branch. This is the docs branch. Choose the folder containing your docs, or leave the optional folder at its default, the repository root. For the Margin template's docs, choose `docs`. Select “Create docs site” and confirm that the first deployment starts.
5. Wait until “Your docs site is up.” appears. Open the shown `manicule.dev` address and confirm that the documentation landing page renders. Save the address for verification.
6. At “Want your own domain?”, optionally connect a domain now or do it later from Domains.
7. Clone the connected repository and switch to the selected docs branch. Replace the clone URL and branch before running:

```bash
git clone 'https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git' my-docs
cd my-docs
git switch 'YOUR_DOCS_BRANCH'
```

8. Open `index.mdx` in the selected docs folder: `docs/index.mdx` for the template, or `index.mdx` for a repository-root site. Append this paragraph outside any code fence unless it is already present:

```markdown
This documentation is published from my repository.
```

If the paragraph is already present, change it to `My first documentation edit is live.` instead and use that sentence in the final check.

9. Set `DOCS_PAGE` to the landing page's repository-relative path. Review the diff and confirm that it shows your changed paragraph. This example uses the template's `docs/` folder:

```bash
DOCS_PAGE='docs/index.mdx'
git diff -- "$DOCS_PAGE"
```

10. Commit the changed page and push the docs branch:

```bash
git add "$DOCS_PAGE"
git commit \
  -m "Update documentation landing page"
git push
```

Confirm that a deployment starts for this commit. Wait for it to complete, then run the check under Verify.

## SDK

This workflow uses Manicule's hosted onboarding and Git. No SDK is required.

## Facts

- Manicule hosting is free, with no limits.
- Margin is Apache 2.0 whether hosted by Manicule or self-hosted.
- Manicule hosts the latest Margin release, includes the database, and requires no servers or environment variables to configure.
- Manicule reads only the GitHub repositories selected during installation of its GitHub app.
- The docs folder is optional and defaults to the repository root.
- Every push to the docs branch publishes the site.
- Pull requests targeting the docs branch get previews.
- The hosted site uses `<site>.manicule.dev` or your own domain.
- Connecting a custom domain is optional during onboarding and can be done later from Domains. Domains manages the domain.
- For this walkthrough, `index.mdx` in the selected docs folder is the landing page checked at `/`.

## Not supported

A pull request preview is not the live-site update checked here. Push the edit to the selected docs branch to publish it to the live site.

## Errors

If the edited sentence is absent from the live site, check that you pushed to the docs branch and that the deployment uses the edit's commit.

## Verify

After the edit's deployment completes, reload the site's landing page at `/` and confirm that it contains the edited sentence.

For a terminal check, replace the URL with the site's address and set `EXPECTED` to the edited sentence. Use `My first documentation edit is live.` if the initial sentence was already present:

```bash
SITE_URL='https://YOUR_SITE.manicule.dev'
EXPECTED='This documentation is published from my repository.'
curl --fail --silent --show-error "$SITE_URL/" \
  | grep -F "$EXPECTED"
```

Success prints a matching line from the HTML.

## Related

[Custom domain](/deploy/manicule)

[Run locally](/local-development)

[Customize your site](/settings/docs-json)

[Self-host instead](/deploy/self-host)
