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

import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { ScmIntegrationRegistry } from '@backstage/integration';
import { z } from 'zod';
import { createGiteaClient, GiteaClient } from './giteaClient';

export type BranchProtectionOptions = {
  repoUrl: string;
  branchName: string;
  token?: string;

  protectDefaultBranch?: boolean;
  protectEnforceAdmins?: boolean;
  enforceAdmins?: boolean; // GitHub parity alias for protectEnforceAdmins
  requireCodeOwnerReviews?: boolean;
  dismissStaleReviews?: boolean;
  requiredApprovingReviewCount?: number;
  requiredStatusCheckContexts?: string[];
  requireBranchesToBeUpToDate?: boolean;
  requiredCommitSigning?: boolean;

  // GitHub parity params — not supported by Gitea currently
  bypassPullRequestAllowances?: { users?: string[]; teams?: string[] };
  restrictions?: { users?: string[]; teams?: string[] };
  requiredConversationResolution?: boolean;
  requireLastPushApproval?: boolean;
  requiredLinearHistory?: boolean;
  blockCreations?: boolean;

  // Gitea-specific escape hatch while the exact parity surface settles.
  raw?: Record<string, unknown>;
};

const schema = z.object({
  repoUrl: z.string(),
  branchName: z.string().default('main'),
  token: z.string().optional(),

  // GitHub parity: `branch` is an alias for `branchName`
  branch: z.string().optional(),

  protectDefaultBranch: z.boolean().optional().describe('Compatibility flag. If false, action is a no-op.'),
  protectEnforceAdmins: z.boolean().optional(),
  enforceAdmins: z.boolean().optional(),

  requireCodeOwnerReviews: z.boolean().optional(),
  dismissStaleReviews: z.boolean().optional(),
  requiredApprovingReviewCount: z.number().int().min(0).optional(),
  requiredStatusCheckContexts: z.array(z.string()).optional(),
  requireBranchesToBeUpToDate: z.boolean().optional(),
  requiredCommitSigning: z.boolean().optional(),

  // GitHub parity params
  bypassPullRequestAllowances: z.object({
    users: z.array(z.string()).optional(),
    teams: z.array(z.string()).optional(),
  }).optional(),
  restrictions: z.object({
    users: z.array(z.string()).optional(),
    teams: z.array(z.string()).optional(),
  }).optional(),
  requiredConversationResolution: z.boolean().optional(),
  requireLastPushApproval: z.boolean().optional(),
  requiredLinearHistory: z.boolean().optional(),
  blockCreations: z.boolean().optional(),

  // Gitea-specific escape hatch
  raw: z.record(z.unknown()).optional().describe('Additional raw Gitea branch protection payload fields'),
});

type Input = z.infer<typeof schema>;

type Options = {
  integrations: ScmIntegrationRegistry;
};

function toGiteaPayload(input: BranchProtectionOptions) {
  const branchName = input.branchName;
  const statusContexts = input.requiredStatusCheckContexts ?? [];
  const enforceAdmins = input.enforceAdmins ?? input.protectEnforceAdmins ?? false;

  return {
    branch_name: branchName,
    enable_push: false,
    enable_push_whitelist: false,
    enable_merge_whitelist: false,
    required_approvals: input.requiredApprovingReviewCount ?? 0,
    enable_status_check: statusContexts.length > 0,
    status_check_contexts: statusContexts,
    require_signed_commits: input.requiredCommitSigning ?? false,
    protected_file_patterns: '',
    unprotected_file_patterns: '',
    block_on_rejected_reviews: input.requireCodeOwnerReviews ?? false,
    dismiss_stale_approvals: input.dismissStaleReviews ?? false,
    block_on_outdated_branch: input.requireBranchesToBeUpToDate ?? false,
    apply_to_admins: enforceAdmins,
    ...input.raw,
  };
}

/**
 * Applies Gitea branch protection. Can be called from `publish:gitea` or used
 * standalone via the `gitea:branch-protection:create` action.
 *
 * @public
 */
export async function applyBranchProtection(
  client: GiteaClient,
  options: BranchProtectionOptions,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<string | undefined> {
  if (options.protectDefaultBranch === false) {
    logger.info('protectDefaultBranch=false; skipping Gitea branch protection');
    return undefined;
  }

  const payload = toGiteaPayload(options);

  // Warn about unsupported GitHub parity params
  const unsupportedParams: string[] = [];
  if (options.bypassPullRequestAllowances) {
    const bp = options.bypassPullRequestAllowances;
    if (bp.users?.length || bp.teams?.length) unsupportedParams.push('bypassPullRequestAllowances');
  }
  if (options.restrictions) {
    const r = options.restrictions;
    if (r.users?.length || r.teams?.length) unsupportedParams.push('restrictions');
  }
  if (options.requiredConversationResolution) unsupportedParams.push('requiredConversationResolution');
  if (options.requireLastPushApproval) unsupportedParams.push('requireLastPushApproval');
  if (options.requiredLinearHistory) unsupportedParams.push('requiredLinearHistory');
  if (options.blockCreations) unsupportedParams.push('blockCreations');

  if (unsupportedParams.length > 0) {
    logger.warn(
      `The following branch protection parameters are not supported by Gitea and will be ignored: ${unsupportedParams.join(', ')}`,
    );
  }

  logger.info(`Applying Gitea branch protection for ${options.branchName}`);

  await client.request(client.repoPath('/branch_protections'), {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return options.branchName;
}

/**
 * Creates a standalone branch protection action.
 */
type BranchProtectionOutput = { branchName?: string };
export function createGiteaBranchProtectionAction(options: Options) {
  return createTemplateAction({
    id: 'gitea:branch-protection:create',
    description: 'Configures Branch Protection',
    schema: {
      // @ts-ignore - Zod schema types differ between scaffolder-node 0.12.x and source
      input: schema,
      // @ts-ignore - Zod schema types differ between scaffolder-node 0.12.x and source
      output: z.object({
        branchName: z.string().optional(),
      }),
    },
    async handler(ctx) {
      const input = schema.parse(ctx.input);

      if (input.protectDefaultBranch === false) {
        ctx.logger.info('protectDefaultBranch=false; skipping Gitea branch protection');
        return;
      }

      // Support `branch` as an alias for `branchName`
      const branchName = input.branch ?? input.branchName;

      const { client } = createGiteaClient({
        repoUrl: input.repoUrl,
        integrations: options.integrations,
        token: input.token,
      });

      const protectionOptions: BranchProtectionOptions = {
        repoUrl: input.repoUrl,
        branchName,
        token: input.token,
        protectDefaultBranch: input.protectDefaultBranch,
        protectEnforceAdmins: input.protectEnforceAdmins,
        enforceAdmins: input.enforceAdmins,
        requireCodeOwnerReviews: input.requireCodeOwnerReviews,
        dismissStaleReviews: input.dismissStaleReviews,
        requiredApprovingReviewCount: input.requiredApprovingReviewCount,
        requiredStatusCheckContexts: input.requiredStatusCheckContexts,
        requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate,
        requiredCommitSigning: input.requiredCommitSigning,
        bypassPullRequestAllowances: input.bypassPullRequestAllowances,
        restrictions: input.restrictions,
        requiredConversationResolution: input.requiredConversationResolution,
        requireLastPushApproval: input.requireLastPushApproval,
        requiredLinearHistory: input.requiredLinearHistory,
        blockCreations: input.blockCreations,
        raw: input.raw,
      };

      const branch = await applyBranchProtection(client, protectionOptions, ctx.logger);
      ctx.output('branchName', branch);
    },
  }) as any;
}
