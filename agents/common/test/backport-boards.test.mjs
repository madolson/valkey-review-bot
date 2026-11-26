import assert from 'node:assert/strict';
import test from 'node:test';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import './support/ts-resolve.mjs';
import { ScriptedModel, toolTurn, textTurn } from './support/scripted-model.mjs';

const { createBackportBoards, BACKPORT_STATUS_VALUE } = await import('../src/backport-boards.ts');
const { buildSkipTool, createTerminalGate } = await import('../src/tools/gh.ts');
const { loadEnv } = await import('../src/config.ts');
const { createReviewHandler } = await import('../src/run-agent.ts');

// The valkey-io/valkey boards in valkey-io/valkey-ci-agent's repos.yml.
const config = { owner: 'valkey-io', boards: { '8.1': 14, '9.0': 18, '9.1': 41 } };

/**
 * A GraphQL endpoint holding the PR's current project items and each
 * board's Status options. Records every call.
 */
function fakeGraphql({ onBoards = [], options = ['Todo', 'In Progress', 'To be backported', 'Done'] } = {}) {
  const calls = [];
  const graphql = async (query, vars) => {
    calls.push({ query, vars });
    if (query.includes('pullRequest(number')) {
      return { repository: { pullRequest: {
        id: 'PR_node',
        projectItems: {
          pageInfo: { hasNextPage: false },
          nodes: onBoards.map((number) => ({ project: { number, owner: { login: 'valkey-io' } } })),
        },
      } } };
    }
    if (query.includes('projectV2(number')) {
      return { organization: { projectV2: {
        id: `P_${vars.number}`,
        field: { id: `F_${vars.number}`, options: options.map((name) => ({ id: `${vars.number}:${name}`, name })) },
      } } };
    }
    if (query.includes('addProjectV2ItemById')) return { addProjectV2ItemById: { item: { id: `I_${vars.projectId}` } } };
    if (query.includes('updateProjectV2ItemFieldValue')) return { updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.itemId } } };
    throw new Error(`unexpected query ${query}`);
  };
  const added = () => calls.filter((c) => c.query.includes('addProjectV2ItemById')).map((c) => c.vars.projectId);
  const statuses = () => calls.filter((c) => c.query.includes('updateProjectV2ItemFieldValue')).map((c) => c.vars);
  return { graphql, calls, added, statuses };
}

const boardsFor = (g, log = () => {}) => createBackportBoards({
  graphql: g.graphql, config, owner: 'valkey-io', repo: 'valkey', prNumber: 7, log,
});

test('adds the PR to the board of each release line the backport needs, as "To be backported"', async () => {
  const g = fakeGraphql();
  const added = await boardsFor(g).add(['8.1', '9.0']);
  assert.deepEqual(added, [
    { branch: '8.1', number: 14, url: 'https://github.com/orgs/valkey-io/projects/14' },
    { branch: '9.0', number: 18, url: 'https://github.com/orgs/valkey-io/projects/18' },
  ]);
  assert.deepEqual(g.added(), ['P_14', 'P_18']);
  assert.deepEqual(g.statuses(), [
    { projectId: 'P_14', itemId: 'I_P_14', fieldId: 'F_14', optionId: `14:${BACKPORT_STATUS_VALUE}` },
    { projectId: 'P_18', itemId: 'I_P_18', fieldId: 'F_18', optionId: `18:${BACKPORT_STATUS_VALUE}` },
  ]);
});

test('a board the PR is already on is left alone, status included', async () => {
  const g = fakeGraphql({ onBoards: [18, 99] });
  const added = await boardsFor(g).add(['8.1', '9.0']);
  assert.deepEqual(added.map((b) => b.branch), ['8.1']);
  assert.deepEqual(g.added(), ['P_14']);
  assert.deepEqual(g.statuses().map((s) => s.projectId), ['P_14']);

  const all = fakeGraphql({ onBoards: [14, 18] });
  assert.deepEqual(await boardsFor(all).add(['8.1', '9.0']), []);
  assert.deepEqual(all.added(), []);
  assert.deepEqual(all.statuses(), []);
});

test('a release line with no board is skipped without a GitHub call', async () => {
  const g = fakeGraphql();
  assert.deepEqual(await boardsFor(g).add(['7.2', '8.0']), []);
  assert.equal(g.calls.length, 0);

  const mixed = fakeGraphql();
  assert.deepEqual((await boardsFor(mixed).add(['7.2', '9.1'])).map((b) => b.number), [41]);
});

test('a board without the "To be backported" status is not added to', async () => {
  const g = fakeGraphql({ options: ['Todo', 'Done'] });
  const logged = [];
  assert.deepEqual(await boardsFor(g, (l) => logged.push(l)).add(['9.0']), []);
  assert.deepEqual(g.added(), []);
  assert.match(logged.join('\n'), /has no Status option "To be backported"/);
});

test('a failure on one board does not stop the others', async () => {
  const g = fakeGraphql();
  const inner = g.graphql;
  g.graphql = async (query, vars) => {
    if (query.includes('addProjectV2ItemById') && vars.projectId === 'P_14') throw new Error('Resource not accessible by integration');
    return inner(query, vars);
  };
  const logged = [];
  const added = await boardsFor(g, (l) => logged.push(l)).add(['8.1', '9.0']);
  assert.deepEqual(added.map((b) => b.number), [18]);
  assert.match(logged.join('\n'), /board valkey-io\/14 for 8\.1 failed: Resource not accessible/);
});

const state = (backport) => ({
  status: 'needs_work', summary: 'One open finding.', risk: 'low', risk_reason: 'Error path only.',
  findings: [], backport, direction: '',
});

function skipTool(backportBoards) {
  const bodies = [];
  const deps = {
    ctx: { owner: 'valkey-io', repo: 'valkey', prNumber: 7, headSha: 'abc123', upstreamRepo: 'valkey-io/valkey',
      releaseLines: [{ branch: '8.1' }, { branch: '9.0' }] },
    tokens: { get: async () => 'token' },
    octokit: {},
    stateWriter: { write: async (body) => { bodies.push(body); return { id: 1, url: 'https://github.com/state' }; } },
    terminalGate: createTerminalGate(),
    backportBoards,
  };
  return { skip: buildSkipTool(deps), bodies };
}

test('the review-state comment names the boards the run added the PR to', async () => {
  const g = fakeGraphql({ onBoards: [18] });
  const t = skipTool(boardsFor(g));
  await t.skip.invoke({ reason: 'nothing new', state: state({ verdict: 'needed', branches: ['8.1', '9.0'], reason: 'Old bug.' }) });
  const lines = t.bodies[0].split('\n').filter((l) => l.startsWith('**Backport boards:**'));
  assert.deepEqual(lines, ['**Backport boards:** added to [8.1](https://github.com/orgs/valkey-io/projects/14) as "To be backported".']);
});

test('nothing is added and no line is written when no backport is needed', async () => {
  for (const backport of [
    { verdict: 'not_needed', branches: [], reason: 'New code.' },
    { verdict: 'unclear', branches: [], reason: 'Could not fetch.' },
  ]) {
    const g = fakeGraphql();
    const t = skipTool(boardsFor(g));
    await t.skip.invoke({ reason: 'nothing new', state: state(backport) });
    assert.equal(g.calls.length, 0);
    assert.doesNotMatch(t.bodies[0], /Backport boards/);
  }
});

test('a board failure still writes the review-state comment', async () => {
  const t = skipTool({ add: async () => { throw new Error('token broker refused'); } });
  const out = JSON.parse(await t.skip.invoke({ reason: 'nothing new', state: state({ verdict: 'needed', branches: ['9.0'], reason: 'Old bug.' }) }));
  assert.equal(out.ok, true);
  assert.equal(t.bodies.length, 1);
  assert.doesNotMatch(t.bodies[0], /Backport boards/);
});

const baseEnv = {
  BEDROCK_MODEL_ID: 'primary-model', FALLBACK_MODEL_ID: 'openai.fallback-model', AWS_REGION: 'us-west-2',
  MANTLE_REGION: 'us-east-1', SUMMARIZER_MODEL_ID: 'summary-model', SUMMARIZER_FALLBACK_MODEL_ID: 'openai.summary-fallback',
  ASSETS_BUCKET: 'assets', PROMPT_S3_KEY: 'prompt.md', SKILL_S3_KEY: 'skill.md', GITHUB_APP_ID: '123456',
  TOKEN_BROKER_FUNCTION: 'token-broker', WORKSPACE_ROOT: '/workspace/valkey', HEARTBEAT_TABLE: 'heartbeats',
};

test('BACKPORT_PROJECTS_JSON is off when unset and is checked when set', () => {
  assert.deepEqual(loadEnv(baseEnv).backportProjects, {});
  assert.deepEqual(
    loadEnv({ ...baseEnv, BACKPORT_PROJECTS_JSON: JSON.stringify({ 'Valkey-IO/valkey': config }) }).backportProjects,
    { 'valkey-io/valkey': config },
  );
  assert.throws(() => loadEnv({ ...baseEnv, BACKPORT_PROJECTS_JSON: '[]' }), /must be an object/);
  assert.throws(() => loadEnv({ ...baseEnv, BACKPORT_PROJECTS_JSON: JSON.stringify({ 'valkey-io/valkey': { owner: 'valkey-io', boards: { '9.0': 'x' } } }) }), /must be a project number/);
});

/** One review run; returns what assembleTools got and the token sources the run asked for. */
async function runWith(t, envOverrides) {
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async () => ({}));
  const ctx = {
    owner: 'valkey-io', repo: 'valkey', prNumber: 7, headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'm'.repeat(40),
    headRef: 'fix', baseRef: 'unstable', author: 'a', title: 'Fix', body: '', state: 'open',
    additions: 1, deletions: 1, changedFiles: 1, fileList: ['src/server.c'],
    existingReviews: [], existingReviewComments: [], existingIssueComments: [],
    previousState: null, upstreamRepo: 'valkey-io/valkey', releaseLines: [{ branch: '9.0', lastCommit: '2026-09-21' }],
    workspacePath: '/workspace/valkey', diffRefSpec: 'm..h',
  };
  const sources = [];
  let assembled;
  const handler = createReviewHandler({
    env: loadEnv({ ...baseEnv, ...envOverrides }),
    systemPrompt: 'You review pull requests.',
    assembleTools: async (opts) => {
      assembled = opts;
      const deps = {
        ctx: opts.ctx, octokit: opts.octokit, tokens: opts.tokens,
        stateWriter: { write: async () => ({ id: 1, url: 'https://github.com/state' }) },
        terminalGate: createTerminalGate(opts.onTerminal),
      };
      return [buildSkipTool(deps)];
    },
    deps: {
      createModel: () => new ScriptedModel([
        toolTurn('skip_review', { reason: 'Nothing new.', state: state({ verdict: 'not_needed', branches: [], reason: 'New code.' }) }),
        textTurn('Done.'),
      ]),
      createTokenSource: (opts) => { sources.push(opts); return { get: async () => 'token' }; },
      createOctokit: () => ({ graphql: async () => ({}) }),
      prepareWorkspace: async () => ctx,
      loadGraduatedSkills: async () => [],
      createStatusComment: () => { throw new Error('no status comment'); },
    },
  });
  for await (const frame of handler({ repo: 'valkey-io/valkey', pr_number: 7, installation_id: 1, head_sha: ctx.headSha })) void frame;
  return { assembled, sources };
}

test('a repository without boards configured gets no board writer and no projects token', async (t) => {
  const r = await runWith(t, { BACKPORT_PROJECTS_JSON: JSON.stringify({ 'valkey-io/valkey-glide': config }) });
  assert.equal(r.assembled.backportBoards, undefined);
  assert.deepEqual(r.sources.map((s) => s.projects ?? false), [false]);
});

test('a repository with boards configured gets a board writer backed by a projects token', async (t) => {
  const r = await runWith(t, { BACKPORT_PROJECTS_JSON: JSON.stringify({ 'valkey-io/valkey': config }) });
  assert.equal(typeof r.assembled.backportBoards?.add, 'function');
  assert.deepEqual(r.sources.map((s) => s.projects ?? false), [false, true]);
});
