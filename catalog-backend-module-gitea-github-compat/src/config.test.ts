import { ConfigReader } from '@backstage/config';
import { readCompatibilityConfig } from './config';

const base = {
  integrations: { gitea: [{ host: 'gitea.apps.example.com' }] },
  catalog: { providers: { github: { cfidp: { host: 'gitea.apps.example.com', organization: 'agent-workspace', catalogPath: '/catalog-info.yaml', filters: { branch: 'main' }, schedule: { frequency: { minutes: 10 }, timeout: { minutes: 3 } } }, github: { host: 'github.com', organization: 'real', schedule: { frequency: { minutes: 10 }, timeout: { minutes: 3 } } } } } },
  gitea: { githubCompatibility: { enabled: true, providers: [{ githubProviderId: 'cfidp', giteaIntegrationHost: 'gitea.apps.example.com' }], templates: { allowedHosts: [{ from: 'github.com', to: 'gitea.apps.example.com' }] } } },
};

describe('readCompatibilityConfig', () => {
  it('selects only configured provider IDs and normalizes catalogPath', () => {
    const result = readCompatibilityConfig(new ConfigReader(base));
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({ id: 'cfidp', organization: 'agent-workspace', branch: 'main', catalogPath: 'catalog-info.yaml' });
  });
  it.each([
    ['app', { app: 'x', organization: undefined }, "cannot use the 'app' setting"],
    ['unsupported filter', { filters: { topic: 'x' } }, 'does not support filters.topic'],
  ])('rejects %s', (_name, patch, message) => {
    const value: any = structuredClone(base);
    Object.assign(value.catalog.providers.github.cfidp, patch);
    expect(() => readCompatibilityConfig(new ConfigReader(value))).toThrow(message);
  });
});
