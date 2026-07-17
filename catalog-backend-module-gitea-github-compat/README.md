# Gitea GitHub compatibility catalog module

This opt-in module lets canonical GitHub-authored Backstage Templates execute against Gitea. It is intentionally limited to Template entity mutation: it does not adapt catalog discovery configuration, replace `core.rootConfig`, rewrite integrations, or register Gitea actions under GitHub IDs.

## Configuration

```yaml
integrations:
  gitea:
    - host: gitea.apps.example.com
      baseUrl: https://gitea.apps.example.com
      password: ${GITEA_TOKEN}

gitea:
  githubCompatibility:
    enabled: true
    templates:
      annotation: backstage-gitea.io/github-compatible
      allowedHosts:
        - from: github.com
          to: gitea.apps.example.com
```

Catalog discovery remains configured independently through the normal Gitea or GitHub catalog modules. This module does not read `catalog.providers.github` and can coexist with the stock GitHub catalog provider.

Templates must be `kind: Template` and carry `backstage-gitea.io/github-compatible: "true"` (or the configured annotation). The processor maps only these exact IDs:

| GitHub action | Gitea action |
|---|---|
| `publish:github` | `publish:gitea` |
| `publish:github:pull-request` | `publish:gitea:pull-request` |
| `github:webhook` | `gitea:webhook` |

It also maps configured `RepoUrlPicker.ui:options.allowedHosts` entries and structured `repoUrl` values containing `owner` and `repo`. Descriptions, source annotations, documentation URLs, icons, and other public GitHub links are untouched. The mutation is deterministic and idempotent.

`publish:gitea:pull-request` guarantees `remoteUrl`, `pullRequestNumber`, and `targetBranchName`, retaining `pullRequestUrl` as an equal compatibility alias. Git author fields and `draft` are accepted compatibility no-ops; `forceFork` is rejected/not exposed.
