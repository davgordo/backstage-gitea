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

import { InputError } from '@backstage/errors';
import {
  getGiteaRequestOptions,
  ScmIntegrationRegistry,
} from '@backstage/integration';
import { parseRepoUrl } from '@backstage/plugin-scaffolder-node';

export type GiteaRepo = {
  host: string;
  owner: string;
  repo: string;
  apiBaseUrl: string;
  repoUrl: string;
};

export type ResolveGiteaRepoOptions = {
  repoUrl: string;
  integrations: ScmIntegrationRegistry;
};

type GiteaIntegrationConfigWithApiBaseUrl = {
  baseUrl?: string;
  apiBaseUrl?: string;
};

export function resolveGiteaRepo(options: ResolveGiteaRepoOptions): GiteaRepo {
  const { host, owner, repo } = parseRepoUrl(options.repoUrl, options.integrations as any);

  if (!host) throw new InputError('repoUrl must include host');
  if (!owner) throw new InputError('repoUrl must include owner');
  if (!repo) throw new InputError('repoUrl must include repo');

  const integration = options.integrations.gitea.byHost(host);
  if (!integration) {
    throw new InputError(`No Gitea integration configured for host ${host}`);
  }

  const integrationConfig =
    integration.config as GiteaIntegrationConfigWithApiBaseUrl;
  const baseUrl =
    integrationConfig.baseUrl?.replace(/\/$/, '') ?? `https://${host}`;
  const apiBaseUrl =
    integrationConfig.apiBaseUrl?.replace(/\/$/, '') ?? `${baseUrl}/api/v1`;

  return {
    host,
    owner,
    repo,
    apiBaseUrl,
    repoUrl: `${baseUrl}/${owner}/${repo}`,
  };
}

export type GiteaClientOptions = {
  repo: GiteaRepo;
  token?: string;
  defaultHeaders?: Record<string, string>;
};

export type CreateGiteaClientOptions = ResolveGiteaRepoOptions & {
  token?: string;
};

export class GiteaClient {
  private readonly repo: GiteaRepo;
  private readonly token?: string;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: GiteaClientOptions) {
    this.repo = options.repo;
    this.token = options.token;
    this.defaultHeaders = options.defaultHeaders ?? {};
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...(options.headers as Record<string, string> | undefined),
    };

    if (this.token) {
      headers.Authorization = `token ${this.token}`;
    }

    const response = await fetch(`${this.repo.apiBaseUrl}${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Gitea API ${options.method ?? 'GET'} ${path} failed: ${response.status} ${response.statusText}: ${body}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  repoPath(path: string): string {
    const encodedOwner = encodeURIComponent(this.repo.owner);
    const encodedRepo = encodeURIComponent(this.repo.repo);
    return `/repos/${encodedOwner}/${encodedRepo}${path}`;
  }
}

export function createGiteaClient(options: CreateGiteaClientOptions): {
  repo: GiteaRepo;
  client: GiteaClient;
} {
  const repo = resolveGiteaRepo(options);
  const integration = options.integrations.gitea.byHost(repo.host);

  if (!integration) {
    throw new InputError(`No Gitea integration configured for host ${repo.host}`);
  }

  return {
    repo,
    client: new GiteaClient({
      repo,
      token: options.token,
      defaultHeaders: getGiteaRequestOptions(integration.config).headers,
    }),
  };
}
