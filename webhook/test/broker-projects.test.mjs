import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';
import { fakeGitHub } from './support/fakes.mjs';

const { createTokenBroker } = await import('../src/broker.ts');

const REPO = 'example-org/valkey';
const OTHER = 'example-org/valkey-glide';
const INSTALLATION = 42;

function setup(projectRepos) {
  const issued = [];
  const logs = [];
  const broker = createTokenBroker({
    allowedRepos: [REPO, OTHER],
    ...(projectRepos ? { projectRepos } : {}),
    appApi: async () => fakeGitHub({
      [`GET repos/${REPO}/installation`]: { status: 200, json: { id: INSTALLATION, account: { login: 'example-org' } } },
      [`GET repos/${OTHER}/installation`]: { status: 200, json: { id: INSTALLATION, account: { login: 'example-org' } } },
    }),
    issueToken: async (request) => {
      issued.push(request);
      return { token: 'ghs_test', expiresAt: '2026-10-13T13:00:00Z' };
    },
    log: (line) => logs.push(line),
    warn: (line) => logs.push(line),
  });
  return { broker, issued, logs };
}

test('a projects token carries organization Projects write and only reads the pull request', async () => {
  const { broker, issued } = setup([REPO]);
  assert.equal((await broker({ installation_id: INSTALLATION, repo: REPO, projects: true })).token, 'ghs_test');
  assert.deepEqual(issued, [{
    installationId: INSTALLATION,
    repositoryNames: ['valkey'],
    permissions: { organization_projects: 'write', pull_requests: 'read', metadata: 'read' },
  }]);
});

test('a projects token is refused for a repository without backport boards, and by default', async () => {
  for (const projectRepos of [[REPO], undefined]) {
    const { broker, issued, logs } = setup(projectRepos);
    const repo = projectRepos ? OTHER : REPO;
    assert.deepEqual(await broker({ installation_id: INSTALLATION, repo, projects: true }), { error: `repo ${repo} has no backport boards configured` });
    assert.deepEqual(issued, []);
    assert.match(logs.join('\n'), /refused projects token/);
  }
});

test('a review token is unchanged on a repository with backport boards', async () => {
  const { broker, issued } = setup([REPO]);
  await broker({ installation_id: INSTALLATION, repo: REPO });
  assert.deepEqual(issued[0].permissions, { pull_requests: 'write', metadata: 'read' });
});
