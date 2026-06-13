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
import { createGiteaBranchProtectionAction } from './giteaBranchProtection';
import { rest } from 'msw';
import { registerMswTestHooks } from '@backstage/backend-test-utils';
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { setupServer } from 'msw/node';

describe('gitea:branch-protection:create', () => {
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
  const action = createGiteaBranchProtectionAction({ integrations });

  const server = setupServer();
  registerMswTestHooks(server);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('should apply branch protection and return the branch name', async () => {
    server.use(
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/branch_protections',
        (req, res, ctx) => {
          expect(req.headers.get('Authorization')).toBe(
            `basic ${Buffer.from('gitea_user:gitea_password').toString('base64')}`,
          );
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({ branch_name: 'main' }),
          );
        },
      ),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'main',
        requiredApprovingReviewCount: 2,
        requiredStatusCheckContexts: ['ci/build'],
      },
    });

    await action.handler(mockContext);

    expect(mockContext.output).toHaveBeenCalledWith('branchName', 'main');
  });

  it('should skip branch protection when protectDefaultBranch is false', async () => {
    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'main',
        protectDefaultBranch: false,
      },
    });

    await action.handler(mockContext);

    // Should not call output since it returns early
    expect(mockContext.output).not.toHaveBeenCalled();
  });

  it('should include admin enforcement when protectEnforceAdmins is true', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/branch_protections',
        async (req, res, ctx) => {
          capturedBody = await req.json();
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({ branch_name: 'main' }),
          );
        },
      ),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'main',
        protectEnforceAdmins: true,
        requiredApprovingReviewCount: 2,
        requiredStatusCheckContexts: ['ci/build'],
      },
    });

    await action.handler(mockContext);

    expect(capturedBody).toBeDefined();
    expect(capturedBody!.apply_to_admins).toBe(true);
    expect(capturedBody!.required_approvals).toBe(2);
    expect(capturedBody!.enable_status_check).toBe(true);
    expect(capturedBody!.status_check_contexts).toEqual(['ci/build']);
    expect(capturedBody!.enable_push).toBe(false);
    expect(mockContext.output).toHaveBeenCalledWith('branchName', 'main');
  });

  it('should throw when the repoUrl is missing required fields', async () => {
    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?repo=repo',
        branchName: 'main',
      },
    });

    await expect(action.handler(mockContext)).rejects.toThrow();
  });

  it('should support required commit signing', async () => {
    server.use(
      rest.post(
        'https://gitea.com/api/v1/repos/:owner/:repo/branch_protections',
        (_req, res, ctx) => {
          return res(
            ctx.status(200),
            ctx.set('Content-Type', 'application/json'),
            ctx.json({ branch_name: 'main' }),
          );
        },
      ),
    );

    const mockContext = createMockActionContext({
      input: {
        repoUrl: 'gitea.com?owner=owner&repo=repo',
        branchName: 'main',
        requiredCommitSigning: true,
      },
    });

    await action.handler(mockContext);
    expect(mockContext.output).toHaveBeenCalledWith('branchName', 'main');
  });

  afterEach(() => {
    jest.resetAllMocks();
  });
});
