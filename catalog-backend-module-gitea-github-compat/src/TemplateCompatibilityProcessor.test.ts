import { Entity } from '@backstage/catalog-model';
import { ACTION_MAP, TemplateCompatibilityProcessor } from './TemplateCompatibilityProcessor';

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
    expect(spec.steps.map((step: any) => step.action)).toEqual([...Object.values(ACTION_MAP), 'github:actions:dispatch']);
    expect(spec.steps[0].input.repoUrl).toBe('gitea.apps.example.com?owner=example&repo=service');
    expect(spec.parameters[0].properties.repoUrl['ui:options'].allowedHosts).toEqual(['gitea.apps.example.com', 'git.example.com']);
    expect(spec.description).toContain('https://github.com/');
    expect(once.metadata.annotations?.['backstage.io/source-location']).toContain('github.com');
  });
  it('maps every referenced step output to a registered Gitea action output', async () => {
    const result = await processor.preProcessEntity(template());
    const spec: any = result.spec;
    const steps = new Map(spec.steps.map((step: any) => [step.id, step]));
    const registered: Record<string, string[]> = {
      'publish:gitea': ['remoteUrl', 'repoContentsUrl', 'commitHash', 'repoId'],
      'publish:gitea:pull-request': ['remoteUrl', 'pullRequestUrl', 'pullRequestNumber', 'targetBranchName', 'branchName'],
      'gitea:webhook': ['hookId', 'hookUrl'],
    };
    expect(Object.values(ACTION_MAP).every(action => registered[action])).toBe(true);
    const serialized = JSON.stringify(spec.output);
    for (const match of serialized.matchAll(/steps\.([^.]+)\.output\.([A-Za-z0-9_]+)/g)) {
      const step: any = steps.get(match[1]);
      expect(registered[step.action]).toContain(match[2]);
    }
  });
});
