# Backstage Gitea Scaffolder Parity Workspace

This workspace is for closing the practical parity gap between Backstage's GitHub scaffolder module and the existing Gitea scaffolder module as well as packaging both the enhanced scaffolder and the existing Gitea catalog plugin as dynamic plugins.

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
| **P2 — Repo features** | `homepage`, `hasIssues`, `hasWiki`, `hasProjects`, `topics`, `deleteBranchOnMerge`, `allowMergeCommit`, `allowSquashMerge`, `allowRebaseMerge`, `squashMergeCommitTitle`, `squashMergeCommitMessage`, `allowAutoMerge`, `allowUpdateBranch` | ❌ Not done |
| **GitHub-only** | `access`, `collaborators`, `bypassPullRequestAllowances`, `restrictions`, `requiredConversationResolution`, `requireLastPushApproval`, `repoVariables`, `secrets`, `oidcCustomization`, `customProperties`, `subscribe`, `requiredLinearHistory` | ℹ️ No Gitea equivalent |

**No breaking changes** — all new inputs are `.optional()`, so existing `publish:gitea` templates continue to work without modification.

## Getting started

1. Copy the files under `scaffolder-backend-module-gitea` into a real Backstage checkout at the same path.
2. Compile against the exact Backstage version you are targeting.
3. Run the action tests against a disposable Gitea instance.
4. Once upstream-style compilation works, move to `rhdh-packaging`.

## Publishing to Gitea npm registry

The unified pipeline script handles both plugins (catalog and scaffolder) in a single run:

```bash
cd rhdh-packaging
# Requires .env with GITEA_BASE_URL, GITEA_TOKEN, and GITEA_NPM_SCOPE at the project root
./scripts/publish-both-plugins.sh
```

This performs 5 steps:
1. **Decorate catalog** — wraps the catalog plugin from npmjs as an RHDH dynamic plugin (peerDependencies migration)
2. **Build scaffolder** — builds from local source (`../scaffolder-backend-module-gitea`), restructures for RHDH
3. **Publish** — pushes both tarballs as `@${GITEA_NPM_SCOPE}/*-dynamic` to the Gitea npm registry
4. **Validate** — fetches both packages back to verify integrity and structure
5. **Generate config** — copies `values-rhdh.yaml` and `dynamic-plugins.yaml` templates into `dist-config/`, then writes versions, SHA-256 hashes, and registry URLs into those generated files (the original templates remain unmodified)

The generated files in `dist-config/` are git-ignored. Before deploying, replace `<GITEA_HOST>` in `dist-config/values-rhdh.yaml` with your Gitea hostname.

