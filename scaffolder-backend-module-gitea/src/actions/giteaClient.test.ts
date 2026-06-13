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
import { ScmIntegrations } from '@backstage/integration';
import { resolveGiteaRepo } from './giteaClient';

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
