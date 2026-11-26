import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { buildPostReviewTool, buildSkipTool, createTerminalGate } = await import('../src/tools/gh.ts');
const { MAJOR_DECISION_LABEL } = await import('../src/major-decision.ts');

const state = {
  status: 'needs_work',
  summary: 'Adds a command.',
  risk: 'medium',
  risk_reason: 'A new command is public API.',
  findings: [],
  backport: { verdict: 'not_needed', branches: [], reason: 'New feature.' },
  direction: '',
};

const NEW_COMMAND = { needed: true, reason: 'Adds the `FOO` command (src/commands/foo.json).' };
const BUG_FIX = { needed: false, reason: '' };

function harness({ enabled = true, labels = [], events = [], addLabelsError } = {}) {
  const added = [];
  const stateBodies = [];
  const calls = [];
  const deps = {
    ctx: { owner: 'valkey-io', repo: 'valkey', prNumber: 7, headSha: 'abc123', upstreamRepo: 'valkey-io/valkey', releaseLines: [], majorDecisionLabel: enabled },
    tokens: { get: async () => 'token' },
    octokit: {
      pulls: { createReview: async () => ({ data: { id: 1, html_url: 'https://github.com/r/1' } }) },
      issues: {
        listLabelsOnIssue: async () => { calls.push('labels'); return { data: labels.map((name) => ({ name })) }; },
        listEvents: async ({ page }) => { calls.push(`events:${page}`); return { data: page === 1 ? events : [] }; },
        addLabels: async (args) => {
          if (addLabelsError) throw addLabelsError;
          added.push(args);
          return { data: [] };
        },
      },
    },
    stateWriter: { write: async (body) => { stateBodies.push(body); return { id: 9, url: 'https://github.com/state' }; } },
    terminalGate: createTerminalGate(() => {}),
  };
  return { post: buildPostReviewTool(deps), skip: buildSkipTool(deps), added, stateBodies, calls };
}

const comment = { path: 'src/server.c', line: 10, body: 'Needs a test.' };

test('a qualifying change gets the label and the reason in the state comment', async () => {
  const h = harness();
  assert.equal(JSON.parse(await h.post.invoke({ body: '', comments: [comment], state, major_decision: NEW_COMMAND })).ok, true);
  assert.deepEqual(h.added, [{ owner: 'valkey-io', repo: 'valkey', issue_number: 7, labels: [MAJOR_DECISION_LABEL] }]);
  assert.match(h.stateBodies[0], /^\*\*Major decision:\*\* Adds the `FOO` command \(src\/commands\/foo\.json\)\. Labeled `major-decision-pending`; remove it if this is not one\.$/m);
});

test('skip_review labels too', async () => {
  const h = harness();
  await h.skip.invoke({ reason: 'nothing inline', state, major_decision: NEW_COMMAND });
  assert.equal(h.added.length, 1);
});

test('a plain bug fix is not labeled and the state comment has no major-decision line', async () => {
  const h = harness();
  await h.post.invoke({ body: '', comments: [comment], state, major_decision: BUG_FIX });
  assert.deepEqual(h.added, []);
  assert.deepEqual(h.calls, [], 'no label lookups either');
  assert.doesNotMatch(h.stateBodies[0], /Major decision/);
});

test('the label is not added again after someone removed it', async () => {
  const h = harness({
    events: [
      { event: 'labeled', label: { name: MAJOR_DECISION_LABEL } },
      { event: 'unlabeled', label: { name: MAJOR_DECISION_LABEL } },
    ],
  });
  await h.post.invoke({ body: '', comments: [comment], state, major_decision: NEW_COMMAND });
  assert.deepEqual(h.added, []);
  assert.match(h.stateBodies[0], /Not labeled again: `major-decision-pending` was removed earlier\./);
});

test('removing an unrelated label does not block it', async () => {
  const h = harness({ events: [{ event: 'unlabeled', label: { name: 'needs-doc-pr' } }] });
  await h.post.invoke({ body: '', comments: [comment], state, major_decision: NEW_COMMAND });
  assert.equal(h.added.length, 1);
});

test('a pull request with any major-decision label is left alone', async () => {
  for (const label of [MAJOR_DECISION_LABEL, 'major-decision-approved', 'major-decision-pending-auto-approve']) {
    const h = harness({ labels: [label] });
    await h.post.invoke({ body: '', comments: [comment], state, major_decision: NEW_COMMAND });
    assert.deepEqual(h.added, [], label);
    assert.match(h.stateBodies[0], /Already labeled\./, label);
  }
});

test('needed without a reason posts nothing', async () => {
  const h = harness();
  const out = await h.post.invoke({ body: '', comments: [comment], state, major_decision: { needed: true, reason: ' ' } });
  assert.match(out, /^ERROR: nothing was posted\. `major_decision\.needed` is true/);
  assert.deepEqual(h.stateBodies, []);
});

test('a failed label request still completes the review', async () => {
  const h = harness({ addLabelsError: Object.assign(new Error('Forbidden'), { status: 403 }) });
  const out = JSON.parse(await h.post.invoke({ body: '', comments: [comment], state, major_decision: NEW_COMMAND }));
  assert.equal(out.ok, true);
  assert.match(h.stateBodies[0], /Labeling `major-decision-pending` failed\./);
});

test('off for the route: the tools have no major_decision input and never label', async () => {
  const h = harness({ enabled: false });
  const schema = (t) => JSON.stringify(t.toolSpec?.inputSchema ?? t.inputSchema ?? {});
  assert.doesNotMatch(schema(h.post), /major_decision/);
  assert.doesNotMatch(schema(h.skip), /major_decision/);
  await h.post.invoke({ body: '', comments: [comment], state, major_decision: NEW_COMMAND });
  assert.deepEqual(h.added, []);
  assert.deepEqual(h.calls, []);
  assert.doesNotMatch(h.stateBodies[0], /Major decision/);

  const on = harness();
  assert.match(schema(on.post), /major_decision/);
});
