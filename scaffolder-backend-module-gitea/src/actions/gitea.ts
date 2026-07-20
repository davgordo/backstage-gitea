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
import {
  GiteaApiError,
  GiteaClient,
  GiteaPermission,
  GiteaRepo,
  GiteaTeam,
  resolveGiteaRepo,
} from './giteaClient';
import crypto from 'node:crypto';

type GiteaCollaborator =
  | {
      user: string;
      access: string;
    }
  | {
      team: string;
      access: string;
    };

type GiteaOrganization = {
  id: number;
  name?: string;
  username?: string;
};

const permissionMap: Record<string, GiteaPermission> = {
  pull: 'read',
  triage: 'read',
  read: 'read',
  push: 'write',
  maintain: 'write',
  write: 'write',
  admin: 'admin',
};

const CONTENTS_READINESS_RETRY_MS = 250;
const CONTENTS_READINESS_TIMEOUT_MS = 5_000;

function readinessError(options: {
  repo: GiteaRepo;
  branch: string;
  expectedCommit: string;
  stage: string;
  endpoint: string;
  probePath?: string;
  finalError: unknown;
  timedOut: boolean;
}): Error {
  const {
    repo,
    branch,
    expectedCommit,
    stage,
    endpoint,
    probePath,
    finalError,
    timedOut,
  } = options;
  let reason: string;
  if (finalError instanceof GiteaApiError) {
    reason = `HTTP ${finalError.status}: ${finalError.message}`;
  } else if (finalError instanceof Error) {
    reason = finalError.message;
  } else {
    reason = String(finalError);
  }
  return new Error(
    `Gitea repository contents readiness ${timedOut ? 'timed out' : 'failed'} for ` +
      `${repo.owner}/${repo.repo} branch '${branch}', expected commit '${expectedCommit}', ` +
      `stage '${stage}'${probePath ? `, probe path '${probePath}'` : ''}, endpoint ${endpoint}, after a maximum of ` +
      `${CONTENTS_READINESS_TIMEOUT_MS}ms; final error: ${reason}`,
  );
}

class GiteaReadinessStateError extends Error {}

async function waitForRetry(signal?: AbortSignal, delay = CONTENTS_READINESS_RETRY_MS) {
  if (signal?.aborted) {
    throw new Error('Gitea repository contents readiness check was cancelled');
  }
  await new Promise<void>((resolve, reject) => {
    const state: { timer?: ReturnType<typeof setTimeout> } = {};
    const onAbort = () => {
      if (state.timer) clearTimeout(state.timer);
      reject(new Error('Gitea repository contents readiness check was cancelled'));
    };
    state.timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitForGiteaRepositoryContents(options: {
  client: GiteaClient;
  repo: GiteaRepo;
  branch: string;
  expectedCommit: string;
  signal?: AbortSignal;
  logger: { info(message: string): void };
}): Promise<void> {
  const { client, repo, branch, expectedCommit, signal } = options;
  const repoApiPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const deadline = Date.now() + CONTENTS_READINESS_TIMEOUT_MS;
  let finalError: unknown;
  let stage = 'branch';
  let probePath: string | undefined;
  let endpoint = `${repo.apiBaseUrl}${repoApiPath}/branches/${encodeURIComponent(branch)}`;

  for (;;) {
    if (signal?.aborted) {
      throw new Error(
        `Gitea repository contents readiness check was cancelled for ${repo.owner}/${repo.repo} branch '${branch}', expected commit '${expectedCommit}', stage '${stage}' at ${endpoint}`,
      );
    }
    try {
      stage = 'branch';
      probePath = undefined;
      endpoint = `${repo.apiBaseUrl}${repoApiPath}/branches/${encodeURIComponent(branch)}`;
      const branchResponse = await client.getBranch(branch, signal);
      const observedCommit =
        branchResponse.commit?.id ?? branchResponse.commit?.sha;
      if (!observedCommit) {
        throw new GiteaReadinessStateError(
          `branch did not return a commit SHA; expected '${expectedCommit}'`,
        );
      }
      if (observedCommit !== expectedCommit) {
        throw new GiteaReadinessStateError(
          `branch resolved to commit '${observedCommit}'; expected '${expectedCommit}'`,
        );
      }

      stage = 'tree';
      endpoint = `${repo.apiBaseUrl}${repoApiPath}/git/trees/${encodeURIComponent(expectedCommit)}?recursive=true`;
      const tree = await client.getRecursiveTree(expectedCommit, signal);
      probePath = (tree.tree ?? [])
        .filter(entry => entry.type === 'blob' && Boolean(entry.path))
        .map(entry => entry.path!)
        .sort()[0];
      if (!probePath) {
        if (tree.truncated) {
          throw new GiteaReadinessStateError(
            'recursive tree was truncated and contained no usable blob path',
          );
        }
        return;
      }

      stage = 'file contents';
      const encodedProbePath = probePath
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/');
      endpoint = `${repo.apiBaseUrl}${repoApiPath}/contents/${encodedProbePath}?ref=${encodeURIComponent(branch)}`;
      await client.getContents(probePath, branch, signal);
      return;
    } catch (error) {
      finalError = error;
      if (signal?.aborted) {
        throw new Error(
          `Gitea repository contents readiness check was cancelled for ${repo.owner}/${repo.repo} branch '${branch}', expected commit '${expectedCommit}', stage '${stage}' at ${endpoint}`,
        );
      }
      if (
        error instanceof GiteaApiError &&
        error.status !== 404 &&
        error.status !== 500
      ) {
        throw readinessError({
          repo,
          branch,
          expectedCommit,
          stage,
          endpoint,
          probePath,
          finalError: error,
          timedOut: false,
        });
      }
      if (
        !(error instanceof GiteaApiError) &&
        !(error instanceof TypeError) &&
        !(error instanceof GiteaReadinessStateError)
      ) {
        throw readinessError({
          repo,
          branch,
          expectedCommit,
          stage,
          endpoint,
          probePath,
          finalError: error,
          timedOut: false,
        });
      }
      if (Date.now() >= deadline) {
        throw readinessError({
          repo,
          branch,
          expectedCommit,
          stage,
          endpoint,
          probePath,
          finalError,
          timedOut: true,
        });
      }
      await waitForRetry(
        signal,
        Math.min(CONTENTS_READINESS_RETRY_MS, deadline - Date.now()),
      );
    }
  }
}

function normalizeGiteaPermission(permission: string): GiteaPermission {
  const normalized = permissionMap[permission.toLowerCase()];
  if (!normalized) {
    throw new InputError(
      `Unsupported repository access permission '${permission}'. Expected one of: pull, push, triage, maintain, admin, read, write`,
    );
  }
  return normalized;
}

function isTeamAccess(access?: string): boolean {
  return Boolean(access?.includes('/'));
}

function hasTeamProvisioning(
  access: string | undefined,
  collaborators: GiteaCollaborator[] | undefined,
): boolean {
  return isTeamAccess(access) || Boolean(collaborators?.some(c => 'team' in c));
}

function findGiteaTeam(teams: GiteaTeam[], teamNameOrSlug: string): GiteaTeam | undefined {
  const normalized = teamNameOrSlug.toLowerCase();
  return teams.find(team => {
    return (
      team.name.toLowerCase() === normalized ||
      team.slug?.toLowerCase() === normalized
    );
  });
}

async function getGiteaOrganization(
  config: GiteaIntegrationConfig,
  options: {
    owner: string;
    token?: string;
  },
): Promise<GiteaOrganization | undefined> {
  const { owner, token } = options;
  let response: Response;
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

  if (response.status === 404) {
    return undefined;
  }

  if (response.status !== 200) {
    throw new Error(
      `Organization ${owner} do not exist. Please create it first !`,
    );
  }

  return (await response.json()) as GiteaOrganization;
}

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
  const organization = await getGiteaOrganization(config, options);
  if (!organization) {
    throw new Error(
      `Organization ${options.owner} do not exist. Please create it first !`,
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

async function addTeamAccess(options: {
  client: GiteaClient;
  owner: string;
  repo: string;
  team: string;
  requestedAccess: string;
  permission: GiteaPermission;
  operation: string;
}): Promise<void> {
  const { client, owner, repo, team, requestedAccess, permission, operation } = options;
  let teams: GiteaTeam[];
  try {
    teams = await client.listOrganizationTeams(owner);
  } catch (e) {
    throw new Error(
      `Failed to apply ${operation} for repository ${owner}/${repo}: could not list organization teams while resolving team '${team}' with requested permission '${requestedAccess}' (${permission}), ${e.message}`,
    );
  }
  const giteaTeam = findGiteaTeam(teams, team);

  if (!giteaTeam) {
    throw new InputError(
      `Failed to apply ${operation} for repository ${owner}/${repo}: team '${team}' with requested permission '${requestedAccess}' does not exist in organization '${owner}'`,
    );
  }

  try {
    await client.updateTeamPermission(giteaTeam.id, permission);
  } catch (e) {
    throw new Error(
      `Failed to apply ${operation} for repository ${owner}/${repo}: could not update team '${team}' to requested permission '${requestedAccess}' (${permission}), ${e.message}`,
    );
  }

  try {
    await client.attachRepositoryToTeam(owner, giteaTeam.id);
  } catch (e) {
    throw new Error(
      `Failed to apply ${operation} for repository ${owner}/${repo}: could not attach team '${team}' with requested permission '${requestedAccess}' (${permission}), ${e.message}`,
    );
  }
}

async function provisionRepositoryAccess(options: {
  client: GiteaClient;
  owner: string;
  repo: string;
  ownerIsOrganization: boolean;
  access?: string;
  collaborators?: GiteaCollaborator[];
}): Promise<void> {
  const { client, owner, repo, ownerIsOrganization, access, collaborators } = options;

  if (isTeamAccess(access)) {
    const [organization, team] = access!.split('/', 2);
    if (organization.toLowerCase() !== owner.toLowerCase()) {
      throw new InputError(
        `Failed to apply access for repository ${owner}/${repo}: team '${access}' must belong to repository owner organization '${owner}'`,
      );
    }
    if (!ownerIsOrganization) {
      throw new InputError(
        `Failed to apply access for repository ${owner}/${repo}: team '${access}' requires repository owner '${owner}' to be an organization`,
      );
    }
    await addTeamAccess({
      client,
      owner,
      repo,
      team,
      requestedAccess: 'admin',
      permission: 'admin',
      operation: 'access',
    });
  } else if (access && access.toLowerCase() !== owner.toLowerCase()) {
    try {
      await client.addRepositoryCollaborator(access, 'admin');
    } catch (e) {
      throw new Error(
        `Failed to apply access for repository ${owner}/${repo}: could not add user '${access}' with requested permission 'admin', ${e.message}`,
      );
    }
  }

  for (const collaborator of collaborators ?? []) {
    const permission = normalizeGiteaPermission(collaborator.access);
    if ('user' in collaborator) {
      try {
        await client.addRepositoryCollaborator(collaborator.user, permission);
      } catch (e) {
        throw new Error(
          `Failed to apply collaborator for repository ${owner}/${repo}: could not add user '${collaborator.user}' with requested permission '${collaborator.access}' (${permission}), ${e.message}`,
        );
      }
    } else {
      if (!ownerIsOrganization) {
        throw new InputError(
          `Failed to apply collaborator for repository ${owner}/${repo}: team '${collaborator.team}' with requested permission '${collaborator.access}' requires repository owner '${owner}' to be an organization`,
        );
      }
      await addTeamAccess({
        client,
        owner,
        repo,
        team: collaborator.team,
        requestedAccess: collaborator.access,
        permission,
        operation: 'collaborator',
      });
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
        access: z =>
          z
            .string({
              description: 'Sets an admin collaborator on the repository. Can either be a user reference different from `owner` in `repoUrl` or team reference, eg. `org/team-name`',
            })
            .optional(),
        collaborators: z =>
          z
            .array(
              z.union([
                z.object({
                  user: z.string({
                    description: 'The name of the user that will be added as a collaborator',
                  }),
                  access: z.string({
                    description: 'The type of access for the user',
                  }),
                }),
                z.object({
                  team: z.string({
                    description: 'The name of the team that will be added as a collaborator',
                  }),
                  access: z.string({
                    description: 'The type of access for the team',
                  }),
                }),
              ]),
              {
                description: 'Provide additional users or teams with permissions',
              },
            )
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
        access,
        collaborators,
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
      const signingKey =
        integrationConfig.config.commitSigningKey ??
        config.getOptionalString('scaffolder.defaultCommitSigningKey');

      // If a token is not provided, fall back to integration credentials
      if (!token && (!username || !password)) {
        throw new Error(`Credentials for the gitea ${host} required.`);
      }
      if (signCommit && !signingKey) {
        throw new Error(
          'Signing commits is enabled but no signing key is provided in the configuration',
        );
      }

      if (!owner) {
        throw new InputError('repoUrl must include owner');
      }

      const ownerOrganization = await getGiteaOrganization(
        integrationConfig.config,
        { owner, token },
      );
      if (!ownerOrganization && hasTeamProvisioning(access, collaborators)) {
        throw new InputError(
          `Cannot assign team access for repository ${owner}/${repo}: repository owner '${owner}' is not an organization`,
        );
      }
      if (!ownerOrganization) {
        await checkGiteaOrg(integrationConfig.config, { owner, token });
      }

      await createGiteaProject(integrationConfig.config, {
        description,
        repoVisibility,
        owner: owner,
        projectName: repo,
        token,
      });

      if (access || collaborators?.length) {
        const repoData = resolveGiteaRepo({ repoUrl, integrations });
        const client = new GiteaClient({ repo: repoData, token: token || password });
        await provisionRepositoryAccess({
          client,
          owner,
          repo,
          ownerIsOrganization: Boolean(ownerOrganization),
          access,
          collaborators,
        });
      }

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
        ...(signCommit ? { signingKey } : {}),
      });
      if (!commitResult?.commitHash) {
        throw new Error(
          `Git push for ${owner}/${repo} branch '${defaultBranch}' did not return a commit hash; repository readiness cannot be verified`,
        );
      }

      const repoData = resolveGiteaRepo({ repoUrl, integrations });
      const authenticatedClient = new GiteaClient({
        repo: repoData,
        token,
        defaultHeaders: getGiteaRequestOptions(integrationConfig.config).headers,
      });
      await waitForGiteaRepositoryContents({
        client: authenticatedClient,
        repo: repoData,
        branch: defaultBranch,
        expectedCommit: commitResult.commitHash,
        signal: ctx.signal,
        logger: ctx.logger,
      });

      // Apply branch protection - defaults to enabled (matching GitHub behavior)
      if (protectDefaultBranch !== false) {
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
