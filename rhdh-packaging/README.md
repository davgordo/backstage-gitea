# RHDH Packaging

Packages the Gitea catalog and scaffolder modules as **RHDH dynamic plugins** and publishes them to the `@${GITEA_NPM_SCOPE}` Gitea npm registry.

## What's Published

| Plugin | Source | Version (RHDH 1.9.4) |
|---|---|---|
| `@${GITEA_NPM_SCOPE}/plugin-catalog-backend-module-gitea-dynamic` | `@backstage/*` from npmjs | 0.1.6 |
| `@${GITEA_NPM_SCOPE}/plugin-scaffolder-backend-module-gitea-dynamic` | Local source (`../scaffolder-backend-module-gitea`) | local version |

Both packages have `@backstage/*` dependencies migrated to `peerDependencies` for RHDH compatibility.

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

1. **Node.js** v20+, **npm** 10+, and **yq** v4+
2. **`.env`** file at the project root with:
   ```env
   GITEA_BASE_URL=https://gitea.example.com
   GITEA_TOKEN=<your-personal-access-token>
   GITEA_NPM_SCOPE=<your-npm-scope>
   ```
   `GITEA_NPM_SCOPE` is the npm scope/organization (e.g., `nusun`) used for published package names (`@$GITEA_NPM_SCOPE/...`).

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
      token: ${GITEA_TOKEN}
```

The original templates (`values-rhdh.yaml`, `dynamic-plugins.yaml`) are never modified by the publish script.

## Troubleshooting

| Problem | Fix |
|---|---|
| `E409` on publish | Version already exists on registry — rerun to confirm, or bump version |
| Integrity mismatch in RHDH | Re-run `publish-both-plugins.sh` to regenerate `dist-config/` files |
| Network timeout during publish | Re-run the script from the same directory |
