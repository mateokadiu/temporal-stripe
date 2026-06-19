# Publishing

`@temporal-stripe/core` and `@temporal-stripe/webhook` ship to npm together. Versioning is automated via [semantic-release](https://semantic-release.gitbook.io/) — conventional commits drive the bump.

## One-time setup

1. **Create the npm scope.** From your npm account: org → create org `temporal-stripe` (or claim it if it already exists under your name).
2. **Generate a publish token.**
   ```bash
   npm token create --read-only=false --type=automation
   ```
3. **Add `NPM_TOKEN` to GitHub.** Repo → Settings → Secrets and variables → Actions → New repository secret.
4. **Push to GitHub.** Create the repo (`mateokadiu/temporal-stripe`) and push the `main` branch. The Release workflow fires automatically.

## Commit conventions

```
feat:  ... → minor bump (1.2.x → 1.3.0)
fix:   ... → patch bump (1.2.3 → 1.2.4)
chore: ... → no release
docs:  ... → no release

# breaking changes — any commit type with this footer triggers a major bump:
feat: replace WorkflowState shape

BREAKING CHANGE: WorkflowState.amountCents is now bigint, not number.
```

## Manual dry-run

```bash
cd packages/core
npx semantic-release --dry-run
```

Outputs what would be released without touching npm.

## Notes

- Both packages are versioned in lockstep. `semantic-release-monorepo` only releases a package if commits touched its directory — so a webhook-only fix bumps only `@temporal-stripe/webhook`, and vice versa.
- The release workflow runs `pnpm build && pnpm typecheck && pnpm test` before publishing — a failing test blocks the release.
- Public scope packages need `publishConfig.access=public` at first publish; tsup's default `package.json` shape works.
