/**
 * Adds a pull request to the backport project boards of the release lines
 * its review says need the fix.
 *
 * valkey-io/valkey-ci-agent keeps one GitHub Projects v2 board per release
 * branch (its repos.yml) and its backport sweep cherry-picks every merged
 * pull request whose item on that board has Status "To be backported".
 * This puts the pull request there, with that status, so a fix the review
 * marks for backport is picked up once it merges.
 *
 * It only adds. A board the pull request is already on, archived items
 * included, is left alone, so a status a maintainer set is never changed
 * and an item a maintainer removed by archiving is not brought back.
 */

/** One repository's boards: the organization that owns them and the board number per release branch. */
export interface BackportProjectsConfig {
  readonly owner: string;
  readonly boards: Readonly<Record<string, number>>;
}

/** The field and value the ci-agent sweep reads (scripts/backport/sweep.py). */
export const BACKPORT_STATUS_FIELD = 'Status';
export const BACKPORT_STATUS_VALUE = 'To be backported';

export interface AddedBoard {
  readonly branch: string;
  readonly number: number;
  readonly url: string;
}

export interface BackportBoards {
  /** Adds the pull request to each listed branch's board it is not on yet. Returns the boards it was added to. */
  add(branches: readonly string[]): Promise<AddedBoard[]>;
}

export type GraphQl = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      projectItems(first: 100, includeArchived: true) {
        pageInfo { hasNextPage }
        nodes { project { number owner { ... on Organization { login } } } }
      }
    }
  }
}`;

const BOARD_QUERY = `query($owner: String!, $number: Int!) {
  organization(login: $owner) {
    projectV2(number: $number) {
      id
      field(name: "${BACKPORT_STATUS_FIELD}") { ... on ProjectV2SingleSelectField { id options { id name } } }
    }
  }
}`;

const ADD_ITEM = `mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}`;

const SET_STATUS = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) {
    projectV2Item { id }
  }
}`;

interface PrData {
  repository?: { pullRequest?: {
    id: string;
    projectItems: {
      pageInfo: { hasNextPage: boolean };
      nodes: { project?: { number: number; owner?: { login?: string } } | null }[];
    };
  } | null } | null;
}

interface BoardData {
  organization?: { projectV2?: {
    id: string;
    field?: { id?: string; options?: { id: string; name: string }[] } | null;
  } | null } | null;
}

/** Status option names compare as the ci-agent compares them: trimmed, case-insensitive. */
const normalize = (s: string): string => s.trim().toLowerCase();

export function boardUrl(owner: string, number: number): string {
  return `https://github.com/orgs/${owner}/projects/${number}`;
}

export function createBackportBoards(opts: {
  graphql: GraphQl;
  config: BackportProjectsConfig;
  owner: string;
  repo: string;
  prNumber: number;
  log?: (line: string) => void;
}): BackportBoards {
  const { graphql, config } = opts;
  const log = opts.log ?? console.warn;
  const tag = `[backport-boards] ${opts.owner}/${opts.repo}#${opts.prNumber}`;

  async function addOne(branch: string, number: number, contentId: string): Promise<AddedBoard | null> {
    const board = (await graphql(BOARD_QUERY, { owner: config.owner, number }) as BoardData).organization?.projectV2;
    const option = board?.field?.options?.find((o) => normalize(o.name) === normalize(BACKPORT_STATUS_VALUE));
    if (!board || !board.field?.id || !option) {
      log(`${tag}: board ${config.owner}/${number} for ${branch} has no ${BACKPORT_STATUS_FIELD} option "${BACKPORT_STATUS_VALUE}"; not added`);
      return null;
    }
    const added = await graphql(ADD_ITEM, { projectId: board.id, contentId }) as { addProjectV2ItemById: { item: { id: string } } };
    await graphql(SET_STATUS, {
      projectId: board.id, itemId: added.addProjectV2ItemById.item.id, fieldId: board.field.id, optionId: option.id,
    });
    return { branch, number, url: boardUrl(config.owner, number) };
  }

  return {
    async add(branches) {
      const targets = [...new Set(branches)].filter((b) => Object.hasOwn(config.boards, b));
      if (targets.length === 0) return [];

      const pr = (await graphql(PR_QUERY, { owner: opts.owner, repo: opts.repo, number: opts.prNumber }) as PrData).repository?.pullRequest;
      if (!pr) throw new Error(`${tag}: pull request not found`);
      // An unseen page could hold the board. Adding returns the existing
      // item, and setting its status would overwrite a maintainer's.
      if (pr.projectItems.pageInfo.hasNextPage) {
        log(`${tag}: on more than 100 projects; not adding to any board`);
        return [];
      }
      const owner = normalize(config.owner);
      const present = new Set(pr.projectItems.nodes
        .filter((n) => n.project && normalize(n.project.owner?.login ?? '') === owner)
        .map((n) => n.project!.number));

      const added: AddedBoard[] = [];
      for (const branch of targets) {
        const number = config.boards[branch]!;
        if (present.has(number)) continue;
        try {
          const result = await addOne(branch, number, pr.id);
          if (result) added.push(result);
        } catch (err) {
          log(`${tag}: adding to board ${config.owner}/${number} for ${branch} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return added;
    },
  };
}

/** The review-state line naming the boards this run added the pull request to. */
export function renderAddedBoards(added: readonly AddedBoard[]): string | null {
  if (added.length === 0) return null;
  const links = added.map((b) => `[${b.branch}](${b.url})`).join(', ');
  return `**Backport boards:** added to ${links} as "${BACKPORT_STATUS_VALUE}".`;
}
