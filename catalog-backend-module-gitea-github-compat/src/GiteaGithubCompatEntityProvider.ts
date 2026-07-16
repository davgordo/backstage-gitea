import { LoggerService, SchedulerServiceTaskRunner } from '@backstage/backend-plugin-api';
import { GiteaIntegration, getGiteaRequestOptions } from '@backstage/integration';
import { EntityProvider, EntityProviderConnection, locationSpecToLocationEntity } from '@backstage/plugin-catalog-node';
import { CompatibilityProviderConfig } from './config';

type Repo = { name?: string; html_url?: string; empty?: boolean; archived?: boolean };

export class GiteaGithubCompatEntityProvider implements EntityProvider {
  private connection?: EntityProviderConnection;
  constructor(
    private readonly config: CompatibilityProviderConfig,
    private readonly integration: GiteaIntegration,
    private readonly logger: LoggerService,
    private readonly taskRunner: SchedulerServiceTaskRunner,
  ) {}
  getProviderName(): string { return `gitea-github-compat-provider:${this.config.id}`; }
  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    await this.taskRunner.run({ id: `${this.getProviderName()}:refresh`, fn: () => this.refresh() });
  }
  async refresh(): Promise<void> {
    if (!this.connection) throw new Error(`${this.getProviderName()} is not connected`);
    const baseUrl = (this.integration.config.baseUrl ?? `https://${this.integration.config.host}`).replace(/\/$/, '');
    const api = `${baseUrl}/api/v1`;
    const request = getGiteaRequestOptions(this.integration.config);
    const repos: Repo[] = [];
    for (let page = 1; ; page++) {
      const response = await fetch(`${api}/orgs/${encodeURIComponent(this.config.organization)}/repos?page=${page}&limit=50`, request);
      if (!response.ok) throw new Error(`GitHub-compatible Gitea provider '${this.config.id}' failed to list organization '${this.config.organization}' repositories (HTTP ${response.status}).`);
      const batch = await response.json() as Repo[];
      if (!Array.isArray(batch)) throw new Error(`GitHub-compatible Gitea provider '${this.config.id}' received an invalid repository response.`);
      repos.push(...batch);
      if (batch.length < 50) break;
    }
    const locations: string[] = [];
    for (const repo of repos) {
      if (!repo.name || repo.empty || repo.archived) continue;
      const contentUrl = `${api}/repos/${encodeURIComponent(this.config.organization)}/${encodeURIComponent(repo.name)}/contents/${this.config.catalogPath}?ref=${encodeURIComponent(this.config.branch)}`;
      const response = await fetch(contentUrl, request);
      if (response.status === 404) continue;
      if (!response.ok) throw new Error(`GitHub-compatible Gitea provider '${this.config.id}' failed to inspect ${repo.name}/${this.config.catalogPath} (HTTP ${response.status}).`);
      const web = repo.html_url ?? `${baseUrl}/${this.config.organization}/${repo.name}`;
      locations.push(`${web}/src/branch/${encodeURIComponent(this.config.branch)}/${this.config.catalogPath}`);
    }
    const locationKey = this.getProviderName();
    await this.connection.applyMutation({ type: 'full', entities: locations.map(target => ({ locationKey, entity: locationSpecToLocationEntity({ location: { type: 'url', target } }) })) });
    this.logger.info(`${this.getProviderName()} discovered ${locations.length} catalog locations from ${repos.length} repositories`);
  }
}
