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
import { createGiteaClient } from './giteaClient';

export const giteaWebhookInputSchema = z.object({
  repoUrl: z.string().describe('Repository URL in Backstage repoUrl format, e.g. gitea.example.com?owner=org&repo=name'),
  webhookUrl: z.string().url().describe('Target URL that Gitea should call when the selected events occur'),
  webhookSecret: z.string().optional().describe('Secret token Gitea sends to the webhook receiver'),
  events: z.array(z.string()).default(['push']).describe('Gitea hook events, for example push, pull_request, create, delete'),
  active: z.boolean().default(true),
  contentType: z.enum(['json', 'form']).default('form'),
  httpMethod: z.enum(['post']).default('post'),
  insecureSsl: z.boolean().default(false).describe('When true, disables TLS verification for the hook target'),
  branchFilter: z.string().optional().describe('Optional branch filter supported by Gitea hooks'),
  token: z.string().optional().describe('Optional user or task token. When provided, it overrides configured integration credentials.'),
});
const schema = giteaWebhookInputSchema;

export const giteaWebhookOutputSchema = z.object({
  hookId: z.number().optional(),
  hookUrl: z.string().optional(),
});

type Input = z.infer<typeof schema>;

type Options = {
  integrations: ScmIntegrationRegistry;
};

/**
 * Creates a repository webhook in Gitea.
 *
 * This is the Gitea equivalent of the GitHub-oriented scaffolder use case in
 * contract-first-idp: Backstage creates/configures the repo, then tells the forge
 * to call Tekton/OpenShift when code is pushed.
 */
type WebhookOutput = { hookId?: number; hookUrl?: string };
export function createGiteaWebhookAction(options: Options) {
  return createTemplateAction({
    id: 'gitea:webhook',
    description: 'Creates a repository webhook in Gitea',
    schema: {
      // @ts-ignore - Zod schema types differ between scaffolder-node 0.12.x and source
      input: schema,
      // @ts-ignore - Zod schema types differ between scaffolder-node 0.12.x and source
      output: giteaWebhookOutputSchema,
    },
    async handler(ctx) {
      const input = schema.parse(ctx.input);
      const { repo, client } = createGiteaClient({
        repoUrl: input.repoUrl,
        integrations: options.integrations,
        token: input.token,
      });

      const body = {
        type: 'gitea',
        active: input.active,
        events: input.events,
        branch_filter: input.branchFilter,
        config: {
          url: input.webhookUrl,
          content_type: input.contentType,
          http_method: input.httpMethod,
          secret: input.webhookSecret,
          insecure_ssl: input.insecureSsl ? '1' : '0',
        },
      };

      ctx.logger.info(`Creating Gitea webhook for ${repo.owner}/${repo.repo} -> ${input.webhookUrl}`);

      const hook = await client.request<{ id?: number; url?: string }>(client.repoPath('/hooks'), {
        method: 'POST',
        body: JSON.stringify(body),
      });

      ctx.output('hookId', hook.id);
      ctx.output('hookUrl', hook.url ?? input.webhookUrl);
    },
  }) as any;
}
