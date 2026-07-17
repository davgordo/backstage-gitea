# Backstage Gitea

Use Gitea as a practical first-class SCM backend for Backstage and Red Hat Developer Hub software templates.

This repository fills several gaps between Backstage’s GitHub and Gitea integrations. It provides enhanced Gitea scaffolder actions, catalog discovery packaging, and an opt-in compatibility layer that lets GitHub-authored software templates run against Gitea without maintaining a separate Gitea-specific copy of every golden path.

## What this enables

With these plugins, a Backstage or RHDH software template can:

* Create and populate a Gitea repository.
* Publish only a selected scaffolder workspace directory.
* Use a task- or user-provided Gitea token.
* Assign repository access to users and organization teams.
* Configure branch protection during repository creation.
* Create or update branches and pull requests in existing repositories.
* Delete files through pull requests.
* Add pull-request reviewers and assignees.
* Create repository webhooks for CI/CD and GitOps automation.
* Discover catalog entities from Gitea organizations.
* Run selected GitHub-authored templates against Gitea without rewriting their public action IDs.

This makes the project useful for internal developer platforms that use Gitea as their source-control system but still want to use the Backstage software-template ecosystem and GitHub-oriented golden-path conventions.

## Typical workflows

### Provision a new application repository

A template can create a repository, push generated source, assign a Gitea team, and protect the default branch:

```yaml
- id: publish
  name: Publish application repository
  action: publish:gitea
  input:
    repoUrl: gitea.example.com?owner=platform-apps&repo=orders-service
    description: Orders service
    defaultBranch: main
    repoVisibility: private
    sourcePath: application-repo
    access: platform-apps/developers
    protectDefaultBranch: true
    requiredApprovingReviewCount: 1
```

The action returns the repository URL, repository contents URL, and initial commit hash for use by later scaffolder steps.

### Propose a GitOps change through a pull request

Templates can stage a focused change and open a pull request against an existing platform repository:

```yaml
- id: gitopsPullRequest
  name: Add application to GitOps
  action: publish:gitea:pull-request
  input:
    repoUrl: gitea.example.com?owner=platform&repo=cluster-gitops
    branchName: add-orders-service
    targetBranchName: main
    title: Add orders-service
    description: Adds the generated deployment configuration.
    sourcePath: gitops-pr
    targetPath: applications/orders-service
    update: true
```

This supports deterministic platform branches: a retry can update an existing open pull request instead of creating duplicate changes.

### Create a delivery webhook

```yaml
- id: webhook
  name: Configure delivery webhook
  action: gitea:webhook
  input:
    repoUrl: gitea.example.com?owner=platform-apps&repo=orders-service
    webhookUrl: https://pipelines.example.com/hooks/gitea
    events:
      - push
      - pull_request
    webhookSecret: ${{ secrets.webhookSecret }}
```

## Available scaffolder actions

| Action                           | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `publish:gitea`                  | Create a Gitea repository and push generated workspace content |
| `publish:gitea:pull-request`     | Publish files to a branch and open or update a pull request    |
| `gitea:webhook`                  | Create a repository webhook                                    |
| `gitea:branch-protection:create` | Apply branch protection to an existing repository              |

The enhanced `publish:gitea` action includes support for token overrides, repository collaborators, organization teams, commit signing, and GitHub-shaped branch-protection inputs.

See the [scaffolder module documentation](scaffolder-backend-module-gitea/README.md) for the complete input and output reference.

## Reuse GitHub-authored templates with Gitea

Many Backstage templates are written using canonical GitHub actions:

```yaml
action: publish:github
```

Maintaining separate GitHub and Gitea versions of every template causes the two variants to drift. This repository includes an opt-in catalog processor that adapts selected templates when they are ingested.

```text
GitHub-authored Template
        │
        ▼
Gitea compatibility processor
        │
        ├── publish:github
        │      → publish:gitea
        │
        ├── publish:github:pull-request
        │      → publish:gitea:pull-request
        │
        └── github:webhook
               → gitea:webhook
```

Templates opt in with an annotation:

```yaml
apiVersion: scaffolder.backstage.io/v1beta3
kind: Template
metadata:
  name: create-service
  annotations:
    backstage-gitea.io/github-compatible: "true"
```

The processor also maps configured `RepoUrlPicker` hosts and structured `repoUrl` values:

```yaml
gitea:
  githubCompatibility:
    enabled: true
    templates:
      annotation: backstage-gitea.io/github-compatible
      allowedHosts:
        - from: github.com
          to: gitea.example.com
```

The compatibility layer is deliberately narrow:

* It mutates only opted-in `Template` entities.
* It does not replace global integrations.
* It does not register Gitea actions under GitHub action IDs.
* It does not alter catalog discovery.
* It leaves documentation links, source annotations, icons, and unrelated GitHub URLs untouched.

This lets template authors preserve a canonical GitHub-shaped contract while each platform chooses the SCM implementation used at runtime.

See the [compatibility module documentation](catalog-backend-module-gitea-github-compat/README.md) for the exact transformation rules.

## Red Hat Developer Hub dynamic plugins

The repository includes an end-to-end packaging pipeline for Red Hat Developer Hub.

It produces three dynamic plugins:

1. The standard Gitea catalog backend module.
2. The enhanced Gitea scaffolder backend module.
3. The GitHub-template compatibility catalog module.

The pipeline:

* Builds or stages each plugin.
* Converts Backstage dependencies for RHDH dynamic-plugin loading.
* Publishes the packages to a Gitea npm registry.
* Fetches them back to validate package identity and integrity.
* Generates deployment-ready plugin and Helm configuration.
* Records package versions and SHA-256 integrity values.

```bash
cd rhdh-packaging

# Reads GITEA_BASE_URL, GITEA_TOKEN, and GITEA_NPM_SCOPE
# from the repository-level .env file.
./scripts/publish-all-plugins.sh
```

Generated deployment configuration is written under:

```text
rhdh-packaging/dist-config/
```

Dynamic-plugin packages must be built for the exact Backstage version used by the target RHDH release. Do not assume that the latest upstream Gitea modules are compatible with an older RHDH runtime.

See [RHDH packaging](rhdh-packaging/README.md) for version alignment, publishing, deployment, and smoke-test instructions.

## Direct Backstage usage

For a standard Backstage backend using the new backend system:

```typescript
backend.add(
  import('@backstage/plugin-scaffolder-backend-module-gitea'),
);
```

Configure the Gitea integration:

```yaml
integrations:
  gitea:
    - host: gitea.example.com
      baseUrl: https://gitea.example.com
      apiBaseUrl: https://gitea.example.com/api/v1
      username: ${GITEA_USERNAME}
      password: ${GITEA_TOKEN}
```

The integration credentials act as the default automation identity. Actions that support a `token` input can override those credentials for an individual scaffolder task.

Gitea is not a standard Backstage authentication provider, so this repository does not automatically retrieve a Gitea token from the signed-in Backstage identity. A user token must be supplied through the template form, secret input, or another platform-specific credential flow.

## Repository components

This is a workspace containing several related deliverables rather than a single plugin:

* [`scaffolder-backend-module-gitea`](scaffolder-backend-module-gitea/README.md) contains the enhanced Gitea scaffolder actions.
* [`catalog-backend-module-gitea-github-compat`](catalog-backend-module-gitea-github-compat/README.md) contains the opt-in Template compatibility processor.
* [`rhdh-packaging`](rhdh-packaging/README.md) builds, publishes, validates, and configures the RHDH dynamic plugins.
* [`examples`](examples/) contains integration and software-template examples.
* [`openshift-gitea`](openshift-gitea/README.md) contains a lab-grade Gitea deployment for OpenShift testing.

The OpenShift manifests are intended for development and end-to-end testing, not as a production-hardened Gitea deployment.

## Current scope

Implemented:

* Repository creation and initial push.
* Per-task token override.
* User and organization-team repository access.
* Branch protection.
* Pull-request creation and update.
* Webhook creation.
* Gitea catalog discovery packaging.
* GitHub-authored Template compatibility.
* RHDH dynamic-plugin packaging and registry publication.

Not yet covered:

* The full set of GitHub repository feature controls.
* GitHub-only concepts that have no direct Gitea equivalent.
* Automatic Gitea token acquisition from the Backstage user identity.
* Production Gitea deployment automation.

The detailed action reference identifies inputs that are supported, accepted as compatibility no-ops, or unavailable in Gitea.
