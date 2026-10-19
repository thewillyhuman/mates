import { describe, expect, it } from 'vitest';
import { candidateRepoId, fakeScenario } from './prepare.js';

const scenarios = {
  intake: ['intake_needs_clarification', 'intake_implementable'],
  implementer: ['impl_iter1_green', 'impl_iter2_addressed'],
  reviewer: ['review_changes_requested_2_blocking', 'review_approve'],
};

describe('fakeScenario', () => {
  it('indexes implementer and reviewer lists by iteration, repeating the last entry', () => {
    expect(fakeScenario(scenarios, { mate: 'implementer', iteration: 1 })).toEqual({
      scenario: 'impl_iter1_green',
      patch: 'impl_iter1_green.patch',
    });
    expect(fakeScenario(scenarios, { mate: 'implementer', iteration: 2 })).toEqual({
      scenario: 'impl_iter2_addressed',
      patch: 'impl_iter2_addressed.patch',
    });
    expect(fakeScenario(scenarios, { mate: 'implementer', iteration: 5 })).toEqual({
      scenario: 'impl_iter2_addressed',
      patch: 'impl_iter2_addressed.patch',
    });
    expect(fakeScenario(scenarios, { mate: 'reviewer', iteration: 2 })).toEqual({
      scenario: 'review_approve',
      patch: null,
    });
  });

  it('indexes intake by prior passes and gives no patch to empty or budget scenarios', () => {
    expect(fakeScenario(scenarios, { mate: 'intake', iteration: 0 }, 0).scenario).toBe(
      'intake_needs_clarification',
    );
    expect(fakeScenario(scenarios, { mate: 'intake', iteration: 0 }, 1).scenario).toBe(
      'intake_implementable',
    );
    expect(
      fakeScenario(
        { ...scenarios, implementer: ['impl_empty_diff'] },
        { mate: 'implementer', iteration: 1 },
      ),
    ).toEqual({ scenario: 'impl_empty_diff', patch: null });
    expect(
      fakeScenario(
        { ...scenarios, implementer: ['impl_budget_exceeded'] },
        { mate: 'implementer', iteration: 1 },
      ).patch,
    ).toBeNull();
  });
});

describe('candidateRepoId', () => {
  it('returns the single repo owning the Jira project, else null', () => {
    const manifest = {
      repos: [
        { id: 'a', jira_projects: ['API'] },
        { id: 'b', jira_projects: ['API', 'WEB'] },
        { id: 'c', jira_projects: ['BILL'] },
      ],
    };
    expect(candidateRepoId(manifest, 'BILL')).toBe('c');
    expect(candidateRepoId(manifest, 'API')).toBeNull();
    expect(candidateRepoId(manifest, 'NOPE')).toBeNull();
  });
});
