/**
 * Integration test that imports the actual TypeScript handlers and runs them
 * against the live Gitea instance. Uses tsx to execute.
 *
 * Run with: npx tsx integration-test.ts
 */

import { ScmIntegrations } from '@backstage/integration';
import { ConfigReader } from '@backstage/config';
import { createGiteaWebhookAction } from './src/actions/giteaWebhook';
import { createGiteaPullRequestAction } from './src/actions/giteaPullRequest';
import { createGiteaBranchProtectionAction } from './src/actions/giteaBranchProtection';
import * as fs from 'fs';
import * as path from 'path';

// --- Config ---
// All of these are required — there are no safe defaults.
// Set them via environment variables before running this script.
const GITEA_BASE_URL = process.env.GITEA_BASE_URL;
const GITEA_TOKEN = process.env.GITEA_TOKEN;
const GITEA_USERNAME = process.env.GITEA_USERNAME;

if (!GITEA_BASE_URL || !GITEA_TOKEN || !GITEA_USERNAME) {
  console.error('Error: GITEA_BASE_URL, GITEA_TOKEN, and GITEA_USERNAME environment variables are required.');
  console.error('Example:');
  console.error('  GITEA_BASE_URL=https://gitea.example.com \\');
  console.error('  GITEA_TOKEN=your_personal_access_token \\');
  console.error('  GITEA_USERNAME=your_username \\');
  console.error('  npx tsx integration-test.ts');
  process.exit(1);
}

const TEST_REPO = 'backstage-integration-test';
const GITEA_HOST = new URL(GITEA_BASE_URL).hostname;

let passed = 0;
let failed = 0;
let repoDeleted = false;

// --- Helpers ---
const apiBase = `${GITEA_BASE_URL}/api/v1`;

async function api(p: string, opts: { method?: string; body?: string } = {}) {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `token ${GITEA_TOKEN}`,
  };
  const resp = await fetch(`${apiBase}${p}`, { ...opts, headers });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`API ${opts.method ?? 'GET'} ${p} failed ${resp.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

// --- Setup ---
async function ensureTestRepo() {
  try {
    return await api(`/repos/${GITEA_USERNAME}/${TEST_REPO}`);
  } catch {
    return await api(`/user/repos`, {
      method: 'POST',
      body: JSON.stringify({ name: TEST_REPO, private: true, auto_init: true }),
    });
  }
}

async function cleanupRepo() {
  if (repoDeleted) return;
  try {
    await api(`/repos/${GITEA_USERNAME}/${TEST_REPO}`, { method: 'DELETE' });
    repoDeleted = true;
    console.log('  🧹 Test repo deleted');
  } catch (error) {
    console.warn(`  Failed to delete test repo during cleanup: ${error}`);
  }
}

// --- Simple mock context (no Jest dependency) ---
function createMockContext(input: Record<string, any>, workspacePath?: string) {
  const outputs: Record<string, any> = {};
  return {
    input,
    workspacePath: workspacePath || '/tmp/mock-workspace',
    logger: {
      info: (...args: any[]) => console.log('    [INFO]', ...args),
      warn: (...args: any[]) => console.warn('    [WARN]', ...args),
      error: (...args: any[]) => console.error('    [ERROR]', ...args),
    },
    output: jestFn(outputs, 'output'),
    cancel: () => { throw new Error('Cancelled'); },
    isReady: false,
  };
}

function jestFn(storage: Record<string, any>, name: string) {
  const calls: any[][] = [];
  const fn = (...args: any[]) => {
    calls.push(args);
    if (args[0]) storage[args[0]] = args[1];
    return args[args.length - 1];
  };
  (fn as any).mock = { calls };
  return fn as any;
}

// --- Run ---
async function main() {
  console.log('Gitea Scaffolder Actions - Real Handler Tests');
  console.log(`Target: ${GITEA_BASE_URL}`);
  console.log('');

  // Setup test repo
  const testRepo = await ensureTestRepo();
  console.log(`Test repo: ${GITEA_USERNAME}/${TEST_REPO} (id: ${testRepo.id})`);

  process.on('exit', () => cleanupRepo());

  const config = new ConfigReader({
    integrations: {
      gitea: [
        {
          host: GITEA_HOST,
          username: GITEA_USERNAME,
          password: GITEA_TOKEN,
        },
      ],
    },
  });

  const integrations = ScmIntegrations.fromConfig(config);

  const repoUrl = `${GITEA_HOST}?owner=${GITEA_USERNAME}&repo=${TEST_REPO}`;

  // --- gitea:webhook ---
  console.log('');
  console.log('--- gitea:webhook ---');

  const webhookAction = createGiteaWebhookAction({ integrations });

  await runTest('Creates a webhook via handler', async () => {
    const mockContext = createMockContext({
      repoUrl,
      webhookUrl: 'https://webhook.site/test',
      webhookSecret: 'test-secret',
      insecureSsl: false,
      events: ['push'],
    });

    await webhookAction.handler(mockContext);

    assert(mockContext.output.mock.calls.length > 0, 'should call output');
    const idCall = mockContext.output.mock.calls.find((c: any[]) => c[0] === 'hookId');
    assert(idCall, 'should output hookId');
    assert(typeof idCall[1] === 'number', 'hookId should be a number');
    console.log(`    Hook id: ${idCall[1]}`);

    // Clean up
    await api(`/repos/${GITEA_USERNAME}/${TEST_REPO}/hooks/${idCall[1]}`, { method: 'DELETE' });
  });

  // --- gitea:branch-protection ---
  console.log('');
  console.log('--- gitea:branch-protection ---');

  const bpAction = createGiteaBranchProtectionAction({ integrations });

  await runTest('Applies branch protection via handler', async () => {
    const mockContext = createMockContext({
      repoUrl,
      branchName: 'main',
      requiredApprovingReviewCount: 1,
      requiredStatusCheckContexts: ['ci/build'],
    });

    await bpAction.handler(mockContext);

    const branchCall = mockContext.output.mock.calls.find((c: any[]) => c[0] === 'branchName');
    assert(branchCall, 'should output branchName');
    assert(branchCall[1] === 'main', 'branchName should be main');
  });

  // --- publish:gitea:pull-request ---
  console.log('');
  console.log('--- publish:gitea:pull-request ---');

  const prAction = createGiteaPullRequestAction({ integrations });

  // Create a temp workspace with a file for the PR
  const workspacePath = fs.mkdtempSync('/tmp/gitea-test-');
  fs.writeFileSync(path.join(workspacePath, 'test-file.txt'), 'Hello from gitea test');

  await runTest('Creates PR via handler', async () => {
    const branchName = `test/handler-${Date.now()}`;

    const mockContext = createMockContext({
      repoUrl,
      title: 'Handler integration test',
      branchName,
      sourcePath: '.',
    }, workspacePath);

    await prAction.handler(mockContext);

    const urlCall = mockContext.output.mock.calls.find((c: any[]) => c[0] === 'pullRequestUrl');
    assert(urlCall, 'should output pullRequestUrl');
    assert(urlCall[1], 'pullRequestUrl should be non-empty');
    console.log(`    PR URL: ${urlCall[1]}`);

    const branchCall = mockContext.output.mock.calls.find((c: any[]) => c[0] === 'branchName');
    assert(branchCall, 'should output branchName');

    // Clean up: delete branch
    try {
      await api(`/repos/${GITEA_USERNAME}/${TEST_REPO}/git/refs/branches/${branchName}`, {
        method: 'DELETE',
      });
    } catch (error) {
      console.warn(`    Failed to delete test branch during cleanup: ${error}`);
    }
  });

  // Cleanup workspace
  fs.rmSync(workspacePath, { recursive: true });

  console.log('');
  console.log('='.repeat(40));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(40));

  await cleanupRepo();

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
