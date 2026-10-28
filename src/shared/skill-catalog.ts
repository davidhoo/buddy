/** Offline curated skill cards for the library Discover section. Replaceable later with a remote catalog. */

export interface FeaturedSkill {
  id: string
  name: string
  description: string
  /** Short source badge shown on the card. */
  source: string
  version: string
  /** Relative files under the skill directory. Must include SKILL.md. */
  files: Record<string, string>
}

export const FEATURED_SKILLS: FeaturedSkill[] = [
  {
    id: 'buddy-review-checklist',
    name: 'review-checklist',
    description: 'Walk a change with a short correctness, tests, and risk checklist before you approve.',
    source: 'Buddy',
    version: '1.0.0',
    files: {
      'SKILL.md': `---
name: review-checklist
description: Review a code change with a short correctness, tests, and risk checklist.
---

# Review checklist

When reviewing a change:

1. Restate the intent in one sentence.
2. Check correctness against the stated goal, not only style.
3. Look for missing tests for new branches and failure paths.
4. Call out security, data loss, and rollback risk.
5. End with Approve, Request changes, or Needs clarification.
`
    }
  },
  {
    id: 'buddy-commit-message',
    name: 'commit-message',
    description: 'Draft a concise conventional commit subject and body from the staged diff.',
    source: 'Buddy',
    version: '1.0.0',
    files: {
      'SKILL.md': `---
name: commit-message
description: Draft a concise conventional commit message from the staged change.
---

# Commit message

Write one subject line under 72 characters using \`type(scope): summary\`.
Prefer types: feat, fix, refactor, docs, test, chore.
Add a short body only when the why is not obvious from the subject.
Do not invent changes that are not in the diff.
`
    }
  },
  {
    id: 'buddy-explain-change',
    name: 'explain-change',
    description: 'Explain what a diff does in plain language for a teammate who has not read the code.',
    source: 'Buddy',
    version: '1.0.0',
    files: {
      'SKILL.md': `---
name: explain-change
description: Explain a diff in plain language for someone who has not read the code.
---

# Explain change

Summarize:
- What changed
- Why it likely changed
- What a reviewer should verify
Keep it short. Avoid restating every line.
`
    }
  }
]

export function findFeaturedSkill(id: string): FeaturedSkill | undefined {
  return FEATURED_SKILLS.find((entry) => entry.id === id)
}

export function catalogRepositoryKey(id: string): string {
  return `buddy-catalog:${id}`
}
