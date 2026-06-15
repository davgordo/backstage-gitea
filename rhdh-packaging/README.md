# RHDH Packaging

Packages the Gitea catalog and scaffolder modules as **RHDH dynamic plugins** and publishes them to the `@${GITEA_NPM_SCOPE}` Gitea npm registry.

## What's Published

| Plugin | Source | Version (RHDH 1.10.1 / Backstage 1.49.4) |
|---|---|---|
| `@${GITEA_NPM_SCOPE}/plugin-catalog-backend-module-gitea-dynamic` | Upstream 0.1.10 from npmjs | 0.1.10-rhdh.1.10.1.1 |
| `@${GITEA_NPM_SCOPE}/plugin-scaffolder-backend-module-gitea-dynamic` | Local custom source based on upstream 0.2.19 | 0.2.19-rhdh.1.10.1.1 |

Both packages have `@backstage/*` dependencies migrated to `peerDependencies` for RHDH compatibility.
Published versions use the suffix `-rhdh.<target-version>.<revision>` to make
their intended RHDH runtime and custom packaging revision explicit.

## Directory Layout

```
rhdh-packaging/
├── .npmrc                          # Reference template — never filled with secrets
├── .gitignore
├── README.md                       # this file
├── dynamic-plugins.yaml            # Template — plugin manifest (not modified by publish script)
├── values-rhdh.yaml                # Template — Helm values for RHDH deployment
├── scripts/
│   ├── prepare-package.mjs         # Shared npm package metadata transformation
│   └── publish-both-plugins.sh     # Unified pipeline: stage → publish → validate → update config
└── smoke-test/
    └── template.yaml               # Scaffolder template to verify all Gitea actions
```

Generated artifacts (git-ignored):
- `dist-rhdh/` — npm tarballs and SHA-256 sidecars
- `dynamic-plugins-root/` — staged npm package directories
- `dist-config/` — deployment-ready `values-rhdh.yaml`, `dynamic-plugins.yaml`, and `npmrc`

## Prerequisites

1. **Node.js** v24, **npm** 10+, and **yq** v4+
2. **`.env`** file at the project root with:
   ```env
   GITEA_BASE_URL=https://gitea.example.com
   GITEA_TOKEN=<your-personal-access-token>
   GITEA_NPM_SCOPE=<your-npm-scope>
   ```
   `GITEA_NPM_SCOPE` is the npm scope/organization (e.g., `nusun`) used for published package names (`@$GITEA_NPM_SCOPE/...`).

## Targeting a Different RHDH Version

Dynamic plugin compatibility follows the complete runtime package set, not
just the RHDH version number:

```text
RHDH version -> Backstage version -> matching upstream plugin versions
```

Do not automatically use the latest Gitea plugin releases. First identify the
Backstage version used by the target RHDH release, then use the Gitea module
versions contained in that exact Backstage release.

For example, RHDH `1.10.1` uses Backstage `1.49.4`, which contains:

| Module | Matching upstream version |
|---|---|
| `@backstage/plugin-catalog-backend-module-gitea` | `0.1.10` |
| `@backstage/plugin-scaffolder-backend-module-gitea` | `0.2.19` |

To target another RHDH version:

1. Find the target RHDH release branch or tag in the
   [`redhat-developer/rhdh`](https://github.com/redhat-developer/rhdh)
   repository.
2. Read `backstage.json` from that release to find its Backstage version.
3. Inspect the matching Backstage tag to identify the catalog and scaffolder
   Gitea module versions and their `@backstage/*` dependency versions.
4. Rebase or compare the local scaffolder customizations against that upstream
   scaffolder module version. Preserve the local actions, but review any
   material upstream source changes before carrying them forward.
5. Update `scaffolder-backend-module-gitea/package.json`:
   - Set the package version to
     `<upstream-version>-rhdh.<target-rhdh-version>.<revision>`.
   - Align `dependencies`, `peerDependencies`, and `devDependencies` with the
     target Backstage release.
6. Update `CATALOG_SOURCE_VERSION` and `CATALOG_VERSION` in
   `scripts/publish-both-plugins.sh`:

   ```bash
   CATALOG_SOURCE_VERSION="<matching-upstream-version>"
   CATALOG_VERSION="<matching-upstream-version>-rhdh.<target-rhdh-version>.<revision>"
   ```

7. Update the version table and Node.js prerequisite in this README.
8. Run the module build, lint, and tests before publishing:

   ```bash
   cd scaffolder-backend-module-gitea
   npm install --no-package-lock
   npm run build
   npm run lint
   npm test -- --runInBand
   ```

9. Run the publishing pipeline and deploy using the newly generated
   `dist-config/` files.
10. Run the RHDH smoke-test template against the target RHDH installation.

Increment the final revision component whenever packaging, metadata, or local
source changes require a new artifact for the same RHDH target. For example:

```text
0.2.19-rhdh.1.10.1.1 -> 0.2.19-rhdh.1.10.1.2
```

## One-Command Pipeline

```bash
cd rhdh-packaging
./scripts/publish-both-plugins.sh
```

This runs 5 steps end-to-end:

| Step | Action |
|---|---|
| **A) Stage catalog** | Fetch from npmjs and stage as an RHDH-compatible npm package |
| **B) Stage scaffolder** | Build from local source and stage as an RHDH-compatible npm package |
| **C) Publish** | Push both as `@${GITEA_NPM_SCOPE}/*-dynamic` to the Gitea npm registry (skips if already published) |
| **D) Validate** | Fetch back from registry, strictly verify package identity and structure, and compute integrity |
| **E) Generate config** | Render versions, SHA-256 hashes, registry URLs, and deployment npm credentials into `dist-config/` |

Both plugins pass through the same package-staging function. The pipeline
creates standard npm packages directly; it does not construct and re-extract
intermediate RHDH tarballs.

## Deploying to RHDH

### 1. Create the npmrc secret

```bash
# First, generate the config by running the publish script
cd rhdh-packaging && ./scripts/publish-both-plugins.sh

# Then create the secret from the generated npmrc
kubectl create secret generic rhdh-npm-scope \
  --from-literal=npmrc="$(cat rhdh-packaging/dist-config/npmrc)" \
  -n rhdh
```

### 2. Create the Gitea token secret

```bash
kubectl create secret generic rhdh-gitea-secrets \
  --from-literal=GITEA_TOKEN=<your-personal-access-token> \
  -n rhdh
```

The token needs `repo` and `webhook` scopes.

### 3. Deploy with Helm

Use the **generated** config from `dist-config/`, not the templates:

```bash
helm upgrade --install rhdh redhat-developer-hub/rhdh \
  -f rhdh-packaging/dist-config/values-rhdh.yaml
```

**Before deploying**, edit `dist-config/values-rhdh.yaml` to replace `<GITEA_HOST>` in the embedded app-config section with your Gitea hostname.

### 4. Smoke test

Import `smoke-test/template.yaml` into RHDH and run it to verify all scaffolder actions.

## Gitea Configuration

The **generated** `dist-config/values-rhdh.yaml` includes app config for the Gitea integration.
After running the publish script, edit the generated file to replace `<GITEA_HOST>` with your actual Gitea hostname:

```yaml
integrations:
  gitea:
    - host: gitea.example.com
      baseUrl: https://gitea.example.com
      apiBaseUrl: https://gitea.example.com/api/v1
      # Backstage treats password without username as a Gitea HTTP token.
      password: ${GITEA_TOKEN}
```

The original templates (`values-rhdh.yaml`, `dynamic-plugins.yaml`) are never modified by the publish script.

## Troubleshooting

| Problem | Fix |
|---|---|
| `E409` on publish | Version already exists on registry — rerun to confirm, or bump version |
| Integrity mismatch in RHDH | Re-run `publish-both-plugins.sh` to regenerate `dist-config/` files |
| Network timeout during publish | Re-run the script from the same directory |
