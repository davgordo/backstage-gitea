import { coreServices, createBackendModule } from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { readCompatibilityConfig } from './config';
import { TemplateCompatibilityProcessor } from './TemplateCompatibilityProcessor';

export const catalogModuleGiteaGithubCompat = createBackendModule({
  pluginId: 'catalog', moduleId: 'gitea-github-compat',
  register(reg) {
    reg.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
      },
      async init({ catalog, config }) {
        const compatibility = readCompatibilityConfig(config);
        if (!compatibility.enabled) return;
        catalog.addProcessor(new TemplateCompatibilityProcessor(compatibility.templates));
      },
    });
  },
});
