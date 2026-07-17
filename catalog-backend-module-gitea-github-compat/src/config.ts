import { Config } from '@backstage/config';

export type TemplateCompatibilityConfig = {
  annotation: string;
  allowedHosts: Readonly<Record<string, string>>;
};

export type CompatibilityConfig = {
  enabled: boolean;
  templates: TemplateCompatibilityConfig;
};

export function readCompatibilityConfig(root: Config): CompatibilityConfig {
  const compat = root.getOptionalConfig('gitea.githubCompatibility');
  const templates = compat?.getOptionalConfig('templates');
  const allowedHosts: Record<string, string> = {};

  for (const mapping of templates?.getOptionalConfigArray('allowedHosts') ?? []) {
    const from = mapping.getString('from');
    if (allowedHosts[from]) {
      throw new Error(`Template host '${from}' is mapped more than once.`);
    }
    allowedHosts[from] = mapping.getString('to');
  }

  return {
    enabled: compat?.getOptionalBoolean('enabled') ?? false,
    templates: {
      annotation:
        templates?.getOptionalString('annotation') ??
        'backstage-gitea.io/github-compatible',
      allowedHosts,
    },
  };
}
