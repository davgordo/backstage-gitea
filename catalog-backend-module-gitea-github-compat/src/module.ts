import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { ScmIntegrations } from '@backstage/integration';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { readCompatibilityConfig } from './config';
import { GiteaGithubCompatEntityProvider } from './GiteaGithubCompatEntityProvider';
import { TemplateCompatibilityProcessor } from './TemplateCompatibilityProcessor';

export const catalogModuleGiteaGithubCompat = createBackendModule({
  pluginId: 'catalog', moduleId: 'gitea-github-compat',
  register(reg) {
    reg.registerInit({
      deps: { catalog: catalogProcessingExtensionPoint, config: coreServices.rootConfig, logger: coreServices.logger, scheduler: coreServices.scheduler },
      async init({ catalog, config, logger, scheduler }) {
        const compatibility = readCompatibilityConfig(config);
        if (!compatibility.enabled) return;
        const integrations = ScmIntegrations.fromConfig(config).gitea;
        catalog.addProcessor(new TemplateCompatibilityProcessor(compatibility.templates));
        for (const provider of compatibility.providers) {
          const integration = integrations.byHost(provider.integrationHost);
          if (!integration) throw new Error(`No Gitea integration found for GitHub-compatible provider '${provider.id}' at host '${provider.integrationHost}'.`);
          catalog.addEntityProvider(new GiteaGithubCompatEntityProvider(provider, integration, logger, scheduler.createScheduledTaskRunner(provider.schedule)));
        }
      },
    });
  },
});
