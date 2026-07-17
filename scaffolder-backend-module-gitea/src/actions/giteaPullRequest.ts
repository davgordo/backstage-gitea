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

import * as scaffolderNode from '@backstage/plugin-scaffolder-node';
import { InputError } from '@backstage/errors';
import { ScmIntegrationRegistry } from '@backstage/integration';
import { z } from 'zod';
import path from 'node:path';
import {
  createGiteaClient,
  GiteaApiError,
  GiteaBatchFileOperation,
} from './giteaClient';

export const giteaPullRequestInputSchema = z.object({
  repoUrl: z.string().describe('Target repository URL in Backstage repoUrl format'),
  branchName: z.string().describe('Source branch to create/update'),
  targetBranchName: z.string().default('main').describe('Base branch for the pull request'),
  title: z.string(),
  description: z.string().optional(),
  sourcePath: z.string().default('.').describe('Workspace subdirectory containing files to publish'),
  targetPath: z.string().default('.').describe('Target subdirectory in the repository'),
  commitMessage: z.string().optional(),
  token: z.string().optional().describe('Optional user or task token. When provided, it overrides configured integration credentials.'),
  draft: z.boolean().default(false).describe('Reserved for Gitea versions that support draft PRs'),
  // Additional params for parity with publish:github:pull-request
  filesToDelete: z.array(z.string()).default([]).describe('List of file paths to delete from the target branch'),
  reviewers: z.array(z.string()).default([]).describe('List of user logins to request as reviewers on the PR'),
  assignees: z.array(z.string()).default([]).describe('List of user logins to assign to the PR'),
  teamReviewers: z.array(z.string()).default([]).describe('List of team slugs to request as team reviewers on the PR'),
  update: z.boolean().default(false).describe('If true, update an existing PR instead of creating a new one'),
  createWhenEmpty: z.boolean().default(true).describe('If true, create a PR even if no files exist in the source path'),
  // Git author fields — Gitea Contents API doesn't support custom git authors, these are accepted for API parity
  gitAuthorName: z.string().optional().describe('Reserved for API parity with GitHub (not supported by Gitea Contents API)'),
  gitAuthorEmail: z.string().optional().describe('Reserved for API parity with GitHub (not supported by Gitea Contents API)'),
  forceEmptyGitAuthor: z.boolean().default(false).describe('Reserved for API parity with GitHub (not supported by Gitea Contents API)'),
});
const schema = giteaPullRequestInputSchema;

export const giteaPullRequestOutputSchema = z.object({
  remoteUrl: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  pullRequestNumber: z.number().optional(),
  branchName: z.string().optional(),
  targetBranchName: z.string().optional(),
});

type Input = z.infer<typeof schema>;

type Options = {
  integrations: ScmIntegrationRegistry;
};

function trimSlash(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

function joinRepoPath(targetPath: string, relativePath: string): string {
  const target = trimSlash(targetPath);
  const rel = trimSlash(relativePath);
  return target && target !== '.' ? `${target}/${rel}` : rel;
}

function resolveWorkspaceSourceDirectory(
  workspacePath: string,
  sourcePath: string,
): string {
  const requestedPath = path.resolve(workspacePath, sourcePath);
  const relativePath = path.relative(workspacePath, requestedPath);

  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new InputError('sourcePath must be within the scaffolder workspace');
  }

  return scaffolderNode.getRepoSourceDirectory(workspacePath, sourcePath);
}

/**
 * Publishes workspace files to a new branch in an existing Gitea repository and
 * opens a pull request. This intentionally mirrors `publish:github:pull-request`.
 */
type PullRequestOutput = {
  remoteUrl?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  branchName?: string;
  targetBranchName?: string;
};
export function createGiteaPullRequestAction(options: Options) {
  return scaffolderNode.createTemplateAction({
    id: 'publish:gitea:pull-request',
    description: 'Publishes workspace changes to a Gitea branch and opens a pull request',
    schema: {
      // @ts-ignore - Zod schema types differ between scaffolder-node 0.12.x and source
      input: schema,
      // @ts-ignore - Zod schema types differ between scaffolder-node 0.12.x and source
      output: giteaPullRequestOutputSchema,
    },
    async handler(ctx) {
      const input = schema.parse(ctx.input);
      const { repo, client } = createGiteaClient({
        repoUrl: input.repoUrl,
        integrations: options.integrations,
        token: input.token,
      });

      // Log warning for git author params that Gitea Contents API doesn't support
      if (input.gitAuthorName || input.gitAuthorEmail || input.forceEmptyGitAuthor) {
        ctx.logger.warn(
          'gitAuthorName, gitAuthorEmail, and forceEmptyGitAuthor are not supported by Gitea Contents API and will be ignored',
        );
      }

      const sourceDir = resolveWorkspaceSourceDirectory(
        ctx.workspacePath,
        input.sourcePath,
      );
      const files = await scaffolderNode.serializeDirectoryContents(sourceDir, {
        gitignore: true,
      });
      const commitMessage = input.commitMessage ?? input.title;

      if (files.length === 0 && input.filesToDelete.length === 0 && !input.createWhenEmpty) {
        ctx.logger.warn(`No files found in ${sourceDir} and createWhenEmpty is false; skipping PR creation`);
        return;
      }

      let sourceBranchReady = false;
      const ensureSourceBranch = async () => {
        if (sourceBranchReady) return;
        try {
          await client.getBranch(input.branchName);
        } catch (error) {
          if (!(error instanceof GiteaApiError) || error.status !== 404) {
            throw new Error(
              `Failed to inspect source branch '${input.branchName}': ${error}`,
            );
          }
          await client.request(client.repoPath('/branches'), {
            method: 'POST',
            body: JSON.stringify({
              new_branch_name: input.branchName,
              old_branch_name: input.targetBranchName,
            }),
          });
        }
        sourceBranchReady = true;
      };

      if (files.length === 0 && input.filesToDelete.length === 0 && input.createWhenEmpty) {
        await ensureSourceBranch();
      }

      if (files.length > 0 || input.filesToDelete.length > 0) {
        let baseBranch = input.branchName;
        let branch;
        try {
          branch = await client.getBranch(input.branchName);
          sourceBranchReady = true;
        } catch (error) {
          if (!(error instanceof GiteaApiError) || error.status !== 404) {
            throw new Error(
              `Failed to inspect source branch '${input.branchName}': ${error}`,
            );
          }
          baseBranch = input.targetBranchName;
          try {
            branch = await client.getBranch(baseBranch);
          } catch (targetError) {
            throw new Error(
              `Failed to inspect target branch '${baseBranch}': ${targetError}`,
            );
          }
        }

        const commitSha = branch.commit?.id ?? branch.commit?.sha;
        if (!commitSha) {
          throw new Error(
            `Gitea did not return a commit SHA for branch '${baseBranch}'`,
          );
        }
        const tree = await client.getRecursiveTree(commitSha);
        if (tree.truncated) {
          throw new Error(
            `Gitea returned a truncated tree for branch '${baseBranch}'`,
          );
        }
        const existingPaths = new Map(
          (tree.tree ?? [])
            .filter(entry => entry.type === 'blob' && entry.path && entry.sha)
            .map(entry => [entry.path!, entry.sha!]),
        );

        const operations = new Map<string, GiteaBatchFileOperation>();
        const renderedPaths = new Set<string>();
        for (const file of files) {
          const repoFilePath = joinRepoPath(input.targetPath, file.path);
          renderedPaths.add(repoFilePath);
          const existingSha = existingPaths.get(repoFilePath);
          operations.set(
            repoFilePath,
            existingSha
              ? {
                  operation: 'update',
                  path: repoFilePath,
                  content: Buffer.from(file.content).toString('base64'),
                  sha: existingSha,
                }
              : {
                  operation: 'create',
                  path: repoFilePath,
                  content: Buffer.from(file.content).toString('base64'),
                },
          );
        }

        for (const filePath of input.filesToDelete) {
          const normalizedPath = trimSlash(filePath);
          if (renderedPaths.has(normalizedPath)) {
            throw new InputError(
              `Conflicting create/update and delete operations for '${normalizedPath}'`,
            );
          }
          if (operations.has(normalizedPath)) continue;
          const existingSha = existingPaths.get(normalizedPath);
          if (!existingSha) {
            ctx.logger.info(
              `File ${normalizedPath} is already absent from ${baseBranch}`,
            );
            continue;
          }
          operations.set(normalizedPath, {
            operation: 'delete',
            path: normalizedPath,
            sha: existingSha,
          });
        }

        if (operations.size > 0) {
          ctx.logger.info(
            `Publishing ${operations.size} file changes to ${repo.owner}/${repo.repo}:${input.branchName}`,
          );
          await client.changeFiles({
            branch: baseBranch,
            ...(!sourceBranchReady ? { new_branch: input.branchName } : {}),
            message: commitMessage,
            files: [...operations.values()],
          });
          sourceBranchReady = true;
        } else if (!sourceBranchReady) {
          await ensureSourceBranch();
        }
      }

      // Handle update mode - find existing PR by branch
      let existingPr: { index?: number; id?: number } | undefined;
      if (input.update) {
        try {
          const pulls = await client.request<{ index?: number; id?: number }[]>(
            `${client.repoPath('/pulls')}?head=${repo.owner}:${encodeURIComponent(input.branchName)}&state=open`,
          );
          if (pulls && pulls.length > 0) {
            existingPr = pulls[0];
          }
        } catch (e) {
          ctx.logger.warn(`Failed to find existing PR for update: ${e}`);
        }
      }

      let pr: { html_url?: string; number?: number; index?: number; id?: number } | undefined;

      if (existingPr) {
        // Update existing PR
        const prIndex = existingPr.index ?? existingPr.id;
        ctx.logger.info(`Updating existing PR #${prIndex}`);
        pr = await client.request(client.repoPath(`/pulls/${prIndex}`), {
          method: 'PATCH',
          body: JSON.stringify({
            title: input.title,
            body: input.description,
          }),
        });
      } else {
        // Create new PR
        pr = await client.request<{ html_url?: string; number?: number; index?: number }>(client.repoPath('/pulls'), {
          method: 'POST',
          body: JSON.stringify({
            base: input.targetBranchName,
            head: input.branchName,
            title: input.title,
            body: input.description,
          }),
        });
      }

      if (!pr) {
        throw new Error('Failed to create or update pull request — no response from Gitea');
      }

      // Request reviewers and assignees after PR creation/update
      const prIndex = pr.index ?? pr.id ?? pr.number;

      if (input.reviewers.length > 0) {
        ctx.logger.info(`Requesting ${input.reviewers.length} reviewers for PR #${prIndex}`);
        for (const reviewer of input.reviewers) {
          try {
            await client.request(client.repoPath(`/pulls/${prIndex}/requests`), {
              method: 'POST',
              body: JSON.stringify({ reviewer }),
            });
          } catch (e) {
            ctx.logger.warn(`Failed to request reviewer ${reviewer}: ${e}`);
          }
        }
      }

      if (input.teamReviewers.length > 0) {
        ctx.logger.info(`Requesting ${input.teamReviewers.length} team reviewers for PR #${prIndex}`);
        for (const team of input.teamReviewers) {
          try {
            await client.request(client.repoPath(`/pulls/${prIndex}/requests`), {
              method: 'POST',
              body: JSON.stringify({ team }),
            });
          } catch (e) {
            ctx.logger.warn(`Failed to request team reviewer ${team}: ${e}`);
          }
        }
      }

      if (input.assignees.length > 0) {
        ctx.logger.info(`Assigning ${input.assignees.length} assignees to PR #${prIndex}`);
        try {
          await client.request(client.repoPath(`/issues/${prIndex}`), {
            method: 'PATCH',
            body: JSON.stringify({ assignees: input.assignees }),
          });
        } catch (e) {
          ctx.logger.warn(`Failed to assign assignees: ${e}`);
        }
      }

      ctx.output('remoteUrl', pr.html_url);
      ctx.output('pullRequestUrl', pr.html_url);
      ctx.output('pullRequestNumber', pr.number ?? pr.index ?? pr.id);
      ctx.output('branchName', input.branchName);
      ctx.output('targetBranchName', input.targetBranchName);
    },
  }) as any;
}
