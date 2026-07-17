# Backstage Gitea Scaffolder Parity Workspace

This workspace closes the practical parity gap between Backstage's GitHub and Gitea modules. It packages the enhanced scaffolder, the standard Gitea catalog module, and the opt-in GitHub-authored Template compatibility module as separate dynamic plugins.

It adds implementations for:

```text
gitea:webhook
publish:gitea:pull-request
gitea:branch-protection
```

It also captures the publish-as-user gap: `publish:gitea` should eventually accept a `token` input, matching the ergonomics of `publish:github`, though it should be noted that since Gitea is not an official auth provider for Backstage, a token will need to be provided in every scaffolder form.

## Directory map

```text
scaffolder-backend-module-gitea/
  src/module.ts
  src/actions/*.ts
  README.md

catalog-backend-module-gitea-github-compat/
  src/module.ts
  src/TemplateCompatibilityProcessor.ts
  README.md

rhdh-packaging/
  README.md
  dynamic-plugins.yaml
  values-rhdh.yaml
  scripts/publish-both-plugins.sh 
  config

openshift-gitea/
  README.md
  kustomization.yaml
  namespace.yaml
  postgres.yaml
  gitea.yaml
  route.yaml

examples/
  app-config.gitea.yaml
  template-contract-first-gitea.yaml
  template-action-snippets.yaml
```

## Parity status with `publish:github`

| Category | Inputs | Status |
|----------|--------|--------|
| **Core repo creation** | `repoUrl`, `description`, `defaultBranch`, `repoVisibility`, `gitCommitMessage`, `gitAuthorName`, `gitAuthorEmail`, `sourcePath` | ✅ Complete |
| **P0 — `token` input** | `token` | ✅ Complete |
| **P1 — Branch protection** | `protectDefaultBranch`, `protectEnforceAdmins`, `requireCodeOwnerReviews`, `dismissStaleReviews`, `requiredApprovingReviewCount`, `requiredStatusCheckContexts`, `requireBranchesToBeUpToDate`, `requiredCommitSigning` | ✅ Complete |
| **P1 — Repository access** | `access`, `collaborators` | ✅ Complete. Supports user collaborators and organization teams; maps GitHub-style `pull`/`triage`/`read` to Gitea `read`, `push`/`maintain`/`write` to `write`, and `admin` to `admin` |
| **P2 — Repo features** | `homepage`, `hasIssues`, `hasWiki`, `hasProjects`, `topics`, `deleteBranchOnMerge`, `allowMergeCommit`, `allowSquashMerge`, `allowRebaseMerge`, `squashMergeCommitTitle`, `squashMergeCommitMessage`, `allowAutoMerge`, `allowUpdateBranch` | ❌ Not done |
| **GitHub-only** | `bypassPullRequestAllowances`, `restrictions`, `requiredConversationResolution`, `requireLastPushApproval`, `repoVariables`, `secrets`, `oidcCustomization`, `customProperties`, `subscribe`, `requiredLinearHistory` | ℹ️ No Gitea equivalent |

**No breaking changes** — all new inputs are `.optional()`, so existing `publish:gitea` templates continue to work without modification.

## Getting started

1. Copy the files under `scaffolder-backend-module-gitea` into a real Backstage checkout at the same path.
2. Compile against the exact Backstage version you are targeting.
3. Run the action tests against a disposable Gitea instance.
4. Once upstream-style compilation works, move to `rhdh-packaging`.

## Publishing to Gitea npm registry

The unified pipeline stages the standard catalog, scaffolder, and Template compatibility modules in one run. See [the compatibility module README](catalog-backend-module-gitea-github-compat/README.md) for its focused configuration and supported transformations.

```bash
cd rhdh-packaging
# Requires .env with GITEA_BASE_URL, GITEA_TOKEN, and GITEA_NPM_SCOPE at the project root
./scripts/publish-both-plugins.sh
```

This performs 6 steps:
1. **Stage catalog** — fetches the catalog plugin from npmjs and stages an RHDH-compatible npm package
2. **Stage scaffolder** — builds from local source (`../scaffolder-backend-module-gitea`) and stages the same package format
3. **Stage compatibility** — builds the Template processor catalog module from local source
4. **Publish** — pushes all three tarballs as `@${GITEA_NPM_SCOPE}/*-dynamic` to the Gitea npm registry
5. **Validate** — fetches all three packages back to verify integrity and structure
6. **Generate config** — writes versions, SHA-256 hashes, registry URLs, and deployment npm credentials into `dist-config/` (the original templates remain unmodified)

The generated files in `dist-config/` are git-ignored. Before deploying, replace `<GITEA_HOST>` in `dist-config/values-rhdh.yaml` with your Gitea hostname.
