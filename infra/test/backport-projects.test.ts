import * as fs from 'node:fs';
import * as path from 'node:path';
import { backportProjects, parseDeploymentConfig } from '../lib/deployment-config';
import { fixture, functionEnv, runtimeEnv, synth } from './helpers';

const BOARDS = { owner: 'valkey-io', boards: { '8.1': 14, '9.0': 18 } };

function withBoards(): any {
  const raw = fixture();
  raw.routes[0].backportProjects = BOARDS;
  return raw;
}

function problems(raw: unknown): string {
  try {
    parseDeploymentConfig(raw);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the configuration to be rejected');
}

describe('backportProjects', () => {
  test('is off unless a route sets it', () => {
    const config = parseDeploymentConfig(fixture());
    for (const route of config.routes) expect(route).not.toHaveProperty('backportProjects');
    expect(backportProjects(config, 'valkey-review')).toEqual({});

    const s = synth();
    expect(runtimeEnv(s.template(s.stacks.reviewers.get('valkey-review')!))).not.toHaveProperty('BACKPORT_PROJECTS_JSON');
    expect(functionEnv(s.template(s.stacks.substrate), 'TokenBrokerValkeyReviewFn')).not.toHaveProperty('PROJECT_REPOS_JSON');
  });

  test("reaches only its reviewer's runtime and broker, for its own repository", () => {
    const s = synth(withBoards());
    expect(runtimeEnv(s.template(s.stacks.reviewers.get('valkey-review')!)).BACKPORT_PROJECTS_JSON)
      .toBe(JSON.stringify({ 'example-org/valkey': BOARDS }));
    expect(runtimeEnv(s.template(s.stacks.reviewers.get('valkey-glide-review')!))).not.toHaveProperty('BACKPORT_PROJECTS_JSON');
    const substrate = s.template(s.stacks.substrate);
    expect(functionEnv(substrate, 'TokenBrokerValkeyReviewFn').PROJECT_REPOS_JSON).toBe(JSON.stringify(['example-org/valkey']));
    expect(functionEnv(substrate, 'TokenBrokerValkeyGlideReviewFn')).not.toHaveProperty('PROJECT_REPOS_JSON');
  });

  test('is checked', () => {
    const bad = (change: (bp: any) => void): string => {
      const raw = withBoards();
      raw.routes[0].backportProjects = structuredClone(BOARDS);
      change(raw.routes[0].backportProjects);
      return problems(raw);
    };
    expect(bad((bp) => { bp.boards = {}; })).toContain('routes[0].backportProjects.boards must be an object mapping release branches');
    expect(bad((bp) => { bp.boards['9.0'] = 'eighteen'; })).toContain('routes[0].backportProjects.boards.9.0 must be an integer');
    expect(bad((bp) => { bp.boards['..'] = 3; })).toContain('has "..", which is not a branch name');
    expect(bad((bp) => { delete bp.owner; })).toContain('routes[0].backportProjects.owner is required');
    expect(bad((bp) => { bp.status = 'Todo'; })).toContain('routes[0].backportProjects.status is not a known setting');
  });

  test("the example turns it on for valkey with valkey-ci-agent's boards", () => {
    const file = path.join(__dirname, '..', 'deploy.config.example.json');
    const config = parseDeploymentConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
    const valkey = config.routes.find((r) => r.reviewer === 'valkey-review')!;
    // valkey-io/valkey-ci-agent repos.yml, valkey-io/valkey branches.
    expect(valkey.backportProjects).toEqual({
      owner: 'valkey-io',
      boards: { '7.2': 1, '8.0': 2, '8.1': 14, '9.0': 18, '9.1': 41, '9.2': 51 },
    });
    expect(config.routes.find((r) => r.reviewer === 'valkey-glide-review')).not.toHaveProperty('backportProjects');
  });
});
