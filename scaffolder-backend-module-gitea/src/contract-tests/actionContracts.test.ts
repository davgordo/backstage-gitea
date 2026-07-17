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
  return schema;
}

function properties(action: any, side: 'input' | 'output'): Record<string, any> {
  return jsonSchema(action, side).properties ?? {};
}

function zodProperties(schema: any): Record<string, any> {
  const shape = typeof schema.shape === 'function' ? schema.shape() : schema.shape;
  return shape ?? {};
}

function zodField(field: any) {
  const acceptsUndefined = field.safeParse(undefined).success;
  let current = field;
  let defaultValue: unknown;
  while (current?._def?.innerType) {
    if (current._def.typeName === 'ZodDefault') {
      defaultValue = current._def.defaultValue();
    }
    current = current._def.innerType;
  }
  const typeName = current?._def?.typeName;
  const types: Record<string, string> = {
    ZodString: 'string',
    ZodEnum: 'string',
    ZodNumber: 'number',
    ZodBoolean: 'boolean',
    ZodArray: 'array',
    ZodObject: 'object',
  };
  const type = types[typeName] ?? typeName;
  return { required: !acceptsUndefined, type, defaultValue };
}

function jsonField(action: any, side: 'input' | 'output', name: string) {
  const schema = jsonSchema(action, side);
  const property = schema.properties[name];
  let type = property.type ?? property.anyOf?.[0]?.type;
  if (!type && property.items) type = 'array';
  if (!type && property.enum) type = 'string';
  return {
    required: (schema.required ?? []).includes(name),
    type,
    defaultValue: property.default,
  };
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

  function outputProperties(replacement: string): Record<string, any> {
    if (replacement === 'publish:gitea:pull-request') {
      return zodProperties(giteaPullRequestOutputSchema);
    }
    if (replacement === 'gitea:webhook') {
      return zodProperties(giteaWebhookOutputSchema);
    }
    return properties(gitea[replacement as keyof typeof gitea], 'output');
  }

  function inputNames(replacement: string): string[] {
    if (replacement === 'publish:gitea:pull-request') {
      return Object.keys(zodProperties(giteaPullRequestInputSchema));
    }
    if (replacement === 'gitea:webhook') {
      return Object.keys(zodProperties(giteaWebhookInputSchema));
    }
    return Object.keys(properties(gitea[replacement as keyof typeof gitea], 'input'));
  }

  for (const [githubId, contract] of Object.entries(compatibilityContracts)) {
    it(`${githubId} has all guaranteed outputs on ${contract.replacement}`, () => {
      const outputs = outputProperties(contract.replacement);
      for (const output of contract.requiredOutputs ?? []) expect(outputs).toHaveProperty(output);
    });
  }

  for (const githubId of Object.keys(compatibilityContracts) as Array<keyof typeof compatibilityContracts>) {
    it(`classifies every ${githubId} input and rejects upstream drift`, () => {
      const upstream = Object.keys(properties(github[githubId], 'input'));
      const replacement = compatibilityContracts[githubId].replacement;
      const supported = inputNames(replacement);
      const rejected = 'rejected' in compatibilityContracts[githubId] ? compatibilityContracts[githubId].rejected : [];
      const classified = new Set([...supported, ...rejected]);
      const unclassified = upstream.filter(name => !classified.has(name));
      expect(unclassified.map(name => `${githubId}.${name}`)).toEqual([]);

      const extensions = new Set(compatibilityContracts[githubId].giteaInputExtensions);
      const unclassifiedGitea = supported.filter(
        name => !upstream.includes(name) && !extensions.has(name as never),
      );
      expect(unclassifiedGitea.map(name => `${replacement}.${name}`)).toEqual([]);
    });
  }

  it.each([
    ['publish:github:pull-request', 'publish:gitea:pull-request', giteaPullRequestInputSchema],
    ['github:webhook', 'gitea:webhook', giteaWebhookInputSchema],
  ] as const)('keeps common %s input types and requiredness compatible', (githubId, _giteaId, schema) => {
    const upstreamNames = Object.keys(properties(github[githubId], 'input'));
    const giteaNames = Object.keys(zodProperties(schema));
    const exceptions = new Set(compatibilityContracts[githubId].requirednessDifferences);
    const commonNames = upstreamNames.filter(input => giteaNames.includes(input));
    const actual = commonNames.map(name => {
      const upstream = jsonField(github[githubId], 'input', name);
      const replacement = zodField(zodProperties(schema)[name]);
      return {
        name,
        type: replacement.type,
        expectedType: upstream.type,
        required: exceptions.has(name as never) ? upstream.required : replacement.required,
        expectedRequired: upstream.required,
      };
    });
    expect(actual).toEqual(actual.map(field => ({
      ...field,
      type: field.expectedType,
      required: field.expectedRequired,
    })));
  });

  it('keeps common publish input types and requiredness compatible', () => {
    const githubAction = github['publish:github'];
    const giteaAction = gitea['publish:gitea'];
    const githubNames = Object.keys(properties(githubAction, 'input'));
    const giteaNames = Object.keys(properties(giteaAction, 'input'));
    const exceptions = new Set(compatibilityContracts['publish:github'].requirednessDifferences);
    const commonNames = githubNames.filter(input => giteaNames.includes(input));
    const actual = commonNames.map(name => {
      const upstream = jsonField(githubAction, 'input', name);
      const replacement = jsonField(giteaAction, 'input', name);
      return {
        name,
        type: replacement.type,
        expectedType: upstream.type,
        required: exceptions.has(name as never) ? upstream.required : replacement.required,
        expectedRequired: upstream.required,
      };
    });
    expect(actual).toEqual(actual.map(field => ({
      ...field,
      type: field.expectedType,
      required: field.expectedRequired,
    })));
  });

  it('aligns createWhenEmpty and webhook contentType defaults', () => {
    const githubPr = properties(github['publish:github:pull-request'], 'input');
    expect(giteaPullRequestInputSchema.parse({ repoUrl: 'x', branchName: 'x', title: 'x' }).createWhenEmpty).toBe(githubPr.createWhenEmpty.default ?? true);
    const githubHook = properties(github['github:webhook'], 'input');
    expect(giteaWebhookInputSchema.parse({ repoUrl: 'x', webhookUrl: 'https://example.com' }).contentType).toBe(githubHook.contentType.default ?? 'form');
  });
});
