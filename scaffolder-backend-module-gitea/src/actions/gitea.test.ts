/*
 * Copyright 2023 The Backstage Authors
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
import { createPublishGiteaAction } from './gitea';
import { initRepoAndPush } from '@backstage/plugin-scaffolder-node';
import { rest } from 'msw';
import { registerMswTestHooks } from '@backstage/backend-test-utils';
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { setupServer } from 'msw/node';

jest.mock('@backstage/plugin-scaffolder-node', () => {
  return {
    ...jest.requireActual('@backstage/plugin-scaffolder-node'),
    initRepoAndPush: jest.fn().mockResolvedValue({
      commitHash: '220f19cc36b551763d157f1b5e4a4b446165dbd6',
    }),
  };
});

describe('publish:gitea', () => {
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

  const description = 'for the lols';
  const integrations = ScmIntegrations.fromConfig(config);
  const action = createPublishGiteaAction({ integrations, config });
  const mockContext = createMockActionContext({
    input: {
      repoUrl: 'gitea.com?repo=repo&owner=owner',
      description,
    },
  });
  const mockContextWithPublicRepoVisibility = createMockActionContext({
    input: {
      repoUrl: 'gitea.com?repo=repo&owner=owner',
      description,
      private: false,
    },
  });

  const server = setupServer();
  registerMswTestHooks(server);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  const mockSuccessfulPublish = (owner = 'org1') => {
    server.use(
      rest.get(`https://gitea.com/api/v1/orgs/${owner}`, (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({
            id: 1,
            name: owner,
            visibility: 'public',
            repo_admin_change_team_access: false,
            username: owner,
          }),
        );
      }),
      rest.get(
        `https://gitea.com/${owner}/repo/src/branch/main`,
        (_req, res, ctx) => {
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({}),
          );
        },
      ),
      rest.post(`https://gitea.com/api/v1/orgs/${owner}/repos`, (req, res, ctx) => {
        expect(req.body).toEqual({
          name: 'repo',
          private: false,
          description,
        });
        return res(
          ctx.status(201),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({}),
        );
      }),
    );
  };

  it('should throw an error when the repoUrl is not well formed', async () => {
    await expect(
      action.handler({
        ...mockContext,
        input: { repoUrl: 'gitea.com?owner=o', description },
      }),
    ).rejects.toThrow(/missing repo/);
  });

  it('should throw if there is no integration config provided for missing.com host', async () => {
    await expect(
      action.handler({
        ...mockContext,
        input: { repoUrl: 'missing.com?repo=repo', description },
      }),
    ).rejects.toThrow(/No matching integration configuration/);
  });

  it('should throw if there is no repositoryId returned', async () => {
    server.use(
      rest.get('https://gitea.com/api/v1/orgs/org1', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({
            id: 1,
            name: 'org1',
            visibility: 'public',
            repo_admin_change_team_access: false,
            username: 'org1',
          }),
        );
      }),
      rest.get(
        'https://gitea.com/org1/repo/src/branch/main',
        (_req, res, ctx) => {
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({}),
          );
        },
      ),
      rest.post('https://gitea.com/api/v1/orgs/org1/repos', (req, res, ctx) => {
        // Basic auth must match the user and password defined part of the config
        expect(req.headers.get('Authorization')).toBe(
          'basic Z2l0ZWFfdXNlcjpnaXRlYV9wYXNzd29yZA==',
        );
        expect(req.body).toEqual({
          name: 'repo',
          private: false,
          description,
        });
        return res(
          ctx.status(201),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({}),
        );
      }),
      rest.post(
        'https://gitea.com/api/v1/repos/org1/repo/branch_protections',
        (req, res, ctx) => {
          expect(req.headers.get('Authorization')).toBe('token gitea_password');
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({}),
          );
        },
      ),
    );

    await action.handler({
      ...mockContext,
      input: {
        ...mockContext.input,
        repoUrl: 'gitea.com?repo=repo&owner=org1',
      },
    });

    expect(initRepoAndPush).toHaveBeenCalledWith({
      dir: mockContext.workspacePath,
      remoteUrl: 'https://gitea.com/org1/repo.git',
      defaultBranch: 'main',
      auth: { username: 'gitea_user', password: 'gitea_password' },
      logger: mockContext.logger,
      commitMessage: expect.stringContaining('initial commit\n\nChange-Id:'),
      gitAuthorInfo: {
        email: undefined,
        name: undefined,
      },
    });

    expect(mockContext.output).toHaveBeenCalledWith(
      'repoContentsUrl',
      'https://gitea.com/org1/repo/src/branch/main/',
    );
  });

  it('should create a Gitea repository where visibility is public', async () => {
    server.use(
      rest.get('https://gitea.com/api/v1/orgs/org1', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({
            id: 1,
            name: 'org1',
            visibility: 'public',
            repo_admin_change_team_access: false,
            username: 'org1',
          }),
        );
      }),
      rest.get(
        'https://gitea.com/org1/repo/src/branch/main',
        (_req, res, ctx) => {
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({}),
          );
        },
      ),
      rest.post('https://gitea.com/api/v1/orgs/org1/repos', (req, res, ctx) => {
        // Basic auth must match the user and password defined part of the config
        expect(req.headers.get('Authorization')).toBe(
          'basic Z2l0ZWFfdXNlcjpnaXRlYV9wYXNzd29yZA==',
        );
        expect(req.body).toEqual({
          name: 'repo',
          private: false,
          description,
        });
        return res(
          ctx.status(201),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({}),
        );
      }),
      rest.post(
        'https://gitea.com/api/v1/repos/org1/repo/branch_protections',
        (req, res, ctx) => {
          expect(req.headers.get('Authorization')).toBe('token gitea_password');
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({}),
          );
        },
      ),
    );

    await action.handler({
      ...mockContextWithPublicRepoVisibility,
      input: {
        ...mockContextWithPublicRepoVisibility.input,
        repoUrl: 'gitea.com?repo=repo&owner=org1',
      },
    });

    expect(initRepoAndPush).toHaveBeenCalledWith({
      dir: mockContextWithPublicRepoVisibility.workspacePath,
      remoteUrl: 'https://gitea.com/org1/repo.git',
      defaultBranch: 'main',
      auth: { username: 'gitea_user', password: 'gitea_password' },
      logger: mockContextWithPublicRepoVisibility.logger,
      commitMessage: expect.stringContaining('initial commit\n\nChange-Id:'),
      gitAuthorInfo: {
        email: undefined,
        name: undefined,
      },
    });
  });

  it('should use the token for API auth and git push when provided', async () => {
    const userToken = 'my-user-token-123';

    server.use(
      rest.get('https://gitea.com/api/v1/orgs/org1', (req, res, ctx) => {
        expect(req.headers.get('Authorization')).toBe(`token ${userToken}`);
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({
            id: 1,
            name: 'org1',
            visibility: 'public',
            repo_admin_change_team_access: false,
            username: 'org1',
          }),
        );
      }),
      rest.get(
        'https://gitea.com/org1/repo/src/branch/main',
        (_req, res, ctx) => {
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({}),
          );
        },
      ),
      rest.post('https://gitea.com/api/v1/orgs/org1/repos', (req, res, ctx) => {
        expect(req.headers.get('Authorization')).toBe(`token ${userToken}`);
        expect(req.body).toEqual({
          name: 'repo',
          private: false,
          description,
        });
        return res(
          ctx.status(201),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({}),
        );
      }),
      rest.post(
        'https://gitea.com/api/v1/repos/org1/repo/branch_protections',
        (req, res, ctx) => {
          expect(req.headers.get('Authorization')).toBe(`token ${userToken}`);
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({}),
          );
        },
      ),
    );

    await action.handler({
      ...mockContext,
      input: {
        ...mockContext.input,
        repoUrl: 'gitea.com?repo=repo&owner=org1',
        token: userToken,
      },
    });

    expect(initRepoAndPush).toHaveBeenCalledWith({
      dir: mockContext.workspacePath,
      remoteUrl: 'https://gitea.com/org1/repo.git',
      defaultBranch: 'main',
      auth: { username: '', password: userToken },
      logger: mockContext.logger,
      commitMessage: expect.stringContaining('initial commit\n\nChange-Id:'),
      gitAuthorInfo: {
        email: undefined,
        name: undefined,
      },
    });
  });

  it('should apply access with an organization team as admin', async () => {
    mockSuccessfulPublish();
    const calls: string[] = [];

    server.use(
      rest.get('https://gitea.com/api/v1/orgs/org1/teams', (_req, res, ctx) =>
        res(ctx.status(200), ctx.json([{ id: 7, name: 'Platform Admins', slug: 'platform-admins' }])),
      ),
      rest.patch('https://gitea.com/api/v1/teams/7', (req, res, ctx) => {
        calls.push('patch-team');
        expect(req.body).toEqual({ permission: 'admin' });
        return res(ctx.status(200), ctx.json({}));
      }),
      rest.put('https://gitea.com/api/v1/teams/7/repos/org1/repo', (_req, res, ctx) => {
        calls.push('attach-team');
        return res(ctx.status(204));
      }),
    );

    await action.handler({
      ...mockContext,
      input: {
        ...mockContext.input,
        repoUrl: 'gitea.com?repo=repo&owner=org1',
        access: 'org1/platform-admins',
        protectDefaultBranch: false,
      },
    });

    expect(calls).toEqual(['patch-team', 'attach-team']);
  });

  it('should apply access with a user as admin', async () => {
    mockSuccessfulPublish();

    server.use(
      rest.put(
        'https://gitea.com/api/v1/repos/org1/repo/collaborators/noah',
        (req, res, ctx) => {
          expect(req.body).toEqual({ permission: 'admin' });
          return res(ctx.status(204));
        },
      ),
    );

    await action.handler({
      ...mockContext,
      input: {
        ...mockContext.input,
        repoUrl: 'gitea.com?repo=repo&owner=org1',
        access: 'noah',
        protectDefaultBranch: false,
      },
    });
  });

  it('should apply a team collaborator with push as write', async () => {
    mockSuccessfulPublish();

    server.use(
      rest.get('https://gitea.com/api/v1/orgs/org1/teams', (_req, res, ctx) =>
        res(ctx.status(200), ctx.json([{ id: 8, name: 'Developers', slug: 'developers' }])),
      ),
      rest.patch('https://gitea.com/api/v1/teams/8', (req, res, ctx) => {
        expect(req.body).toEqual({ permission: 'write' });
        return res(ctx.status(200), ctx.json({}));
      }),
      rest.put('https://gitea.com/api/v1/teams/8/repos/org1/repo', (_req, res, ctx) =>
        res(ctx.status(204)),
      ),
    );

    await action.handler({
      ...mockContext,
      input: {
        ...mockContext.input,
        repoUrl: 'gitea.com?repo=repo&owner=org1',
        collaborators: [{ team: 'developers', access: 'push' }],
        protectDefaultBranch: false,
      },
    });
  });

  it('should apply a user collaborator with admin', async () => {
    mockSuccessfulPublish();

    server.use(
      rest.put(
        'https://gitea.com/api/v1/repos/org1/repo/collaborators/noah',
        (req, res, ctx) => {
          expect(req.body).toEqual({ permission: 'admin' });
          return res(ctx.status(204));
        },
      ),
    );

    await action.handler({
      ...mockContext,
      input: {
        ...mockContext.input,
        repoUrl: 'gitea.com?repo=repo&owner=org1',
        collaborators: [{ user: 'noah', access: 'admin' }],
        protectDefaultBranch: false,
      },
    });
  });

  it.each([
    ['pull', 'read'],
    ['triage', 'read'],
    ['read', 'read'],
    ['push', 'write'],
    ['maintain', 'write'],
    ['write', 'write'],
    ['admin', 'admin'],
  ])('should normalize %s permission to %s', async (input, expected) => {
    mockSuccessfulPublish();

    server.use(
      rest.put(
        'https://gitea.com/api/v1/repos/org1/repo/collaborators/noah',
        (req, res, ctx) => {
          expect(req.body).toEqual({ permission: expected });
          return res(ctx.status(204));
        },
      ),
    );

    await action.handler({
      ...mockContext,
      input: {
        ...mockContext.input,
        repoUrl: 'gitea.com?repo=repo&owner=org1',
        collaborators: [{ user: 'noah', access: input }],
        protectDefaultBranch: false,
      },
    });
  });

  it('should fail clearly when a requested team does not exist', async () => {
    mockSuccessfulPublish();

    server.use(
      rest.get('https://gitea.com/api/v1/orgs/org1/teams', (_req, res, ctx) =>
        res(ctx.status(200), ctx.json([])),
      ),
    );

    await expect(
      action.handler({
        ...mockContext,
        input: {
          ...mockContext.input,
          repoUrl: 'gitea.com?repo=repo&owner=org1',
          collaborators: [{ team: 'missing-team', access: 'push' }],
          protectDefaultBranch: false,
        },
      }),
    ).rejects.toThrow(
      "repository org1/repo: team 'missing-team' with requested permission 'push' does not exist",
    );
  });

  it('should reject invalid collaborator permissions', async () => {
    mockSuccessfulPublish();

    await expect(
      action.handler({
        ...mockContext,
        input: {
          ...mockContext.input,
          repoUrl: 'gitea.com?repo=repo&owner=org1',
          collaborators: [{ user: 'noah', access: 'owner' }],
          protectDefaultBranch: false,
        },
      }),
    ).rejects.toThrow("Unsupported repository access permission 'owner'");
  });

  it('should reject team assignment against a non-organization owner', async () => {
    server.use(
      rest.get('https://gitea.com/api/v1/orgs/noah', (_req, res, ctx) =>
        res(ctx.status(404), ctx.json({ message: 'Not Found' })),
      ),
    );

    await expect(
      action.handler({
        ...mockContext,
        input: {
          ...mockContext.input,
          repoUrl: 'gitea.com?repo=repo&owner=noah',
          collaborators: [{ team: 'developers', access: 'push' }],
          protectDefaultBranch: false,
        },
      }),
    ).rejects.toThrow(
      "Cannot assign team access for repository noah/repo: repository owner 'noah' is not an organization",
    );
  });

  it('should preserve publish behavior when access inputs are omitted', async () => {
    mockSuccessfulPublish();

    await action.handler({
      ...mockContext,
      input: {
        ...mockContext.input,
        repoUrl: 'gitea.com?repo=repo&owner=org1',
        protectDefaultBranch: false,
      },
    });

    expect(initRepoAndPush).toHaveBeenCalledWith({
      dir: mockContext.workspacePath,
      remoteUrl: 'https://gitea.com/org1/repo.git',
      defaultBranch: 'main',
      auth: { username: 'gitea_user', password: 'gitea_password' },
      logger: mockContext.logger,
      commitMessage: expect.stringContaining('initial commit\n\nChange-Id:'),
      gitAuthorInfo: {
        email: undefined,
        name: undefined,
      },
    });
  });

  it('should pass the configured signing key when signCommit is enabled', async () => {
    const signingConfig = new ConfigReader({
      integrations: {
        gitea: [
          {
            host: 'gitea.com',
            username: 'gitea_user',
            password: 'gitea_password',
            commitSigningKey: 'integration-signing-key',
          },
        ],
      },
    });
    const signingAction = createPublishGiteaAction({
      integrations: ScmIntegrations.fromConfig(signingConfig),
      config: signingConfig,
    });

    server.use(
      rest.get('https://gitea.com/api/v1/orgs/org1', (_req, res, ctx) =>
        res(ctx.status(200), ctx.json({ id: 1 })),
      ),
      rest.get('https://gitea.com/org1/repo/src/branch/main', (_req, res, ctx) =>
        res(ctx.status(200), ctx.json({})),
      ),
      rest.post('https://gitea.com/api/v1/orgs/org1/repos', (_req, res, ctx) =>
        res(ctx.status(201), ctx.json({})),
      ),
      rest.post(
        'https://gitea.com/api/v1/repos/org1/repo/branch_protections',
        (_req, res, ctx) => res(ctx.status(200), ctx.json({})),
      ),
    );

    await signingAction.handler({
      ...mockContext,
      input: {
        ...mockContext.input,
        repoUrl: 'gitea.com?repo=repo&owner=org1',
        signCommit: true,
      },
    });

    expect(initRepoAndPush).toHaveBeenCalledWith(
      expect.objectContaining({
        signingKey: 'integration-signing-key',
      }),
    );
  });

  it('should reject signCommit when no signing key is configured', async () => {
    await expect(
      action.handler({
        ...mockContext,
        input: {
          ...mockContext.input,
          repoUrl: 'gitea.com?repo=repo&owner=org1',
          signCommit: true,
        },
      }),
    ).rejects.toThrow(
      'Signing commits is enabled but no signing key is provided',
    );
    expect(initRepoAndPush).not.toHaveBeenCalled();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });
});
