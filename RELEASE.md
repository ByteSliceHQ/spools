# Releasing Spools

Two packages are published to npm: `@swirls/spools`, the framework, and `@swirls/create-spools`,
which makes a new Spool. They are released together and share a version. Everything else in the
repository is private.

`@swirls/spools` is published from `packages/spools/dist`, which `packages/spools/scripts/assemble.ts`
builds: compiled JavaScript and declarations, with entry points that lead to them. In the repository
the same entry points lead to the source.

## Version policy

Spools uses SemVer and Changesets.

- Before 1.0, use `patch` for compatible fixes and `minor` for features or breaking changes.
- From 1.0 onward, use `patch` for fixes, `minor` for compatible features, and `major` for breaking
  changes.
- Every user-visible package change needs a changeset. Internal refactors with no published effect
  do not.
- A new page or endpoint is a new route file in an app. Say so in the changeset, with the file.
- Stable releases use the npm `latest` tag. Preview releases use Changesets prerelease mode and the
  `next` tag.

The version of `crm.config.json` (`"version": 1`) is separate. It changes only when the format
breaks. A change to the tables is called out in the changeset, because people have to migrate.

## Normal release

1. Add a changeset on the feature branch:

   ```sh
   bun run changeset
   ```

2. Merge the feature PR after CI passes.
3. The Release workflow opens or updates the `chore(release): publish @swirls/spools` PR.
4. Review its changelog and version. GitHub runs no checks on a pull request its own bot opened:
   close and reopen it to run CI. Merging it runs `bun run verify`, builds the packages, tries them
   out in a new Spool, publishes to npm, creates the tags, and creates the GitHub releases.
5. Confirm the npm pages show provenance, and make a Spool from the released version:

   ```sh
   bun run test:e2e:npm
   ```

Do not run `changeset publish` from a developer checkout during the normal flow.

## Authentication

Publishing uses npm trusted publishing from `.github/workflows/release.yml` in the `npm` GitHub
environment. The workflow authenticates through GitHub OIDC and records npm provenance.
Maintainers do not need npm tokens for routine releases.

npm checks the repository, the workflow file and the environment, not the branch. So the `npm`
environment must allow deployments from `main` only, and `main` must be protected: otherwise a
branch with its own `release.yml` could publish.

Each package names the workflow as a trusted publisher on npmjs.com (organization `ByteSliceHQ`,
repository `spools`, workflow `release.yml`, environment `npm`, `npm publish` allowed). npm only
lets a package that exists have one, so a new package's first version is published by hand, and a
new trusted publisher has to publish within two days or it expires.

## Website

Merging to `main` builds `apps/docs` and deploys it to Cloudflare at [spools.codes](https://spools.codes)
once the checks pass. The `deploy-docs` job in `.github/workflows/ci.yml` runs in the `production`
GitHub environment with the `CLOUDFLARE_API_TOKEN` secret. To deploy by hand, sign in with
`bunx wrangler login` to the Cloudflare account that holds the domain, and run:

```sh
bun run --cwd apps/docs deploy
```

## Preview releases

Enter prerelease mode on a branch with `bun x changeset pre enter next`, add or update changesets,
and allow the release flow to publish with the `next` tag recorded by Changesets. Exit with
`bun x changeset pre exit` before preparing the next stable release. Never move `latest` to a
preview version.

## Verification and recovery

`bun run check:package` builds and packs both packages, looks inside the tarballs, makes a new Spool
from them in a folder of its own, checks its types, builds it, checks that a production server
without keys refuses to start, seeds it, and asks it for pages. It never publishes.

If a release fails before npm accepts it, fix the cause and rerun the workflow. If npm accepted the
version but tag or GitHub release creation failed, do not reuse or republish that version; create
the matching tag and release from the version commit. For a bad published version, ship a
fix and move `latest` to it. Use `npm deprecate` for a dangerous version. Avoid unpublishing except
when npm policy and incident response explicitly require it.

If the package published but `latest` points to the wrong version:

```sh
npm dist-tag add @swirls/spools@<good-version> latest
```
