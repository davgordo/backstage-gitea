import { ConfigReader } from '@backstage/config';
import { readCompatibilityConfig } from './config';

describe('readCompatibilityConfig', () => {
  it('reads only template compatibility configuration', () => {
    const result = readCompatibilityConfig(new ConfigReader({
      gitea: {
        githubCompatibility: {
          enabled: true,
          templates: {
            annotation: 'example.com/gitea-compatible',
            allowedHosts: [
              { from: 'github.com', to: 'gitea.apps.example.com' },
            ],
          },
        },
      },
    }));

    expect(result).toEqual({
      enabled: true,
      templates: {
        annotation: 'example.com/gitea-compatible',
        allowedHosts: { 'github.com': 'gitea.apps.example.com' },
      },
    });
  });

  it('is disabled by default and uses the stable annotation', () => {
    expect(readCompatibilityConfig(new ConfigReader({}))).toEqual({
      enabled: false,
      templates: {
        annotation: 'backstage-gitea.io/github-compatible',
        allowedHosts: {},
      },
    });
  });

  it('rejects duplicate host mappings', () => {
    const config = new ConfigReader({
      gitea: { githubCompatibility: { templates: { allowedHosts: [
        { from: 'github.com', to: 'gitea.one.example.com' },
        { from: 'github.com', to: 'gitea.two.example.com' },
      ] } } },
    });
    expect(() => readCompatibilityConfig(config)).toThrow(
      "Template host 'github.com' is mapped more than once.",
    );
  });
});
