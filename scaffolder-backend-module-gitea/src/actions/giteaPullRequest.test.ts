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
import { rest } from 'msw';
import { registerMswTestHooks } from '@backstage/backend-test-utils';
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { setupServer } from 'msw/node';

// Mock the entire scaffolder-node module BEFORE importing the action factory.
// This ensures the action's handler closure captures the mocked function.
jest.mock('@backstage/plugin-scaffolder-node', () => {
  const actual = jest.requireActual('@backstage/plugin-scaffolder-node');
  return {
    ...actual,
    serializeDirectoryContents: jest.fn(),
  };
});

// Import the module-under-test AFTER the mock is registered.
import { createGiteaPullRequestAction } from './giteaPullRequest';
// Import the mocked module so we can control its behavior per-test.
import * as scaffolderNode from '@backstage/plugin-scaffolder-node';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const serializeSpy = (scaffolderNode.serializeDirectoryContents as any).mockResolvedValue([
  { path: 'README.md', content: '# Hello' },
]);

describe('publish:gitea:pull-request', () => {
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

  const server = setupServer();
  registerMswTestHooks(server);

  let action: ReturnType<typeof createGiteaPullRequestAction>;

  beforeEach(() => {
    // Reset and re-apply default mock for each test
    serializeSpy.mockReset().mockResolvedValue([
      { path: 'README.md', content: '# Hello' },
    ]);
    action = createGiteaPullRequestAction({ integrations });
  });

  it('should create a branch via contents API and open a pull request', async () => {
    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => {
        return res(ctx.status(404), ctx.text('not found'));
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (req, res, ctx) => {
        expect(req.headers.get('Authorization')).toBe(
          `basic ${Buffer.from('gitea_user:gitea_password').toString('base64')}`,
        );
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ sha: 'abc123' }),
        );
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/pulls', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({
            number: 1,
            html_url: 'https://gitea.com/owner/repo/pulls/1',
          }),
        );
      }),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/test',
        targetBranchName: 'main',
        title: 'Add feature',
        description: 'A test PR',
      },
    });

    await action.handler(mockContext);

    expect(mockContext.output).toHaveBeenCalledWith('pullRequestNumber', 1);
    expect(mockContext.output).toHaveBeenCalledWith(
      'pullRequestUrl',
      'https://gitea.com/owner/repo/pulls/1',
    );
    expect(mockContext.output).toHaveBeenCalledWith(
      'remoteUrl',
      'https://gitea.com/owner/repo/pulls/1',
    );
    const urlOutputs = mockContext.output.mock.calls.filter(
      ([name]) => name === 'remoteUrl' || name === 'pullRequestUrl',
    );
    expect(urlOutputs).toEqual([
      ['remoteUrl', 'https://gitea.com/owner/repo/pulls/1'],
      ['pullRequestUrl', 'https://gitea.com/owner/repo/pulls/1'],
    ]);
    expect(mockContext.output).toHaveBeenCalledWith('branchName', 'feature/test');
    expect(mockContext.output).toHaveBeenCalledWith('targetBranchName', 'main');
  });

  it('should prefer an input token over integration credentials', async () => {
    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => {
        return res(ctx.status(404), ctx.text('not found'));
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (req, res, ctx) => {
        expect(req.headers.get('Authorization')).toBe('token user-token');
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ sha: 'abc123' }),
        );
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/pulls', (req, res, ctx) => {
        expect(req.headers.get('Authorization')).toBe('token user-token');
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ number: 1, html_url: 'https://gitea.com/owner/repo/pulls/1' }),
        );
      }),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/user-token',
        title: 'Use user token',
        token: 'user-token',
      },
    });

    await action.handler(mockContext);
    expect(mockContext.output).toHaveBeenCalledWith('pullRequestNumber', 1);
  });

  it('should use ref and new_branch for new branch creation', async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => {
        return res(ctx.status(404), ctx.text('not found'));
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', async (req, res, ctx) => {
        capturedPayload = await req.json();
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ sha: 'abc123' }),
        );
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/pulls', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ number: 3, html_url: 'https://gitea.com/owner/repo/pulls/3' }),
        );
      }),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/new-branch',
        targetBranchName: 'develop',
        title: 'New branch PR',
      },
    });

    await action.handler(mockContext);

    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.new_branch).toBe('feature/new-branch');
    expect(capturedPayload!.sha).toBeUndefined();
    expect(mockContext.output).toHaveBeenCalledWith('pullRequestNumber', 3);
  });

  it('should create a new branch only once when publishing multiple files', async () => {
    serializeSpy.mockResolvedValue([
      { path: 'README.md', content: '# Hello' },
      { path: 'catalog-info.yaml', content: 'apiVersion: backstage.io/v1alpha1' },
    ]);

    const capturedPayloads: Record<string, unknown>[] = [];
    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => {
        return res(ctx.status(404), ctx.text('not found'));
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', async (req, res, ctx) => {
        capturedPayloads.push(await req.json());
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ sha: 'abc123' }),
        );
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/pulls', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ number: 4, html_url: 'https://gitea.com/owner/repo/pulls/4' }),
        );
      }),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/multiple-files',
        targetBranchName: 'develop',
        title: 'Multiple files',
      },
    });

    await action.handler(mockContext);

    expect(capturedPayloads).toHaveLength(2);
    expect(capturedPayloads[0]).toMatchObject({
      ref: 'develop',
      new_branch: 'feature/multiple-files',
    });
    expect(capturedPayloads[1]).toMatchObject({
      branch: 'feature/multiple-files',
    });
    expect(capturedPayloads[1].ref).toBeUndefined();
    expect(capturedPayloads[1].new_branch).toBeUndefined();
  });

  it('should use existing file sha when updating', async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    let inspectedRef: string | null = null;
    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (req, res, ctx) => {
        inspectedRef = req.url.searchParams.get('ref');
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ sha: 'existing-sha' }),
        );
      }),
      rest.put('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', async (req, res, ctx) => {
        capturedPayload = await req.json();
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ sha: 'new-sha' }),
        );
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/pulls', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ number: 2, html_url: 'https://gitea.com/owner/repo/pulls/2' }),
        );
      }),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/update',
        title: 'Update file',
      },
    });

    await action.handler(mockContext);

    expect(capturedPayload).toBeDefined();
    expect(inspectedRef).toBe('feature/update');
    expect(capturedPayload!.sha).toBe('existing-sha');
    expect(capturedPayload!.branch).toBe('feature/update');
    expect(capturedPayload!.ref).toBeUndefined();
    expect(capturedPayload!.new_branch).toBeUndefined();
    expect(mockContext.output).toHaveBeenCalledWith('pullRequestNumber', 2);
  });

  it('should throw when the repoUrl is missing required fields', async () => {
    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?repo=repo',
        branchName: 'test',
        title: 'Test',
      },
    });

    await expect(action.handler(mockContext)).rejects.toThrow();
  });

  it('should reject a sourcePath outside the workspace', async () => {
    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/path-traversal',
        title: 'Path traversal',
        sourcePath: '../outside',
      },
    });

    await expect(action.handler(mockContext)).rejects.toThrow(
      'sourcePath must be within the scaffolder workspace',
    );
    expect(serializeSpy).not.toHaveBeenCalled();
  });

  it('creates the source branch and deletes files with the Gitea Contents API contract', async () => {
    const calls: string[] = [];
    const deleteBodies: Record<string, unknown>[] = [];
    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/branches/:branch', (req, res, ctx) => {
        calls.push(`GET branch ${req.params.branch}`);
        return res(ctx.status(404), ctx.text('not found'));
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/branches', async (req, res, ctx) => {
        calls.push(`POST branch ${JSON.stringify(await req.json())}`);
        return res(ctx.status(201), ctx.json({ name: 'feature/test' }));
      }),
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (req, res, ctx) => {
        calls.push(`GET content ${req.url.searchParams.get('ref')}`);
        if (req.url.pathname.endsWith('old-file.txt')) return res(ctx.status(200), ctx.json({ sha: 'old-sha' }));
        if (req.url.pathname.endsWith('another-old.txt')) return res(ctx.status(404), ctx.text('not found'));
        return res(ctx.status(404), ctx.text('new file'));
      }),
      rest.delete('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', async (req, res, ctx) => {
        calls.push('DELETE content');
        deleteBodies.push(await req.json());
        return res(ctx.status(204));
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ sha: 'abc123' }),
        );
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/pulls', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({
            number: 1,
            html_url: 'https://gitea.com/owner/repo/pulls/1',
          }),
        );
      }),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/test',
        title: 'Delete and add files',
        commitMessage: 'Apply smoke changes',
        targetBranchName: 'main',
        filesToDelete: ['old-file.txt', 'another-old.txt'],
      },
    });

    await action.handler(mockContext);

    expect(deleteBodies).toEqual([{ branch: 'feature/test', sha: 'old-sha', message: 'Apply smoke changes' }]);
    expect(calls[0]).toBe('GET branch feature/test');
    expect(calls[1]).toContain('POST branch');
    expect(calls[1]).toContain('"new_branch_name":"feature/test"');
    expect(calls[1]).toContain('"old_branch_name":"main"');
    expect(calls.indexOf('DELETE content')).toBeGreaterThan(calls.findIndex(call => call.startsWith('POST branch')));
    expect(mockContext.output).toHaveBeenCalledWith('pullRequestNumber', 1);
  });

  it('fails on non-404 errors while inspecting a deletion', async () => {
    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/branches/:branch', (_req, res, ctx) => res(ctx.status(200), ctx.json({ name: 'feature/delete' }))),
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => res(ctx.status(503), ctx.text('unavailable'))),
    );
    const mockContext = createMockActionContext({ input: {
      repoUrl: 'gitea.com?owner=owner&repo=repo', branchName: 'feature/delete',
      title: 'Delete', filesToDelete: ['old.txt'],
    } });
    await expect(action.handler(mockContext)).rejects.toThrow(
      "Failed to inspect file 'old.txt' for deletion from 'feature/delete'",
    );
  });

  it('fails on non-successful deletion responses', async () => {
    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/branches/:branch', (_req, res, ctx) => res(ctx.status(200), ctx.json({ name: 'feature/delete' }))),
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => res(ctx.status(200), ctx.json({ sha: 'old-sha' }))),
      rest.delete('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => res(ctx.status(500), ctx.text('delete failed'))),
    );
    const mockContext = createMockActionContext({ input: {
      repoUrl: 'gitea.com?owner=owner&repo=repo', branchName: 'feature/delete',
      title: 'Delete', filesToDelete: ['old.txt'],
    } });
    await expect(action.handler(mockContext)).rejects.toThrow(
      "Failed to delete file 'old.txt' from 'feature/delete'",
    );
  });

  it('should request reviewers and assignees on the PR', async () => {
    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => {
        return res(ctx.status(404), ctx.text('not found'));
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ sha: 'abc123' }),
        );
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/pulls', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({
            number: 1,
            index: 1,
            html_url: 'https://gitea.com/owner/repo/pulls/1',
          }),
        );
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/pulls/:id/requests', (_req, res, ctx) => {
        return res(ctx.status(200));
      }),
      rest.patch('https://gitea.com/api/v1/repos/:owner/:repo/issues/:id', (_req, res, ctx) => {
        return res(ctx.status(200));
      }),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/test',
        title: 'With reviewers',
        reviewers: ['alice', 'bob'],
        assignees: ['charlie'],
        teamReviewers: ['team-a'],
      },
    });

    await action.handler(mockContext);

    expect(mockContext.output).toHaveBeenCalledWith('pullRequestNumber', 1);
  });

  it('should update an existing PR when update is true', async () => {
    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => {
        return res(ctx.status(404), ctx.text('not found'));
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ sha: 'abc123' }),
        );
      }),
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/pulls', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json([{ index: 5, title: 'Old title' }]),
        );
      }),
      rest.patch('https://gitea.com/api/v1/repos/:owner/:repo/pulls/:id', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({
            number: 5,
            index: 5,
            html_url: 'https://gitea.com/owner/repo/pulls/5',
            title: 'Updated title',
          }),
        );
      }),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/existing',
        title: 'Updated title',
        description: 'Updated description',
        update: true,
      },
    });

    await action.handler(mockContext);

    expect(mockContext.output).toHaveBeenCalledWith('pullRequestNumber', 5);
  });

  it('should skip PR creation when no files and createWhenEmpty is false', async () => {
    serializeSpy.mockResolvedValue([]);

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/empty',
        title: 'Empty PR',
        createWhenEmpty: false,
      },
    });

    await action.handler(mockContext);

    // Should not have called output since it returned early
    expect(mockContext.output).not.toHaveBeenCalled();
  });

  it('should create PR even with no files when createWhenEmpty is true', async () => {
    serializeSpy.mockResolvedValue([]);

    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/branches/:branch', (_req, res, ctx) => res(ctx.status(404), ctx.text('not found'))),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/branches', (_req, res, ctx) => res(ctx.status(201), ctx.json({ name: 'feature/empty' }))),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/pulls', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({
            number: 1,
            index: 1,
            html_url: 'https://gitea.com/owner/repo/pulls/1',
          }),
        );
      }),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/empty',
        title: 'Empty PR',
        createWhenEmpty: true,
      },
    });

    await action.handler(mockContext);

    expect(mockContext.output).toHaveBeenCalledWith('pullRequestNumber', 1);
  });

  it('should log warning for git author params that are not supported', async () => {
    server.use(
      rest.get('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => {
        return res(ctx.status(404), ctx.text('not found'));
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/contents/*', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({ sha: 'abc123' }),
        );
      }),
      rest.post('https://gitea.com/api/v1/repos/:owner/:repo/pulls', (_req, res, ctx) => {
        return res(
          ctx.status(200),
          ctx.set('Content-Type', 'application/json'),
          ctx.json({
            number: 1,
            index: 1,
            html_url: 'https://gitea.com/owner/repo/pulls/1',
          }),
        );
      }),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/test',
        title: 'With git author',
        gitAuthorName: 'Custom Author',
        gitAuthorEmail: 'custom@example.com',
        forceEmptyGitAuthor: true,
      },
    });

    const warnSpy = jest.spyOn(mockContext.logger, 'warn').mockImplementation(() => {});
    await action.handler(mockContext);

    expect(warnSpy).toHaveBeenCalledWith(
      'gitAuthorName, gitAuthorEmail, and forceEmptyGitAuthor are not supported by Gitea Contents API and will be ignored',
    );
    expect(mockContext.output).toHaveBeenCalledWith('pullRequestNumber', 1);
  });
});
