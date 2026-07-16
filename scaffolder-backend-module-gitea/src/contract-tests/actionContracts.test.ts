import { ConfigReader } from '@backstage/config';
import { ScmIntegrations } from '@backstage/integration';
import {
  createGithubWebhookAction,
  createPublishGithubAction,
  createPublishGithubPullRequestAction,
} from '@backstage/plugin-scaffolder-backend-module-github';
import { createPublishGiteaAction } from '../actions/gitea';
import { createGiteaPullRequestAction, giteaPullRequestInputSchema, giteaPullRequestOutputSchema } from '../actions/giteaPullRequest';
import { createGiteaWebhookAction, giteaWebhookInputSchema, giteaWebhookOutputSchema } from '../actions/giteaWebhook';
import { compatibilityContracts } from './compatibilityManifest';

const config = new ConfigReader({ integrations: { github: [{ host: 'github.com', token: 'x' }], gitea: [{ host: 'gitea.example.com', password: 'x' }] } });
const integrations = ScmIntegrations.fromConfig(config);

function jsonSchema(action: any, side: 'input' | 'output'): any {
  const schema = action.schema?.[`${side}Schema`] ?? action.schema?.[side];
  if (!schema) throw new Error(`Action ${action.id} does not expose its ${side} schema`);
  if (typeof schema === 'object' && schema.properties) return schema;
  if (typeof schema?.toJSON === 'function') return schema.toJSON();
  if (schema?._def) {
    const { zodToJsonSchema } = require('zod-to-json-schema');
    return zodToJsonSchema(schema);
  }
  return schema;
}

function properties(action: any, side: 'input' | 'output'): Record<string, any> {
  return jsonSchema(action, side).properties ?? {};
}

function zodProperties(schema: any): Record<string, any> {
  const shape = typeof schema.shape === 'function' ? schema.shape() : schema.shape;
  return shape ?? {};
}

describe('GitHub-to-Gitea public action contracts', () => {
  const github = {
    'publish:github': createPublishGithubAction({ integrations, config }),
    'publish:github:pull-request': createPublishGithubPullRequestAction({ integrations, config }),
    'github:webhook': createGithubWebhookAction({ integrations }),
  };
  const gitea = {
    'publish:gitea': createPublishGiteaAction({ integrations, config }),
    'publish:gitea:pull-request': createGiteaPullRequestAction({ integrations }),
    'gitea:webhook': createGiteaWebhookAction({ integrations }),
  };

  for (const [githubId, contract] of Object.entries(compatibilityContracts)) {
    it(`${githubId} has all guaranteed outputs on ${contract.replacement}`, () => {
      const outputs = contract.replacement === 'publish:gitea:pull-request'
        ? zodProperties(giteaPullRequestOutputSchema)
        : contract.replacement === 'gitea:webhook'
          ? zodProperties(giteaWebhookOutputSchema)
          : properties(gitea[contract.replacement as keyof typeof gitea], 'output');
      for (const output of contract.requiredOutputs ?? []) expect(outputs).toHaveProperty(output);
    });
  }

  for (const githubId of Object.keys(compatibilityContracts) as Array<keyof typeof compatibilityContracts>) {
    it(`classifies every ${githubId} input and rejects upstream drift`, () => {
      const upstream = Object.keys(properties(github[githubId], 'input'));
      const replacement = compatibilityContracts[githubId].replacement;
      const supported = replacement === 'publish:gitea:pull-request'
        ? Object.keys(zodProperties(giteaPullRequestInputSchema))
        : replacement === 'gitea:webhook'
          ? Object.keys(zodProperties(giteaWebhookInputSchema))
          : Object.keys(properties(gitea[replacement], 'input'));
      const rejected = 'rejected' in compatibilityContracts[githubId] ? compatibilityContracts[githubId].rejected : [];
      const classified = new Set([...supported, ...rejected]);
      const unclassified = upstream.filter(name => !classified.has(name));
      if (unclassified.length) throw new Error(`Unclassified GitHub action input: ${unclassified.map(name => `${githubId}.${name}`).join(', ')}`);
    });
  }

  it('aligns createWhenEmpty and webhook contentType defaults', () => {
    const githubPr = properties(github['publish:github:pull-request'], 'input');
    expect(giteaPullRequestInputSchema.parse({ repoUrl: 'x', branchName: 'x', title: 'x' }).createWhenEmpty).toBe(githubPr.createWhenEmpty.default ?? true);
    const githubHook = properties(github['github:webhook'], 'input');
    expect(giteaWebhookInputSchema.parse({ repoUrl: 'x', webhookUrl: 'https://example.com' }).contentType).toBe(githubHook.contentType.default ?? 'form');
  });
});
