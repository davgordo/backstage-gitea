import { Entity } from '@backstage/catalog-model';
import { CatalogProcessor } from '@backstage/plugin-catalog-node';
import { TemplateCompatibilityConfig } from './config';

export const ACTION_MAP: Readonly<Record<string, string>> = {
  'publish:github': 'publish:gitea',
  'publish:github:pull-request': 'publish:gitea:pull-request',
  'github:webhook': 'gitea:webhook',
};

function mapRepoUrl(value: unknown, hosts: Readonly<Record<string, string>>): unknown {
  if (typeof value !== 'string') return value;
  const question = value.indexOf('?');
  if (question < 1) return value;
  const host = value.slice(0, question);
  const query = new URLSearchParams(value.slice(question + 1));
  if (!hosts[host] || !query.has('owner') || !query.has('repo')) return value;
  return `${hosts[host]}?${query.toString()}`;
}

function visit(value: unknown, hosts: Readonly<Record<string, string>>): void {
  if (Array.isArray(value)) {
    value.forEach(item => visit(item, hosts));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  if (typeof object.action === 'string' && ACTION_MAP[object.action]) {
    object.action = ACTION_MAP[object.action];
  }
  if ('repoUrl' in object) object.repoUrl = mapRepoUrl(object.repoUrl, hosts);
  const uiOptions = object['ui:options'];
  if (uiOptions && typeof uiOptions === 'object') {
    const options = uiOptions as Record<string, unknown>;
    if (Array.isArray(options.allowedHosts)) {
      options.allowedHosts = options.allowedHosts.map(host =>
        typeof host === 'string' ? hosts[host] ?? host : host,
      );
    }
  }
  Object.values(object).forEach(child => visit(child, hosts));
}

export class TemplateCompatibilityProcessor implements CatalogProcessor {
  constructor(private readonly config: TemplateCompatibilityConfig) {}
  getProcessorName(): string { return 'GiteaGithubTemplateCompatibilityProcessor'; }
  async preProcessEntity(entity: Entity): Promise<Entity> {
    if (entity.kind !== 'Template' || entity.metadata.annotations?.[this.config.annotation] !== 'true') return entity;
    const copy = structuredClone(entity);
    visit(copy.spec, this.config.allowedHosts);
    return copy;
  }
}
