# Releasing

The release workflow (`.github/workflows/release.yml`) runs the full test suite,
packs the tarball, and publishes to npm with provenance when a `v*` tag is
pushed.

## One-time setup (choose one)

### A. npm trusted publishing (recommended, OIDC, no long-lived token)

1. Publish the package manually once if npm requires the package to exist
   before trusted publishers can be configured.
2. On npmjs.com → the package → Settings → Trusted publishing, add:
   - Repository: `obonhector/oauth-mcp-bridge`
   - Workflow: `release.yml`
   - Environment: leave empty (or match the workflow)
3. Leave the `NPM_TOKEN` repository secret unset. The workflow uses
   `id-token: write` and `npm publish --provenance`.

### B. Repository token

1. Create a granular npm token with publish rights for `oauth-mcp-bridge`.
2. Add it as the `NPM_TOKEN` repository secret:
   `gh secret set NPM_TOKEN -R obonhector/oauth-mcp-bridge`
3. The workflow passes it as `NODE_AUTH_TOKEN`.

## Release checklist

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run test:pack
npm audit --omit=dev --audit-level=high

# bump the version in package.json (and package-lock via npm install)
npm version 1.1.0 --no-git-tag-version

git add -A
git commit -m "chore(release): v1.1.0"
git push origin main

git tag -a v1.1.0 -m "v1.1.0"
git push origin v1.1.0
```

The tag push starts the Release workflow. Verify the npm page and the
provenance badge afterwards.

## Notes

- Do not commit tokens or `.npmrc` files with credentials.
- The current v1.1.0 code is merged and CI-green; publishing is waiting for
  the one-time npm credential setup above.
- If a release fails after the tag is pushed, fix the issue, delete the tag
  locally and remotely, and re-tag the fixed commit:
  `git tag -d v1.1.0 && git push origin :refs/tags/v1.1.0`.
