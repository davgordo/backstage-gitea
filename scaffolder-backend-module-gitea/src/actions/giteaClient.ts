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

export type GiteaPermission = 'read' | 'write' | 'admin';

export type GiteaTeam = {
  id: number;
  name: string;
  slug?: string;
};

export type GiteaBatchFileOperation =
  | { operation: 'create'; path: string; content: string }
  | { operation: 'update'; path: string; content: string; sha: string }
  | { operation: 'delete'; path: string; sha: string };

export type GiteaBatchContentRequest = {
  branch: string;
  new_branch?: string;
  message: string;
  files: GiteaBatchFileOperation[];
};

export type GiteaBranchResponse = {
  name?: string;
  commit?: { id?: string; sha?: string };
};

export type GiteaGitTreeEntry = {
  path?: string;
  sha?: string;
  type?: string;
};

export type GiteaGitTreeResponse = {
  sha?: string;
  tree?: GiteaGitTreeEntry[];
  truncated?: boolean;
};

export type GiteaBatchContentResponse = {
  commit?: { sha?: string };
  files?: Array<{ path?: string; sha?: string }>;
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

export class GiteaApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`Gitea API ${method} ${path} failed: ${status}: ${body}`);
  }
}

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
      throw new GiteaApiError(
        response.status,
        options.method ?? 'GET',
        path,
        body,
      );
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

  async getBranch(
    branch: string,
    signal?: AbortSignal,
  ): Promise<GiteaBranchResponse> {
    return this.request(
      this.repoPath(`/branches/${encodeURIComponent(branch)}`),
      { signal },
    );
  }

  async getRecursiveTree(
    ref: string,
    signal?: AbortSignal,
  ): Promise<GiteaGitTreeResponse> {
    return this.request(
      `${this.repoPath(`/git/trees/${encodeURIComponent(ref)}`)}?recursive=true`,
      { signal },
    );
  }

  async getContents(
    path: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const encodedPath = path
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');
    return this.request(
      `${this.repoPath(`/contents/${encodedPath}`)}?ref=${encodeURIComponent(ref)}`,
      { signal },
    );
  }

  async changeFiles(
    request: GiteaBatchContentRequest,
  ): Promise<GiteaBatchContentResponse> {
    return this.request(this.repoPath('/contents'), {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async addRepositoryCollaborator(
    username: string,
    permission: GiteaPermission,
  ): Promise<void> {
    await this.request(
      this.repoPath(`/collaborators/${encodeURIComponent(username)}`),
      {
        method: 'PUT',
        body: JSON.stringify({ permission }),
      },
    );
  }

  async listOrganizationTeams(organization: string): Promise<GiteaTeam[]> {
    return this.request<GiteaTeam[]>(
      `/orgs/${encodeURIComponent(organization)}/teams?limit=1000`,
    );
  }

  async attachRepositoryToTeam(
    organization: string,
    teamId: number,
  ): Promise<void> {
    await this.request(
      `/teams/${teamId}/repos/${encodeURIComponent(organization)}/${encodeURIComponent(this.repo.repo)}`,
      { method: 'PUT' },
    );
  }

  async updateTeamPermission(
    teamId: number,
    permission: GiteaPermission,
  ): Promise<void> {
    await this.request(`/teams/${teamId}`, {
      method: 'PATCH',
      body: JSON.stringify({ permission }),
    });
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
