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
import { createGiteaClient } from './giteaClient';

const schema = z.object({
  repoUrl: z.string().describe('Target repository URL in Backstage repoUrl format'),
  branchName: z.string().describe('Source branch to create/update'),
  targetBranchName: z.string().default('main').describe('Base branch for the pull request'),
  title: z.string(),
  description: z.string().optional(),
  sourcePath: z.string().default('.').describe('Workspace subdirectory containing files to publish'),
  targetPath: z.string().default('.').describe('Target subdirectory in the repository'),
  commitMessage: z.string().optional(),
  token: z.string().optional(),
  draft: z.boolean().default(false).describe('Reserved for Gitea versions that support draft PRs'),
  // Additional params for parity with publish:github:pull-request
  filesToDelete: z.array(z.string()).default([]).describe('List of file paths to delete from the target branch'),
  reviewers: z.array(z.string()).default([]).describe('List of user logins to request as reviewers on the PR'),
  assignees: z.array(z.string()).default([]).describe('List of user logins to assign to the PR'),
  teamReviewers: z.array(z.string()).default([]).describe('List of team slugs to request as team reviewers on the PR'),
  update: z.boolean().default(false).describe('If true, update an existing PR instead of creating a new one'),
  createWhenEmpty: z.boolean().default(false).describe('If true, create a PR even if no files exist in the source path'),
  // Git author fields — Gitea Contents API doesn't support custom git authors, these are accepted for API parity
  gitAuthorName: z.string().optional().describe('Reserved for API parity with GitHub (not supported by Gitea Contents API)'),
  gitAuthorEmail: z.string().optional().describe('Reserved for API parity with GitHub (not supported by Gitea Contents API)'),
  forceEmptyGitAuthor: z.boolean().default(false).describe('Reserved for API parity with GitHub (not supported by Gitea Contents API)'),
});

type Input = z.infer<typeof schema>;

type Options = {
  integrations: ScmIntegrationRegistry;
};

type ContentsResponse = {
  content?: {
    sha?: string;
  };
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
      output: z.object({
        pullRequestUrl: z.string().optional(),
        pullRequestNumber: z.number().optional(),
        branchName: z.string().optional(),
        targetBranchName: z.string().optional(),
      }),
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

      // Handle createWhenEmpty - skip if no files and not creating when empty
      if (files.length === 0 && !input.createWhenEmpty) {
        ctx.logger.warn(`No files found in ${sourceDir} and createWhenEmpty is false; skipping PR creation`);
        return;
      }

      // Delete requested files first
      if (input.filesToDelete.length > 0) {
        ctx.logger.info(`Deleting ${input.filesToDelete.length} files from ${repo.owner}/${repo.repo}:${input.branchName}`);
        for (const filePath of input.filesToDelete) {
          const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
          try {
            await client.request(
              client.repoPath(`/contents/${encodedPath}?ref=${encodeURIComponent(input.branchName)}`),
              { method: 'DELETE' },
            );
          } catch (e) {
            // File may not exist on this branch yet, that's okay
            ctx.logger.warn(`Failed to delete file ${filePath}: ${e}`);
          }
        }
      }

      if (files.length > 0) {
        ctx.logger.info(`Publishing ${files.length} files to ${repo.owner}/${repo.repo}:${input.branchName}`);

        for (const file of files) {
          const repoFilePath = joinRepoPath(input.targetPath, file.path);
          const encodedPath = repoFilePath.split('/').map(encodeURIComponent).join('/');
          let existingSha: string | undefined;

          try {
            const existing = await client.request<ContentsResponse>(
              client.repoPath(`/contents/${encodedPath}?ref=${encodeURIComponent(input.branchName)}`),
            );
            existingSha = existing.content?.sha;
          } catch (e) {
            // If the branch or file does not exist, fall through and create it.
          }

          const payload: Record<string, unknown> = {
            message: commitMessage,
            content: Buffer.from(file.content).toString('base64'),
          };

          if (existingSha) {
            payload.sha = existingSha;
          } else {
            payload.ref = input.targetBranchName;
            payload.new_branch = input.branchName;
          }

          const method = existingSha ? 'PUT' : 'POST';
          await client.request(client.repoPath(`/contents/${encodedPath}`), {
            method,
            body: JSON.stringify(payload),
          });
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

      ctx.output('pullRequestUrl', pr.html_url);
      ctx.output('pullRequestNumber', pr.number ?? pr.index ?? pr.id);
      ctx.output('branchName', input.branchName);
      ctx.output('targetBranchName', input.targetBranchName);
    },
  }) as any;
}
