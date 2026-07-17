/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ConfigReader } from '@backstage/config';
import { registerMswTestHooks } from '@backstage/backend-test-utils';
import { ScmIntegrations } from '@backstage/integration';
import { rest } from 'msw';
import { setupServer } from 'msw/node';
import { GiteaClient, resolveGiteaRepo } from './giteaClient';

const server = setupServer();
registerMswTestHooks(server);

describe('resolveGiteaRepo', () => {
  it('uses the default Gitea API path when apiBaseUrl is not configured', () => {
    const integrations = ScmIntegrations.fromConfig(
      new ConfigReader({
        integrations: {
          gitea: [
            {
              host: 'gitea.example.com',
              baseUrl: 'https://gitea.example.com/root/',
            },
          ],
        },
      }),
    );

    expect(
      resolveGiteaRepo({
        repoUrl: 'gitea.example.com?owner=owner&repo=repo',
        integrations,
      }),
    ).toMatchObject({
      apiBaseUrl: 'https://gitea.example.com/root/api/v1',
      repoUrl: 'https://gitea.example.com/root/owner/repo',
    });
  });

  it('uses a configured apiBaseUrl when the integration provides one', () => {
    const integrations = ScmIntegrations.fromConfig(
      new ConfigReader({
        integrations: {
          gitea: [{ host: 'gitea.example.com' }],
        },
      }),
    );
    const integration = integrations.gitea.byHost('gitea.example.com');

    if (!integration) {
      throw new Error('Expected Gitea integration');
    }

    Object.assign(integration.config, {
      apiBaseUrl: 'https://api.gitea.example.com/custom/',
    });

    expect(
      resolveGiteaRepo({
        repoUrl: 'gitea.example.com?owner=owner&repo=repo',
        integrations,
      }).apiBaseUrl,
    ).toBe('https://api.gitea.example.com/custom');
  });
});

describe('GiteaClient.getContents', () => {
  it('encodes path segments and ref, authenticates, and forwards the abort signal', async () => {
    const signal = new AbortController().signal;
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    server.use(
      rest.get(
        'https://gitea.example.com/api/v1/repos/owner/repo/contents/*',
        (req, res, ctx) => {
          expect(req.url.pathname).toBe(
            '/api/v1/repos/owner/repo/contents/nested%20dir/file%23.txt',
          );
          expect(req.url.searchParams.get('ref')).toBe('feature/a b');
          expect(req.headers.get('Authorization')).toBe('token user-token');
          return res(ctx.status(200), ctx.json({ sha: 'blob' }));
        },
      ),
    );
    const client = new GiteaClient({
      repo: {
        host: 'gitea.example.com',
        owner: 'owner',
        repo: 'repo',
        apiBaseUrl: 'https://gitea.example.com/api/v1',
        repoUrl: 'https://gitea.example.com/owner/repo',
      },
      token: 'user-token',
    });

    await expect(
      client.getContents('nested dir/file#.txt', 'feature/a b', signal),
    ).resolves.toEqual({ sha: 'blob' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://gitea.example.com/api/v1/repos/owner/repo/contents/nested%20dir/file%23.txt?ref=feature%2Fa%20b',
      expect.objectContaining({ signal }),
    );
  });
});
