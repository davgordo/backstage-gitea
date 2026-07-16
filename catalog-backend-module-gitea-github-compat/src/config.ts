import { readSchedulerServiceTaskScheduleDefinitionFromConfig } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';

export type CompatibilityProviderConfig = {
  id: string;
  host: string;
  integrationHost: string;
  organization: string;
  catalogPath: string;
  branch: string;
  schedule: ReturnType<typeof readSchedulerServiceTaskScheduleDefinitionFromConfig>;
};

export type TemplateCompatibilityConfig = {
  annotation: string;
  allowedHosts: Readonly<Record<string, string>>;
};

export type CompatibilityConfig = {
  enabled: boolean;
  providers: CompatibilityProviderConfig[];
  templates: TemplateCompatibilityConfig;
};

const unsupportedFilterKeys = [
  'repository', 'topic', 'fork', 'visibility', 'archived', 'catalogPath',
];

export function readCompatibilityConfig(root: Config): CompatibilityConfig {
  const compat = root.getOptionalConfig('gitea.githubCompatibility');
  const templates = compat?.getOptionalConfig('templates');
  const enabled = compat?.getOptionalBoolean('enabled') ?? false;
  const mappings = new Map<string, string>();
  for (const item of compat?.getOptionalConfigArray('providers') ?? []) {
    const id = item.getString('githubProviderId');
    if (mappings.has(id)) {
      throw new Error(`GitHub-compatible Gitea provider '${id}' is registered more than once.`);
    }
    mappings.set(id, item.getString('giteaIntegrationHost'));
  }

  const github = root.getOptionalConfig('catalog.providers.github');
  const providers: CompatibilityProviderConfig[] = [];
  for (const [id, integrationHost] of mappings) {
    if (!github?.has(id)) {
      throw new Error(`GitHub-compatible Gitea provider '${id}' has no catalog.providers.github.${id} configuration.`);
    }
    const provider = github.getConfig(id);
    if (provider.has('app')) {
      throw new Error(`GitHub-compatible Gitea provider '${id}' cannot use the 'app' setting. Configure an organization instead.`);
    }
    const organization = provider.getOptionalString('organization');
    if (!organization) {
      throw new Error(`GitHub-compatible Gitea provider '${id}' requires 'organization'.`);
    }
    const filters = provider.getOptionalConfig('filters');
    const unsupported = unsupportedFilterKeys.filter(key => filters?.has(key));
    if (unsupported.length) {
      throw new Error(`GitHub-compatible Gitea provider '${id}' does not support filters.${unsupported[0]}.`);
    }
    if (!provider.has('schedule')) {
      throw new Error(`GitHub-compatible Gitea provider '${id}' requires 'schedule'.`);
    }
    const host = provider.getOptionalString('host') ?? integrationHost;
    if (host !== integrationHost) {
      throw new Error(`GitHub-compatible Gitea provider '${id}' host '${host}' does not match Gitea integration host '${integrationHost}'.`);
    }
    providers.push({
      id,
      host,
      integrationHost,
      organization,
      catalogPath: (provider.getOptionalString('catalogPath') ?? '/catalog-info.yaml').replace(/^\/+/, ''),
      branch: filters?.getOptionalString('branch') ?? 'main',
      schedule: readSchedulerServiceTaskScheduleDefinitionFromConfig(provider.getConfig('schedule')),
    });
  }

  const allowedHosts: Record<string, string> = {};
  for (const mapping of templates?.getOptionalConfigArray('allowedHosts') ?? []) {
    const from = mapping.getString('from');
    if (allowedHosts[from]) throw new Error(`Template host '${from}' is mapped more than once.`);
    allowedHosts[from] = mapping.getString('to');
  }
  return {
    enabled,
    providers: enabled ? providers : [],
    templates: {
      annotation: templates?.getOptionalString('annotation') ?? 'backstage-gitea.io/github-compatible',
      allowedHosts,
    },
  };
}
