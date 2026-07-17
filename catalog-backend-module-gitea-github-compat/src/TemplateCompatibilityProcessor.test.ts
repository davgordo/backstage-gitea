import { Entity } from '@backstage/catalog-model';
import { ConfigReader } from '@backstage/config';
import { ScmIntegrations } from '@backstage/integration';
import {
  createGiteaPullRequestAction,
  createGiteaWebhookAction,
  createPublishGiteaAction,
  giteaPullRequestOutputSchema,
  giteaWebhookOutputSchema,
} from '@backstage/plugin-scaffolder-backend-module-gitea';
import { ACTION_MAP, TemplateCompatibilityProcessor } from './TemplateCompatibilityProcessor';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const processor = new TemplateCompatibilityProcessor({
  annotation: 'backstage-gitea.io/github-compatible',
  allowedHosts: { 'github.com': 'gitea.apps.example.com' },
});

function template(marked = true): Entity {
  return {
    apiVersion: 'scaffolder.backstage.io/v1beta3', kind: 'Template',
    metadata: { name: 'contract-first', annotations: marked ? { 'backstage-gitea.io/github-compatible': 'true', 'backstage.io/source-location': 'url:https://github.com/example/templates' } : {} },
    spec: {
      description: 'Docs at https://github.com/example/public',
      parameters: [{ properties: { repoUrl: { type: 'string', 'ui:field': 'RepoUrlPicker', 'ui:options': { allowedHosts: ['github.com', 'git.example.com'] } } } }],
      steps: [
        { id: 'publish', action: 'publish:github', input: { repoUrl: 'github.com?owner=example&repo=service' } },
        { id: 'pr', action: 'publish:github:pull-request', input: { repoUrl: '${{ parameters.repoUrl }}' } },
        { id: 'hook', action: 'github:webhook' },
        { id: 'other', action: 'github:actions:dispatch' },
        { id: 'public', action: 'debug:log', input: { repoUrl: 'https://github.com/example/public?owner=example&repo=public' } },
      ],
      output: { links: [
        { url: '${{ steps.publish.output.remoteUrl }}' },
        { url: '${{ steps.publish.output.repoContentsUrl }}' },
        { url: '${{ steps.pr.output.remoteUrl }}' },
      ] },
    },
  };
}

describe('TemplateCompatibilityProcessor', () => {
  it('leaves unmarked templates and non-templates unchanged', async () => {
    const unmarked = template(false);
    expect(await processor.preProcessEntity(unmarked)).toBe(unmarked);
    const component = { ...template(), kind: 'Component' };
    expect(await processor.preProcessEntity(component)).toBe(component);
  });
  it('rewrites only structured compatibility fields and is idempotent', async () => {
    const original = template();
    const once = await processor.preProcessEntity(original);
    const twice = await processor.preProcessEntity(once);
    expect(twice).toEqual(once);
    expect(original.spec).toEqual(template().spec);
    const spec = once.spec as any;
    expect(spec.steps.map((step: any) => step.action)).toEqual([...Object.values(ACTION_MAP), 'github:actions:dispatch', 'debug:log']);
    expect(spec.steps[0].input.repoUrl).toBe('gitea.apps.example.com?owner=example&repo=service');
    expect(spec.parameters[0].properties.repoUrl['ui:options'].allowedHosts).toEqual(['gitea.apps.example.com', 'git.example.com']);
    expect(spec.description).toContain('https://github.com/');
    expect(spec.steps[4].input.repoUrl).toBe('https://github.com/example/public?owner=example&repo=public');
    expect(once.metadata.annotations?.['backstage.io/source-location']).toContain('github.com');
  });
  it('preserves Backstage expressions in repoUrl byte-for-byte', async () => {
    const entity = template();
    const expression = "repo=${{ parameters.system_name }}-system&owner=${{ steps['fetch-domain'].output.entity.metadata.labels['git-org'] }}";
    (entity.spec as any).steps[0].input.repoUrl = `github.com?${expression}`;

    const once = await processor.preProcessEntity(entity);
    const twice = await processor.preProcessEntity(once);

    expect((once.spec as any).steps[0].input.repoUrl).toBe(
      `gitea.apps.example.com?${expression}`,
    );
    expect(twice).toEqual(once);
  });
  it('processes a CFIDP System fixture without altering its expressions', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, '__fixtures__/cfidp-system-template.yaml'),
      'utf8',
    );
    const entity = YAML.parse(source) as Entity;
    const result = await processor.preProcessEntity(entity);
    const repoUrl = (result.spec as any).steps[0].input.repoUrl;
    expect(repoUrl).toBe(
      "gitea.apps.example.com?repo=${{ parameters.system_name }}-system&owner=${{ steps['fetch-domain'].output.entity.metadata.labels['git-org'] }}",
    );
    expect((result.spec as any).steps.map((step: any) => step.action)).toEqual([
      'publish:gitea',
      'publish:gitea:pull-request',
    ]);
  });
  it('maps every referenced step output to a registered Gitea action output', async () => {
    const result = await processor.preProcessEntity(template());
    const spec: any = result.spec;
    const steps = new Map(spec.steps.map((step: any) => [step.id, step]));
    const config = new ConfigReader({ integrations: { gitea: [{ host: 'gitea.apps.example.com', password: 'x' }] } });
    const integrations = ScmIntegrations.fromConfig(config);
    const publish = createPublishGiteaAction({ integrations, config }) as any;
    const actions = [
      publish,
      createGiteaPullRequestAction({ integrations }),
      createGiteaWebhookAction({ integrations }),
    ];
    expect(actions.map(action => action.id)).toEqual(Object.values(ACTION_MAP));
    const zodNames = (schema: any) => Object.keys(typeof schema.shape === 'function' ? schema.shape() : schema.shape);
    const registered: Record<string, string[]> = {
      'publish:gitea': Object.keys((publish.schema.outputSchema ?? publish.schema.output).properties),
      'publish:gitea:pull-request': zodNames(giteaPullRequestOutputSchema),
      'gitea:webhook': zodNames(giteaWebhookOutputSchema),
    };
    const serialized = JSON.stringify(spec.output);
    for (const match of serialized.matchAll(/steps\.([^.]+)\.output\.([A-Za-z0-9_]+)/g)) {
      const step: any = steps.get(match[1]);
      expect(registered[step.action]).toContain(match[2]);
    }
  });
});
