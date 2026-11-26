import { z } from 'zod';
import type { Octokit } from '@octokit/rest';
import type { PrContext } from './workspace.js';

/**
 * Labels pull requests that need a major decision under Valkey's
 * GOVERNANCE.md. On only for routes with `majorDecisionLabel`. The model
 * judges from the diff, the runtime adds the label. It only ever adds:
 * a label someone removed once is not added again, and a pull request
 * that already carries a major-decision label is left alone.
 */

export const MAJOR_DECISION_LABEL = 'major-decision-pending';
// major-decision-approved, -deferred, -pending-auto-approve: already decided or in progress.
const DECISION_LABEL_PREFIX = 'major-decision-';

export const majorDecisionSchema = z.object({
  needed: z.boolean().describe(
    'true when the PR needs a major decision by the TSC: it adds or changes a command, command argument or reply, a config or its default, an INFO or other user-visible field, a module API, the RESP protocol, the RDB or AOF format, or user-visible behavior; breaks backward compatibility; adds a data structure; changes a core data structure fundamentally; or adds or removes an external library that affects runtime behavior. false for bug fixes that restore documented behavior, refactors, tests, docs, CI and internal performance work with no user-visible change.',
  ),
  reason: z.string().max(300).describe(
    'When needed is true, one short sentence naming what in the diff makes it a major decision, with `path:line` or the command, config or field name, e.g. "Adds the `FOO` command (src/commands/foo.json)". Empty when false.',
  ),
}).describe(`Whether this PR needs the ${MAJOR_DECISION_LABEL} label. Judge from the diff at this head.`);

export type MajorDecision = z.infer<typeof majorDecisionSchema>;

export function validateMajorDecision(decision: MajorDecision): string | null {
  if (decision.needed && !decision.reason.trim()) {
    return '`major_decision.needed` is true but `major_decision.reason` is empty. Name what in the diff makes it a major decision.';
  }
  return null;
}

export type LabelOutcome = 'added' | 'present' | 'removed' | 'error';

/** Adds the label unless it is there, another major-decision label is, or someone removed it before. */
export async function applyMajorDecisionLabel(octokit: Octokit, ctx: PrContext): Promise<LabelOutcome> {
  const issue = { owner: ctx.owner, repo: ctx.repo, issue_number: ctx.prNumber };
  try {
    const { data: labels } = await octokit.issues.listLabelsOnIssue({ ...issue, per_page: 100 });
    if (labels.some((l) => l.name.startsWith(DECISION_LABEL_PREFIX))) return 'present';
    for (let page = 1; ; page++) {
      const { data: events } = await octokit.issues.listEvents({ ...issue, per_page: 100, page });
      if (events.some((e) => e.event === 'unlabeled' && (e as { label?: { name?: string } }).label?.name === MAJOR_DECISION_LABEL)) {
        return 'removed';
      }
      if (events.length < 100) break;
    }
    await octokit.issues.addLabels({ ...issue, labels: [MAJOR_DECISION_LABEL] });
    console.log(`[major-decision] labeled ${ctx.owner}/${ctx.repo}#${ctx.prNumber}`);
    return 'added';
  } catch (err) {
    console.warn(`[major-decision] labeling ${ctx.owner}/${ctx.repo}#${ctx.prNumber} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  }
}

/** The review-state line for a PR the model judged to need a major decision. */
export function majorDecisionLine(reason: string, outcome: LabelOutcome): string {
  const why = reason.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  const what = {
    added: `Labeled \`${MAJOR_DECISION_LABEL}\`; remove it if this is not one.`,
    present: 'Already labeled.',
    removed: `Not labeled again: \`${MAJOR_DECISION_LABEL}\` was removed earlier.`,
    error: `Labeling \`${MAJOR_DECISION_LABEL}\` failed.`,
  }[outcome];
  return `**Major decision:** ${why} ${what}`;
}
