/*
 * Copyright 2025 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { ConfigReader } from '@backstage/config';
import { registerMswTestHooks } from '@backstage/backend-test-utils';
import { ScmIntegrations } from '@backstage/integration';
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { rest } from 'msw';
import { setupServer } from 'msw/node';

jest.mock('@backstage/plugin-scaffolder-node', () => {
  const actual = jest.requireActual('@backstage/plugin-scaffolder-node');
  return { ...actual, serializeDirectoryContents: jest.fn() };
});

import * as scaffolderNode from '@backstage/plugin-scaffolder-node';
import { createGiteaPullRequestAction } from './giteaPullRequest';

const serializeSpy = scaffolderNode.serializeDirectoryContents as jest.Mock;

describe('publish:gitea:pull-request', () => {
  const integrations = ScmIntegrations.fromConfig(
    new ConfigReader({
      integrations: {
        gitea: [
          {
            host: 'gitea.com',
            username: 'gitea_user',
            password: 'gitea_password',
          },
        ],
      },
    }),
  );
  const server = setupServer();
  registerMswTestHooks(server);

  beforeEach(() => {
    serializeSpy.mockReset().mockResolvedValue([
      { path: 'README.md', content: Buffer.from('# Hello') },
      { path: 'nested/data.bin', content: Buffer.from([0, 1, 255]) },
    ]);
  });

  function context(input: Record<string, unknown> = {}) {
    return createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'feature/test',
        targetBranchName: 'main',
        title: 'Add feature',
        ...input,
      },
    });
  }

  function mockPullRequest() {
    server.use(
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/pulls',
        (_req, res, ctx) =>
          res(
            ctx.status(201),
            ctx.json({
              number: 7,
              index: 7,
              html_url: 'https://gitea.com/owner/repo/pulls/7',
            }),
          ),
      ),
    );
  }

  it('commits multiple rendered files in one batch on a new branch', async () => {
    let batchCalls = 0;
    let payload: any;
    server.use(
      rest.get(
        'https://gitea.com/api/v1/repos/:owner/:repo/branches/:branch',
        (req, res, ctx) =>
          req.params.branch === 'feature/test'
            ? res(ctx.status(404))
            : res(ctx.json({ commit: { id: 'base-commit' } })),
      ),
      rest.get(
        'https://gitea.com/api/v1/repos/:owner/:repo/git/trees/:sha',
        (_req, res, ctx) => res(ctx.json({ sha: 'base-tree', tree: [] })),
      ),
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/contents',
        async (req, res, ctx) => {
          batchCalls += 1;
          payload = await req.json();
          expect(req.headers.get('Authorization')).toBe(
            `basic ${Buffer.from('gitea_user:gitea_password').toString('base64')}`,
          );
          return res(ctx.status(201), ctx.json({ commit: { sha: 'new' } }));
        },
      ),
    );
    mockPullRequest();

    const ctx = context({ targetPath: 'catalog' });
    await createGiteaPullRequestAction({ integrations }).handler(ctx);

    expect(batchCalls).toBe(1);
    expect(payload).toEqual({
      branch: 'main',
      new_branch: 'feature/test',
      message: 'Add feature',
      files: [
        {
          operation: 'create',
          path: 'catalog/README.md',
          content: Buffer.from('# Hello').toString('base64'),
        },
        {
          operation: 'create',
          path: 'catalog/nested/data.bin',
          content: Buffer.from([0, 1, 255]).toString('base64'),
        },
      ],
    });
    expect(ctx.output).toHaveBeenCalledWith('pullRequestNumber', 7);
    expect(ctx.output).toHaveBeenCalledWith(
      'remoteUrl',
      'https://gitea.com/owner/repo/pulls/7',
    );
  });

  it('combines creates, updates, and deletes using tree blob SHAs', async () => {
    let payload: any;
    server.use(
      rest.get(
        'https://gitea.com/api/v1/repos/:owner/:repo/branches/:branch',
        (_req, res, ctx) =>
          res(ctx.json({ name: 'feature/test', commit: { id: 'head' } })),
      ),
      rest.get(
        'https://gitea.com/api/v1/repos/:owner/:repo/git/trees/:sha',
        (_req, res, ctx) =>
          res(
            ctx.json({
              tree: [
                { path: 'README.md', type: 'blob', sha: 'readme-sha' },
                { path: 'old.txt', type: 'blob', sha: 'old-sha' },
              ],
            }),
          ),
      ),
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/contents',
        async (req, res, ctx) => {
          payload = await req.json();
          return res(ctx.status(201), ctx.json({}));
        },
      ),
    );
    mockPullRequest();

    await createGiteaPullRequestAction({ integrations }).handler(
      context({ filesToDelete: ['old.txt', 'already-absent.txt'] }),
    );

    expect(payload.branch).toBe('feature/test');
    expect(payload.new_branch).toBeUndefined();
    expect(payload.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'update',
          path: 'README.md',
          sha: 'readme-sha',
        }),
        expect.objectContaining({
          operation: 'create',
          path: 'nested/data.bin',
        }),
        {
          operation: 'delete',
          path: 'old.txt',
          sha: 'old-sha',
        },
      ]),
    );
  });

  it('rejects a rendered-file/delete conflict without a mutation', async () => {
    let batchCalls = 0;
    server.use(
      rest.get(
        'https://gitea.com/api/v1/repos/:owner/:repo/branches/:branch',
        (_req, res, ctx) => res(ctx.json({ commit: { id: 'head' } })),
      ),
      rest.get(
        'https://gitea.com/api/v1/repos/:owner/:repo/git/trees/:sha',
        (_req, res, ctx) => res(ctx.json({ tree: [] })),
      ),
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/contents',
        (_req, res, ctx) => {
          batchCalls += 1;
          return res(ctx.status(201), ctx.json({}));
        },
      ),
    );

    await expect(
      createGiteaPullRequestAction({ integrations }).handler(
        context({ filesToDelete: ['README.md'] }),
      ),
    ).rejects.toThrow(
      "Conflicting create/update and delete operations for 'README.md'",
    );
    expect(batchCalls).toBe(0);
  });

  it('skips an empty change when createWhenEmpty is false', async () => {
    serializeSpy.mockResolvedValue([]);
    const ctx = context({ createWhenEmpty: false });
    await createGiteaPullRequestAction({ integrations }).handler(ctx);
    expect(ctx.output).not.toHaveBeenCalled();
  });

  it('creates only a branch and PR for an allowed empty change', async () => {
    serializeSpy.mockResolvedValue([]);
    let branchCreates = 0;
    server.use(
      rest.get(
        'https://gitea.com/api/v1/repos/:owner/:repo/branches/:branch',
        (_req, res, ctx) => res(ctx.status(404)),
      ),
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/branches',
        (_req, res, ctx) => {
          branchCreates += 1;
          return res(ctx.status(201), ctx.json({}));
        },
      ),
    );
    mockPullRequest();

    const ctx = context({ createWhenEmpty: true });
    await createGiteaPullRequestAction({ integrations }).handler(ctx);
    expect(branchCreates).toBe(1);
    expect(ctx.output).toHaveBeenCalledWith('pullRequestNumber', 7);
  });

  it('preserves update mode for an existing open pull request', async () => {
    let updatedBody: any;
    server.use(
      rest.get(
        'https://gitea.com/api/v1/repos/:owner/:repo/branches/:branch',
        (_req, res, ctx) => res(ctx.json({ commit: { id: 'head' } })),
      ),
      rest.get(
        'https://gitea.com/api/v1/repos/:owner/:repo/git/trees/:sha',
        (_req, res, ctx) => res(ctx.json({ tree: [] })),
      ),
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/contents',
        (_req, res, ctx) => res(ctx.status(201), ctx.json({})),
      ),
      rest.get(
        'https://gitea.com/api/v1/repos/:owner/:repo/pulls',
        (_req, res, ctx) => res(ctx.json([{ index: 12 }])),
      ),
      rest.patch(
        'https://gitea.com/api/v1/repos/:owner/:repo/pulls/12',
        async (req, res, ctx) => {
          updatedBody = await req.json();
          return res(
            ctx.json({
              index: 12,
              html_url: 'https://gitea.com/owner/repo/pulls/12',
            }),
          );
        },
      ),
    );

    const ctx = context({
      update: true,
      title: 'Updated title',
      description: 'Updated body',
    });
    await createGiteaPullRequestAction({ integrations }).handler(ctx);

    expect(updatedBody).toEqual({
      title: 'Updated title',
      body: 'Updated body',
    });
    expect(ctx.output).toHaveBeenCalledWith('pullRequestNumber', 12);
  });
});
