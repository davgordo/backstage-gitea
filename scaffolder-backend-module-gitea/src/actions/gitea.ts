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

import { InputError } from '@backstage/errors';
import { Config } from '@backstage/config';
import {
  getGiteaRequestOptions,
  GiteaIntegrationConfig,
  ScmIntegrationRegistry,
} from '@backstage/integration';
import {
  ActionContext,
  createTemplateAction,
  getRepoSourceDirectory,
  initRepoAndPush,
  parseRepoUrl,
} from '@backstage/plugin-scaffolder-node';
import { examples } from './gitea.examples';
import { applyBranchProtection, BranchProtectionOptions } from './giteaBranchProtection';
import { GiteaClient, resolveGiteaRepo } from './giteaClient';
import crypto from 'node:crypto';

const checkGiteaContentUrl = async (
  config: GiteaIntegrationConfig,
  options: {
    owner?: string;
    repo: string;
    defaultBranch?: string;
  },
): Promise<Response> => {
  const { owner, repo, defaultBranch } = options;
  let response: Response;
  const getOptions: RequestInit = {
    method: 'GET',
  };

  try {
    response = await fetch(
      `${config.baseUrl}/${owner}/${repo}/src/branch/${defaultBranch}`,
      getOptions,
    );
  } catch (e) {
    throw new Error(
      `Unable to get the repository: ${owner}/${repo} metadata , ${e}`,
    );
  }
  return response;
};

function buildAuthHeaders(config: GiteaIntegrationConfig, token?: string): Record<string, string> {
  if (token) {
    return {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json',
    };
  }
  return {
    ...getGiteaRequestOptions(config).headers,
    'Content-Type': 'application/json',
  };
}

const checkGiteaOrg = async (
  config: GiteaIntegrationConfig,
  options: {
    owner: string;
    token?: string;
  },
): Promise<void> => {
  const { owner, token } = options;
  let response: Response;
  // check first if the org = owner exists
  const getOptions: RequestInit = {
    method: 'GET',
    headers: buildAuthHeaders(config, token),
  };
  try {
    response = await fetch(
      `${config.baseUrl}/api/v1/orgs/${owner}`,
      getOptions,
    );
  } catch (e) {
    throw new Error(
      `Unable to get the Organization: ${owner}; Error cause: ${e.message}, code: ${e.cause.code}`,
    );
  }
  if (response.status !== 200) {
    throw new Error(
      `Organization ${owner} do not exist. Please create it first !`,
    );
  }
};

const createGiteaProject = async (
  config: GiteaIntegrationConfig,
  options: {
    projectName: string;
    owner?: string;
    repoVisibility?: string;
    description: string;
    token?: string;
  },
): Promise<void> => {
  const { projectName, description, owner, repoVisibility, token } = options;

  /*
    Several options exist to create a repository using either the user or organisation
    User: https://gitea.com/api/swagger#/user/createCurrentUserRepo
    Api: URL/api/v1/user/repos
    Remark: The user is the username defined part of the backstage integration config for the gitea URL !

    Org: https://gitea.com/api/swagger#/organization/createOrgRepo
    Api: URL/api/v1/orgs/${org_owner}/repos
    This is the default scenario that we support currently
  */
  let response: Response;
  let isPrivate: boolean;

  if (repoVisibility === 'private') {
    isPrivate = true;
  } else if (repoVisibility === 'public') {
    isPrivate = false;
  } else {
    // Provide a default value if repoVisibility is neither "private" nor "public"
    isPrivate = false;
  }

  const postOptions: RequestInit = {
    method: 'POST',
    body: JSON.stringify({
      name: projectName,
      description,
      private: isPrivate,
    }),
    headers: buildAuthHeaders(config, token),
  };
  try {
    response = await fetch(
      `${config.baseUrl}/api/v1/orgs/${owner}/repos`,
      postOptions,
    );
  } catch (e) {
    throw new Error(`Unable to create repository, ${e}`);
  }
  if (response.status !== 201) {
    throw new Error(
      `Unable to create repository, ${response.status} ${
        response.statusText
      }, ${await response.text()}`,
    );
  }
};

const generateCommitMessage = (
  config: Config,
  commitSubject?: string,
): string => {
  const changeId = crypto.randomBytes(20).toString('hex');
  const msg = `${
    config.getOptionalString('scaffolder.defaultCommitMessage') || commitSubject
  }\n\nChange-Id: I${changeId}`;
  return msg;
};

async function checkAvailabilityGiteaRepository(
  maxDuration: number,
  integrationConfig: GiteaIntegrationConfig,
  options: {
    owner?: string;
    repo: string;
    defaultBranch: string;
    ctx: ActionContext<any, any, any>;
  },
) {
  const startTimestamp = Date.now();

  const { owner, repo, defaultBranch, ctx } = options;
  const sleep = (ms: number | undefined) => new Promise(r => setTimeout(r, ms));
  let response: Response;

  while (Date.now() - startTimestamp < maxDuration) {
    if (ctx.signal?.aborted) return;

    response = await checkGiteaContentUrl(integrationConfig, {
      owner,
      repo,
      defaultBranch,
    });

    if (response.status !== 200) {
      // Repository is not yet available/accessible ...
      await sleep(1000);
    } else {
      // Gitea repository exists !
      break;
    }
  }
}

/**
 * Creates a new action that initializes a git repository using the content of the workspace.
 * and publishes it to a Gitea instance.
 * @public
 */
export function createPublishGiteaAction(options: {
  integrations: ScmIntegrationRegistry;
  config: Config;
}) {
  const { integrations, config } = options;

  return createTemplateAction({
    id: 'publish:gitea',
    description:
      'Initializes a git repository using the content of the workspace, and publishes it to Gitea.',
    examples,
    schema: {
      input: {
        repoUrl: z =>
          z.string({
            description: 'Repository Location',
          }),
        description: z =>
          z.string({
            description: 'Repository Description',
          }),
        defaultBranch: z =>
          z
            .string({
              description: `Sets the default branch on the repository. The default value is 'main'`,
            })
            .optional(),
        repoVisibility: z =>
          z
            .enum(['private', 'public'], {
              description: `Sets the visibility of the repository. The default value is 'public'.`,
            })
            .optional(),
        gitCommitMessage: z =>
          z
            .string({
              description: `Sets the commit message on the repository. The default value is 'initial commit'`,
            })
            .optional(),
        gitAuthorName: z =>
          z
            .string({
              description: `Sets the default author name for the commit. The default value is 'Scaffolder'`,
            })
            .optional(),
        gitAuthorEmail: z =>
          z
            .string({
              description: `Sets the default author email for the commit.`,
            })
            .optional(),
        sourcePath: z =>
          z
            .string({
              description: `Path within the workspace that will be used as the repository root. If omitted, the entire workspace will be published as the repository.`,
            })
            .optional(),
        signCommit: z =>
          z
            .boolean({
              description: 'Sign commit with configured PGP private key',
            })
            .optional(),
        token: z =>
          z
            .string({
              description: 'A Gitea authentication token to use for API and git operations. When provided, it overrides the integration credentials.',
            })
            .optional(),

        // Branch protection inputs (GitHub parity)
        protectDefaultBranch: z =>
          z
            .boolean({
              description: `Enables branch protection on the default branch. The default value is 'true'.`,
            })
            .optional(),
        protectEnforceAdmins: z =>
          z
            .boolean({
              description: `Enforce branch protection for administrators. The default value is 'true'.`,
            })
            .optional(),
        requireCodeOwnerReviews: z =>
          z
            .boolean({
              description: `Require review from code owners. The default value is 'false'.`,
            })
            .optional(),
        dismissStaleReviews: z =>
          z
            .boolean({
              description: `Dismiss stale reviews on push. The default value is 'false'.`,
            })
            .optional(),
        requiredApprovingReviewCount: z =>
          z
            .number({
              description: `Required number of approving reviews. The default value is 1.`,
            })
            .optional(),
        requiredStatusCheckContexts: z =>
          z
            .array(z.string())
            .describe('List of required status check contexts.')
            .optional(),
        requireBranchesToBeUpToDate: z =>
          z
            .boolean({
              description: `Require branches to be up to date before merging. The default value is 'true'.`,
            })
            .optional(),
        requiredCommitSigning: z =>
          z
            .boolean({
              description: `Require signed commits. The default value is 'false'.`,
            })
            .optional(),
        bypassPullRequestAllowances: z =>
          z
            .object({
              users: z.array(z.string()).optional(),
              teams: z.array(z.string()).optional(),
            })
            .describe('Accounts/teams that can bypass required pull requests. (Not supported by Gitea, accepted for API parity)')
            .optional(),
        restrictions: z =>
          z
            .object({
              users: z.array(z.string()).optional(),
              teams: z.array(z.string()).optional(),
            })
            .describe('Accounts/teams that can push to the protected branch. (Not supported by Gitea, accepted for API parity)')
            .optional(),
        requiredConversationResolution: z =>
          z
            .boolean({
              description: `Require all conversation threads to be resolved before merging. (Not supported by Gitea, accepted for API parity)`,
            })
            .optional(),
        requireLastPushApproval: z =>
          z
            .boolean({
              description: `Require that the last push to the branch is approved. (Not supported by Gitea, accepted for API parity)`,
            })
            .optional(),
        requiredLinearHistory: z =>
          z
            .boolean({
              description: `Require linear history (no merge commits). (Not supported by Gitea, accepted for API parity)`,
            })
            .optional(),
      },
      output: {
        remoteUrl: z =>
          z
            .string({
              description: 'A URL to the repository with the provider',
            })
            .optional(),
        repoContentsUrl: z =>
          z
            .string({
              description: 'A URL to the root of the repository',
            })
            .optional(),
        commitHash: z =>
          z
            .string({
              description: 'The git commit hash of the initial commit',
            })
            .optional(),
      },
    },
    async handler(ctx) {
      const {
        repoUrl,
        description,
        defaultBranch = 'main',
        repoVisibility = 'public',
        gitAuthorName,
        gitAuthorEmail,
        gitCommitMessage = 'initial commit',
        sourcePath,
        signCommit,
        token,
        protectDefaultBranch = true,
        protectEnforceAdmins = true,
        requireCodeOwnerReviews = false,
        dismissStaleReviews = false,
        requiredApprovingReviewCount = 1,
        requiredStatusCheckContexts = [],
        requireBranchesToBeUpToDate = true,
        requiredCommitSigning = false,
        bypassPullRequestAllowances,
        restrictions,
        requiredConversationResolution = false,
        requireLastPushApproval = false,
        requiredLinearHistory = false,
      } = ctx.input;

      const { repo, host, owner } = parseRepoUrl(repoUrl, integrations as any);

      const integrationConfig = integrations.gitea.byHost(host);
      if (!integrationConfig) {
        throw new InputError(
          `No matching integration configuration for host ${host}, please check your integrations config`,
        );
      }
      const { username, password } = integrationConfig.config;

      // If a token is not provided, fall back to integration credentials
      if (!token && (!username || !password)) {
        throw new Error(`Credentials for the gitea ${host} required.`);
      }

      // check if the org exists within the gitea server
      if (owner) {
        await checkGiteaOrg(integrationConfig.config, { owner, token });
      }

      await createGiteaProject(integrationConfig.config, {
        description,
        repoVisibility,
        owner: owner,
        projectName: repo,
        token,
      });

      const auth = {
        username: (token ? '' : username)!,
        password: (token || password)!,
      };
      const gitAuthorInfo = {
        name: gitAuthorName
          ? gitAuthorName
          : config.getOptionalString('scaffolder.defaultAuthor.name'),
        email: gitAuthorEmail
          ? gitAuthorEmail
          : config.getOptionalString('scaffolder.defaultAuthor.email'),
      };

      const signingKey =
        integrationConfig.config.commitSigningKey ??
        config.getOptionalString('scaffolder.defaultCommitSigningKey');
      if (signCommit && !signingKey) {
        throw new Error(
          'Signing commits is enabled but no signing key is provided in the configuration',
        );
      }

      // The owner to be used should be either the org name or user authenticated with the gitea server
      const remoteUrl = `${integrationConfig.config.baseUrl}/${owner}/${repo}.git`;
      const commitResult = await initRepoAndPush({
        dir: getRepoSourceDirectory(ctx.workspacePath, sourcePath),
        remoteUrl,
        auth,
        defaultBranch,
        logger: ctx.logger,
        commitMessage: generateCommitMessage(config, gitCommitMessage),
        gitAuthorInfo,
      });

      // Check if the gitea repo URL is available before to exit
      const maxDuration = 20000; // 20 seconds
      await checkAvailabilityGiteaRepository(
        maxDuration,
        integrationConfig.config,
        {
          owner,
          repo,
          defaultBranch,
          ctx,
        },
      );

      // Apply branch protection - defaults to enabled (matching GitHub behavior)
      if (protectDefaultBranch !== false) {
        const repoData = resolveGiteaRepo({ repoUrl, integrations });
        const client = new GiteaClient({ repo: repoData, token: token || password });

        const protectionOptions: BranchProtectionOptions = {
          repoUrl,
          branchName: defaultBranch,
          token: token || password,
          protectDefaultBranch,
          protectEnforceAdmins,
          enforceAdmins: protectEnforceAdmins,
          requireCodeOwnerReviews,
          dismissStaleReviews,
          requiredApprovingReviewCount,
          requiredStatusCheckContexts,
          requireBranchesToBeUpToDate,
          requiredCommitSigning,
          bypassPullRequestAllowances,
          restrictions,
          requiredConversationResolution,
          requireLastPushApproval,
          requiredLinearHistory,
        };

        await applyBranchProtection(client, protectionOptions, ctx.logger);
      }

      const repoContentsUrl = `${integrationConfig.config.baseUrl}/${owner}/${repo}/src/branch/${defaultBranch}/`;
      ctx.output('remoteUrl', remoteUrl);
      ctx.output('commitHash', commitResult?.commitHash);
      ctx.output('repoContentsUrl', repoContentsUrl);
    },
  });
}
