# Gitea GitHub compatibility catalog module

This opt-in Stage One module lets canonical Backstage templates and selected catalog providers remain GitHub-shaped while an RHDH installation executes them against Gitea. It consumes configuration; it does not replace `core.rootConfig`, rewrite `integrations.github`, or register Gitea actions under GitHub IDs.

## Configuration

```yaml
integrations:
  gitea:
    - host: gitea.apps.example.com
      baseUrl: https://gitea.apps.example.com
      password: ${GITEA_TOKEN}

catalog:
  providers:
    github:
      cfidp:
        host: gitea.apps.example.com
        organization: agent-workspace
        catalogPath: /catalog-info.yaml
        filters:
          branch: main
        schedule:
          frequency: { minutes: 10 }
          timeout: { minutes: 3 }

gitea:
  githubCompatibility:
    enabled: true
    providers:
      - githubProviderId: cfidp
        giteaIntegrationHost: gitea.apps.example.com
    templates:
      annotation: backstage-gitea.io/github-compatible
      allowedHosts:
        - from: github.com
          to: gitea.apps.example.com
```

Only provider IDs listed under `githubCompatibility.providers` are consumed. Do not also register the stock GitHub entity provider for those IDs; other GitHub provider IDs remain available normally. The provider identity is `gitea-github-compat-provider:<providerId>`.

Discovery supports `host`, `organization`, `catalogPath`, `filters.branch`, and `schedule`. Leading catalog-path slashes are normalized. It rejects `app` and repository/topic/fork/visibility/archived/catalog-path filters. GitHub App discovery, events, regex/wildcard discovery, page-size tuning, and `validateLocationsExist` are intentionally unsupported.

Templates must be `kind: Template` and carry `backstage-gitea.io/github-compatible: "true"` (or the configured annotation). The processor maps only these exact IDs:

| GitHub action | Gitea action |
|---|---|
| `publish:github` | `publish:gitea` |
| `publish:github:pull-request` | `publish:gitea:pull-request` |
| `github:webhook` | `gitea:webhook` |

It also maps configured `RepoUrlPicker.ui:options.allowedHosts` entries and structured `repoUrl` values containing `owner` and `repo`. Descriptions, source annotations, documentation URLs, icons, and other public GitHub links are untouched. The mutation is deterministic and idempotent.

`publish:gitea:pull-request` guarantees `remoteUrl`, `pullRequestNumber`, and `targetBranchName`, retaining `pullRequestUrl` as an equal compatibility alias. Git author fields and `draft` are accepted compatibility no-ops; `forceFork` is rejected/not exposed. Stage Two may introduce a root-config adaptation service, but this package deliberately does not.
