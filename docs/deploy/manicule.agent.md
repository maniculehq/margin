# Deploy free on Manicule

Publish a GitHub docs repository as a hosted Margin site with automatic publishing and pull request previews. Use Manicule hosting to avoid operating the server and database; self-host to operate infrastructure or change framework code.

## Do this

This deployment path uses the Manicule app and GitHub authorization. Complete the app steps with a human who can grant repository access.

1. Sign up or sign in at https://app.manicule.com/onboard?product=margin. A new user creates an organization with the docs product preselected.
2. Choose **Connect GitHub** under **Where are your docs?** and grant the GitHub app access to the docs repository.
3. Confirm that the docs repository appears in the repository picker.
4. Select the repository, deployment branch, and folder containing the docs and `docs.json`.
5. Select **Create docs site** and wait for the first deployment to finish. The app confirms **Your docs site is up.**
6. Open the assigned `manicule.dev` address and confirm that the homepage and a page from the navigation load.
7. For subsequent changes, open a pull request targeting the selected docs branch, review the changed pages at the preview address, and merge when ready. The resulting push publishes to production.

## Facts

- Manicule hosting is free, with no limits.
- Manicule hosting includes the database and requires no user-operated servers.
- Hosted sites always run the latest Margin.
- The Manicule GitHub app reads only repositories selected during authorization.
- Every push to the selected docs branch publishes the site.
- Pull requests targeting the selected docs branch get previews.
- Manicule assigns hosted sites a free `manicule.dev` address.
- The site's Domains page configures custom addresses.
- A custom subdomain such as `docs.acme.com` requires following the setup instructions on the Domains page.
- A custom path such as `acme.com/docs` requires configuration on the Domains page and routing through a user-operated proxy.
- Hosted agent analytics include agent traffic per page, AI answers citing the docs, and visibility in Manicule dashboards.
- Hosted agent analytics require no package installation in the docs repository.
- Margin uses the Apache 2.0 license for hosted and self-hosted deployment.
- Self-hosted Margin is free software; infrastructure costs are the operator's responsibility.
- Self-hosting requires Vercel or a server running Node.js 24 or newer, plus a Postgres database.
- Neon is a Postgres option for self-hosting on Vercel.
- Self-hosted Vercel deployments support Vercel previews; previews outside Vercel depend on the operator's deployment setup.
- Self-hosted agent-journey analytics use the operator's PostHog.
- Self-hosted updates require merging new Margin releases and redeploying.
- The same docs repository and `docs.json` work for hosted and self-hosted deployment in either direction.
- Existing Mintlify configuration and MDX files do not require conversion for Margin.

## Not supported

- Adding a path-based custom address in Manicule does not configure the operator's proxy.
- Self-hosting does not include a Manicule-managed server or database.
- Self-hosted deployments do not receive Margin updates automatically; the operator merges releases and redeploys.

## Verify

Open the assigned `manicule.dev` address after the first deployment finishes. Success means the homepage and a page selected from the site's navigation load.

For a pull request targeting the docs branch, open the preview address and inspect the changed pages before merging. After merging, inspect the production address for the published change.

For a custom domain, open a docs page at the custom address and confirm navigation works. Before switching a domain or proxy during migration, confirm the new deployment works.

## Related

[Create a hosted Margin site](https://app.manicule.com/onboard?product=margin)

[Self-host](/deploy/self-host)

[Deploy to Vercel](/deploy/vercel)

[Quickstart](/quickstart)
