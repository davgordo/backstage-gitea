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

import { ScmIntegrations } from '@backstage/integration';
import { ConfigReader } from '@backstage/config';
import { createGiteaWebhookAction } from './giteaWebhook';
import { rest } from 'msw';
import { registerMswTestHooks } from '@backstage/backend-test-utils';
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { setupServer } from 'msw/node';

describe('gitea:webhook', () => {
  const config = new ConfigReader({
    integrations: {
      gitea: [
        {
          host: 'gitea.com',
          username: 'gitea_user',
          password: 'gitea_password',
        },
      ],
    },
  });

  const integrations = ScmIntegrations.fromConfig(config);
  const action = createGiteaWebhookAction({ integrations });

  const server = setupServer();
  registerMswTestHooks(server);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should create a webhook and return the hook id', async () => {
    server.use(
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/hooks',
        (req, res, ctx) => {
          expect(req.headers.get('Authorization')).toBe(
            `basic ${Buffer.from('gitea_user:gitea_password').toString('base64')}`,
          );
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({ id: 42, url: 'https://gitea.com/api/v1/repos/owner/repo/hooks/42' }),
          );
        },
      ),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        webhookUrl: 'https://tekton.example.com/webhook',
        events: ['push'],
      },
    });

    await action.handler(mockContext);

    expect(mockContext.output).toHaveBeenCalledWith('hookId', 42);
    expect(mockContext.output).toHaveBeenCalledWith(
      'hookUrl',
      'https://gitea.com/api/v1/repos/owner/repo/hooks/42',
    );
  });

  it('should prefer an input token over integration credentials', async () => {
    server.use(
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/hooks',
        (req, res, ctx) => {
          expect(req.headers.get('Authorization')).toBe('token user-token');
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({ id: 43 }),
          );
        },
      ),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        webhookUrl: 'https://tekton.example.com/webhook',
        token: 'user-token',
      },
    });

    await action.handler(mockContext);
    expect(mockContext.output).toHaveBeenCalledWith('hookId', 43);
  });

  it('should include the secret and content type in the webhook config', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/hooks',
        async (req, res, ctx) => {
          capturedBody = await req.json();
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({ id: 99 }),
          );
        },
      ),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        webhookUrl: 'https://target.example.com/hook',
        webhookSecret: 'my-secret',
        contentType: 'json',
        events: ['push', 'pull_request'],
      },
    });

    await action.handler(mockContext);

    expect(capturedBody).toBeDefined();
    expect((capturedBody!.config as Record<string, unknown>).url).toBe(
      'https://target.example.com/hook',
    );
    expect((capturedBody!.config as Record<string, unknown>).secret).toBe('my-secret');
    expect((capturedBody!.config as Record<string, unknown>).content_type).toBe('json');
    expect(capturedBody!.events).toEqual(['push', 'pull_request']);
    expect(mockContext.output).toHaveBeenCalledWith('hookId', 99);
  });

  it('should support the insecure_ssl flag', async () => {
    server.use(
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/hooks',
        (_req, res, ctx) => {
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({ id: 1 }),
          );
        },
      ),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        webhookUrl: 'https://insecure.example.com/hook',
        insecureSsl: true,
      },
    });

    await action.handler(mockContext);
    expect(mockContext.output).toHaveBeenCalledWith('hookId', 1);
  });

  it('should throw when the repoUrl is missing owner', async () => {
    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?repo=repo',
        webhookUrl: 'https://example.com/hook',
      },
    });

    await expect(action.handler(mockContext)).rejects.toThrow();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });
});
