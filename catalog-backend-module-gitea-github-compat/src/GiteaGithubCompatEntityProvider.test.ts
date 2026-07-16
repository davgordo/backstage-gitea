import { GiteaIntegration } from '@backstage/integration';
import { GiteaGithubCompatEntityProvider } from './GiteaGithubCompatEntityProvider';

const logger: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child() { return this; } };
const config: any = {
  id: 'cfidp', host: 'gitea.example.com', integrationHost: 'gitea.example.com',
  organization: 'agent-workspace', catalogPath: 'catalog-info.yaml', branch: 'main', schedule: {},
};
const integration = new GiteaIntegration({ host: 'gitea.example.com', baseUrl: 'https://gitea.example.com', password: 'token' });

function response(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('GiteaGithubCompatEntityProvider', () => {
  const applyMutation = jest.fn();
  beforeEach(() => { jest.resetAllMocks(); applyMutation.mockResolvedValue(undefined); });

  it('paginates, filters missing/empty/archived repositories, and applies a full mutation', async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) => ({ name: `missing-${i}`, html_url: `https://gitea.example.com/agent-workspace/missing-${i}` }));
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async url => {
      const value = String(url);
      if (value.includes('/repos?page=1')) return response(200, firstPage);
      if (value.includes('/repos?page=2')) return response(200, [
        { name: 'service', html_url: 'https://gitea.example.com/agent-workspace/service' },
        { name: 'empty', empty: true }, { name: 'old', archived: true },
      ]);
      if (value.includes('/contents/') && value.includes('/service/')) return response(200, { name: 'catalog-info.yaml' });
      return response(404);
    });
    const runner: any = { run: ({ fn }: any) => fn() };
    const provider = new GiteaGithubCompatEntityProvider(config, integration, logger, runner);
    await provider.connect({ applyMutation, refresh: jest.fn() });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/repos?page=2&limit=50'), expect.anything());
    expect(applyMutation).toHaveBeenCalledWith(expect.objectContaining({
      type: 'full',
      entities: [expect.objectContaining({ locationKey: 'gitea-github-compat-provider:cfidp', entity: expect.objectContaining({ spec: expect.objectContaining({ target: 'https://gitea.example.com/agent-workspace/service/src/branch/main/catalog-info.yaml' }) }) })],
    }));
  });

  it('reports precise Gitea API errors', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(response(503));
    const provider = new GiteaGithubCompatEntityProvider(config, integration, logger, { run: ({ fn }: any) => fn() } as any);
    await expect(provider.connect({ applyMutation, refresh: jest.fn() })).rejects.toThrow("provider 'cfidp' failed to list organization 'agent-workspace' repositories (HTTP 503)");
  });
});
