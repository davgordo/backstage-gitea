# RHDH smoke test

Register `direct-gitea-template.yaml` and `github-compat-template.yaml` as catalog locations after deploying the three dynamic plugins. Supply a disposable repository name, a reachable webhook receiver, and a Gitea token through the `Secret` form field.

Before running the compatibility template, inspect its processed catalog entity through the Catalog API or RHDH catalog UI. Its step actions should be `publish:gitea`, `gitea:webhook`, and `publish:gitea:pull-request`, while the source location and descriptive GitHub-shaped content remain unchanged.

Run each template once, then verify in Gitea that the repository exists, the push webhook is active, the `smoke-test-change` branch exists, and the pull request targets `main`. The task output should show `repoUrl`, `webhookId`, and `prUrl`.
