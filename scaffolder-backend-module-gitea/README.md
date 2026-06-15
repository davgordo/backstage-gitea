# scaffolder-backend-module-gitea

This module provides Backstage scaffolder actions for Gitea:

- **`publish:gitea`** — Creates a new repository and publishes workspace contents to it.
- **`gitea:webhook`** — Creates a repository webhook so Gitea calls a target URL on events.
- **`publish:gitea:pull-request`** — Publishes workspace files to a new branch and opens a pull request.
- **`gitea:branch-protection:create`** — Applies branch protection rules (required approvals, status checks, etc.).

## Getting started

To use this action, you will have to add the package using the following command to be executed at the root of your backstage project:

```bash
yarn --cwd packages/backend add @backstage/plugin-scaffolder-backend-module-gitea
```

Alternatively, if you use the new backend system, then register it like this:

```typescript
// packages/backend/src/index.ts
backend.add(import('@backstage/plugin-scaffolder-backend-module-gitea'));
```

Configure the action (if not yet done):
(you can check the [docs](https://backstage.io/docs/features/software-templates/writing-custom-actions#registering-custom-actions) to see all options):

Before to create a template, include to your `app-config.yaml` file the
gitea host and credentials under the `integrations:` section

```yaml
integrations:
  gitea:
    - host: gitea.com
      username: '<GITEA_USER>'
      password: '<GITEA_PASSWORD>'
    - host: localhost:3333
      username: '<GITEA_LOCALHOST_USER>'
      password: '<GITEA_LOCALHOST_PASSWORD>'
```

**Important**: As backstage will issue `HTTPS/TLS` requests to the gitea instance, it is needed to configure `gitea` with a valid certificate or at least with a
self-signed certificate `gitea cert --host localhost -ca` trusted by a CA authority. Don't forget to set the env var `NODE_EXTRA_CA_CERTS` to point to the CA file before launching backstage or you can set temporarily `NODE_TLS_REJECT_UNAUTHORIZED=0` but this is not recommended for production!

When done, you can create a template which:

- Declare the `RepoUrlPicker` within the `spec/parameters` section to select the gitea host and to provide the name of the repository
- Add an `enum` list allowing the user to define the visibility about the repository to be created: `public` or `private`. If this field is omitted, `public` is then used by the action.
- Include in a step the action: `publish:gitea`

**Warning**: The list of the `allowedOwners` of the `repoUrlPicker` must match the list of the `organizations` which are available on the gitea host !

```yaml
kind: Template
metadata:
  name: simple-gitea-project
  title: Create a gitea repository
  description: Create a gitea repository
spec:
  owner: guests
  type: service

  parameters:
    - title: Choose a location
      required:
        - repoUrl
      properties:
        repoUrl:
          title: Repository Location
          type: string
          ui:field: RepoUrlPicker
          ui:options:
            allowedOwners:
              - qteam
              - qshift
            allowedHosts:
              - gitea.localtest.me:3333

        repoVisibility:
          title: Visibility of the repository
          type: string
          default: 'public'
          enum:
            - 'public'
            - 'private'
          enumNames:
            - 'public'
            - 'private'

  steps:
    ...
    - id: publish
      name: Publishing to a gitea git repository
      action: publish:gitea
      input:
        description: This is ${{ parameters.repoUrl | parseRepoUrl | pick('repo') }}
        repoVisibility: ${{ parameters.repoVisibility }}
        repoUrl: ${{ parameters.repoUrl }}
        defaultBranch: main
```

Access the newly gitea repository created using the `repoContentsUrl` ;-)

### Integration Tests

This module includes integration tests that import the actual TypeScript action
handlers (`createGiteaWebhookAction`, `createGiteaPullRequestAction`,
`createGiteaBranchProtectionAction`) and run them with a mock scaffolder context
against a **live Gitea instance**. These are not executed by the unit test suite
and require a running Gitea server.

**Setup**

Set the following environment variables:

| Variable | Default | Description |
|---|---|---|
| `GITEA_BASE_URL` | *(required)* | Base URL of the Gitea instance |
| `GITEA_TOKEN` | *(required)* | Personal access token with repo scope |
| `GITEA_USERNAME` | *(required)* | Gitea username for repo creation |

**Running**

```bash
cd scaffolder-backend-module-gitea
npx tsx integration-test.ts
```

**Test suites**

| Suite | Tests | Description |
|---|---|---|
| `gitea:webhook` | 1 | Creates a webhook |
| `gitea:branch-protection` | 1 | Applies branch protection rules on `main` |
| `publish:gitea:pull-request` | 1 | Creates a file on a new branch and opens a PR |

A temporary test repository (`backstage-integration-test`) is created at startup and cleaned up on exit.

## Actions

### `publish:gitea`

Creates a new Gitea repository and pushes the workspace contents to it.

**Inputs**

| Property | Type | Required | Default | Description |
|---|---|---|---|---|
| `repoUrl` | string | Yes | — | Repository Location |
| `description` | string | Yes | — | Repository Description |
| `defaultBranch` | string | No | `main` | Sets the default branch on the repository |
| `repoVisibility` | `private` or `public` | No | `public` | Sets the visibility of the repository |
| `gitCommitMessage` | string | No | `initial commit` | Sets the commit message on the repository |
| `gitAuthorName` | string | No | `scaffolder.defaultAuthor.name` config | Sets the default author name for the commit |
| `gitAuthorEmail` | string | No | `scaffolder.defaultAuthor.email` config | Sets the default author email for the commit |
| `sourcePath` | string | No | — | Path within the workspace that will be used as the repository root. If omitted, the entire workspace will be published |
| `signCommit` | boolean | No | `false` | Sign commit with configured PGP private key |
| `token` | string | No | — | A Gitea authentication token to use for API and git operations. When provided, it overrides the integration credentials |
| `protectDefaultBranch` | boolean | No | `true` | Enables branch protection on the default branch |
| `protectEnforceAdmins` | boolean | No | `true` | Enforce branch protection for administrators |
| `requireCodeOwnerReviews` | boolean | No | `false` | Require review from code owners |
| `dismissStaleReviews` | boolean | No | `false` | Dismiss stale reviews on push |
| `requiredApprovingReviewCount` | number | No | `1` | Required number of approving reviews |
| `requiredStatusCheckContexts` | string[] | No | `[]` | List of required status check contexts |
| `requireBranchesToBeUpToDate` | boolean | No | `true` | Require branches to be up to date before merging |
| `requiredCommitSigning` | boolean | No | `false` | Require signed commits |

The following parameters are accepted for GitHub API parity but are **not supported** by Gitea and will be logged as warnings:
`bypassPullRequestAllowances`, `restrictions`, `requiredConversationResolution`, `requireLastPushApproval`, `requiredLinearHistory`.

**Outputs**

| Property | Type | Description |
|---|---|---|
| `remoteUrl` | string | A URL to the repository with the provider |
| `repoContentsUrl` | string | A URL to the root of the repository |
| `commitHash` | string | The git commit hash of the initial commit |

**Example**

```yaml
- id: publish
  name: Publishing to a gitea git repository
  action: publish:gitea
  input:
    repoUrl: gitea.com?owner=org&repo=repo
    description: My new repository
    defaultBranch: main
    repoVisibility: private
```

### `gitea:webhook`

Creates a webhook on an existing Gitea repository so that Gitea calls a target URL on events such as `push` or `pull_request`.

**Inputs**

| Property | Type | Required | Default | Description |
|---|---|---|---|---|
| `repoUrl` | string | Yes | — | Repository URL in Backstage repoUrl format, e.g. `gitea.example.com?owner=org&repo=name` |
| `webhookUrl` | string (URL) | Yes | — | Target URL that Gitea should call when the selected events occur |
| `events` | string[] | No | `[push]` | Gitea hook events, for example `push`, `pull_request`, `create`, `delete` |
| `webhookSecret` | string | No | — | Secret token Gitea sends to the webhook receiver |
| `active` | boolean | No | `true` | Whether the webhook is active |
| `contentType` | `json` or `form` | No | `json` | Content type of the webhook payload |
| `httpMethod` | `post` | No | `post` | HTTP method for the webhook |
| `insecureSsl` | boolean | No | `false` | When true, disables TLS verification for the hook target |
| `branchFilter` | string | No | — | Optional branch filter supported by Gitea hooks |
| `token` | string | No | — | Optional user or task token. When provided, it overrides configured integration credentials |

**Outputs**

| Property | Type | Description |
|---|---|---|
| `hookId` | number | The Gitea hook ID |
| `hookUrl` | string | The URL of the created webhook |

**Example**

```yaml
- id: webhook
  name: Create Gitea webhook
  action: gitea:webhook
  input:
    repoUrl: gitea.com?owner=org&repo=repo
    webhookUrl: https://tekton.example.com/webhook
    events:
      - push
      - pull_request
    webhookSecret: my-secret
```

### `publish:gitea:pull-request`

Publishes workspace files to a new branch in an existing Gitea repository and opens a pull request against a target base branch.

**Inputs**

| Property | Type | Required | Default | Description |
|---|---|---|---|---|
| `repoUrl` | string | Yes | — | Target repository URL in Backstage repoUrl format |
| `branchName` | string | Yes | — | Source branch to create/update |
| `targetBranchName` | string | No | `main` | Base branch for the pull request |
| `title` | string | Yes | — | Title of the pull request |
| `description` | string | No | — | Description/body of the pull request |
| `sourcePath` | string | No | `.` | Workspace subdirectory containing files to publish |
| `targetPath` | string | No | `.` | Target subdirectory in the repository |
| `commitMessage` | string | No | `title` value | Commit message for file changes |
| `token` | string | No | — | Optional authentication token. When provided, it overrides configured integration credentials |
| `draft` | boolean | No | `false` | Reserved for Gitea versions that support draft PRs |
| `filesToDelete` | string[] | No | `[]` | List of file paths to delete from the target branch |
| `reviewers` | string[] | No | `[]` | List of user logins to request as reviewers on the PR |
| `assignees` | string[] | No | `[]` | List of user logins to assign to the PR |
| `teamReviewers` | string[] | No | `[]` | List of team slugs to request as team reviewers on the PR |
| `update` | boolean | No | `false` | If true, update an existing PR instead of creating a new one |
| `createWhenEmpty` | boolean | No | `false` | If true, create a PR even if no files exist in the source path |

The following parameters are accepted for API parity with `publish:github:pull-request` but are **not supported** by Gitea Contents API and will be ignored:
`gitAuthorName`, `gitAuthorEmail`, `forceEmptyGitAuthor`.

**Outputs**

| Property | Type | Description |
|---|---|---|
| `pullRequestUrl` | string | URL to the created/updated pull request |
| `pullRequestNumber` | number | The pull request number (index) |
| `branchName` | string | The source branch name |
| `targetBranchName` | string | The target base branch name |

**Example**

```yaml
- id: pr
  name: Open pull request
  action: publish:gitea:pull-request
  input:
    repoUrl: gitea.com?owner=org&repo=repo
    branchName: feature/my-change
    targetBranchName: main
    title: Add new feature
    description: Description of the change
    reviewers:
      - alice
      - bob
```

### `gitea:branch-protection:create`

Applies branch protection rules (required approvals, status checks, signed commits, admin enforcement) to an existing Gitea branch.

**Inputs**

| Property | Type | Required | Default | Description |
|---|---|---|---|---|
| `repoUrl` | string | Yes | — | Repository URL in Backstage repoUrl format |
| `branchName` | string | No | `main` | The branch to protect |
| `branch` | string | No | — | Alias for `branchName` (GitHub parity) |
| `token` | string | No | — | Optional authentication token. When provided, it overrides configured integration credentials |
| `protectDefaultBranch` | boolean | No | — | Compatibility flag. If `false`, the action is a no-op. When omitted, branch protection is applied. |
| `protectEnforceAdmins` | boolean | No | `false` | Enforce branch protection for administrators |
| `enforceAdmins` | boolean | No | — | Alias for `protectEnforceAdmins` (GitHub parity); resolved as `enforceAdmins ?? protectEnforceAdmins ?? false` |
| `requireCodeOwnerReviews` | boolean | No | — | Block merging on rejected reviews |
| `dismissStaleReviews` | boolean | No | — | Dismiss stale approvals on push |
| `requiredApprovingReviewCount` | number | No | `0` | Required number of approving reviews (set to `0` by default, unlike `publish:gitea` which defaults to `1`) |
| `requiredStatusCheckContexts` | string[] | No | — | List of required status check contexts |
| `requireBranchesToBeUpToDate` | boolean | No | — | Block merging outdated branches |
| `requiredCommitSigning` | boolean | No | — | Require signed commits |
| `raw` | object | No | — | Additional raw Gitea branch protection payload fields (escape hatch) |

The following parameters are accepted for GitHub API parity but are **not supported** by Gitea and will emit a warning:
`bypassPullRequestAllowances`, `restrictions`, `requiredConversationResolution`, `requireLastPushApproval`, `requiredLinearHistory`, `blockCreations`.

**Outputs**

| Property | Type | Description |
|---|---|---|
| `branchName` | string | The name of the protected branch |

**Example**

```yaml
- id: protect
  name: Protect main branch
  action: gitea:branch-protection:create
  input:
    repoUrl: gitea.com?owner=org&repo=repo
    branchName: main
    requiredApprovingReviewCount: 2
    requiredStatusCheckContexts:
      - ci/build
    requiredCommitSigning: true
    protectEnforceAdmins: true
```
