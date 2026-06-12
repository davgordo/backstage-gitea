# Example Gitea deployment for OpenShift

This directory provides a simple lab-grade Gitea deployment to OpenShift so the Backstage/RHDH actions can be tested end-to-end.

It is intentionally not production-hardened. For a real lab, consider the Gitea Helm chart or the operator pattern you prefer.

## Prerequisites

- OpenShift cluster with `cluster-admin` or sufficient permissions to create namespaces, routes, and PVCs
- `oc` CLI authenticated to your cluster

## Before deploying

Several values must be set before applying:

### 1. Set your Gitea hostname

Replace `gitea.example.com` with your actual route hostname (e.g. `gitea.apps.cluster.lab.nusun.us`) in:

**`gitea.yaml`** — env vars `GITEA__server__ROOT_URL` and `GITEA__server__DOMAIN`:
```yaml
- name: GITEA__server__ROOT_URL
  value: "https://gitea.example.com/"
- name: GITEA__server__DOMAIN
  value: "gitea.example.com"
```

**`route.yaml`** — the `host` field:
```yaml
spec:
  host: gitea.example.com
```

### 2. Set a strong PostgreSQL password

**`postgres.yaml`** — replace the placeholder password in the Secret:
```yaml
stringData:
  POSTGRES_PASSWORD: CHANGE_ME_GENERATE_STRONG_PASSWORD
```

Generate one with:
```bash
openssl rand -base64 32
```

### 3. Create the Gitea secrets

`gitea.yaml` references a Secret named `gitea-secrets` that is **not included** in this manifest. Create it before deploying:

```bash
oc -n gitea create secret generic gitea-secrets \
  --from-literal=SECRET_KEY=$(openssl rand -hex 32) \
  --from-literal=INTERNAL_TOKEN=$(openssl rand -hex 32) \
  --from-literal=JWT_SECRET=$(openssl rand -hex 32)
```

### 4. Choose a StorageClass (optional)

The PVCs use the cluster's default StorageClass. If your cluster requires a specific class, add `storageClassName: <your-class>` to both `gitea-data` and `gitea-postgres` PVC specs.

## Deploy

```bash
oc apply -k openshift-gitea
```

## After deployment

1. Open the Route — `oc get route gitea -n gitea` to find the URL.
2. Create the first admin user via the Gitea web UI.
3. Create a personal access token (PAT) with `repo`, `packages`, and `write:hooks` scopes.
4. Add the PAT to RHDH/Backstage as `GITEA_TOKEN` in your app-config or secret.
5. Configure `integrations.gitea` in RHDH app-config with your Gitea host and token.
