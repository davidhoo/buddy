# Buddy Python Core Alignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align Buddy core prompt assembly, role handoff, session seeding, context tracking, and round-window behavior with buddy-python.

**Architecture:** Keep the native TypeScript implementation, but make buddy-python the behavioral source of truth for the actor loop. The macOS runner will derive implementer/reviewer handoff from task settings, build prompts with the buddy-python sections and language rule, and maintain the same compatible state fields.

**Tech Stack:** Electron main process, TypeScript, Zod schemas, Vitest unit tests.

---

### Task 1: Prompt Parity

**Files:**
- Modify: `src/main/buddy/prompts.ts`
- Test: `tests/unit/main/buddy-prompts.test.ts`

**Steps:**
1. Add failing tests for buddy-python prompt sections: Buddy Message Protocol, runtime settings, role-specific implementer/reviewer instruction, pending break instruction, recent transcript selection, and language rule as the last line.
2. Implement the TypeScript prompt builder with the same section order and helper behavior as `buddy3/prompts.py`.
3. Verify the focused prompt tests pass.

### Task 2: State Schema And Task Creation Parity

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/buddy/schemas.ts`
- Modify: `src/main/buddy/store.ts`
- Test: `tests/unit/main/buddy-store.test.ts`
- Test: `tests/unit/main/buddy-schemas.test.ts`

**Steps:**
1. Add failing tests that a new task starts at round `0`, uses the configured implementer as `next_actor`, and carries buddy-python compatible fields such as `rounds_in_window`, `context_hash`, `context_sent`, seed ids, and last error aliases.
2. Extend schemas and shared types without breaking legacy nullable reads.
3. Initialize new task state from normalized settings and preserve old task compatibility.
4. Verify focused store/schema tests pass.

### Task 3: Runner Handoff And Round Window Parity

**Files:**
- Modify: `src/main/buddy/runner.ts`
- Test: `tests/unit/main/buddy-runner.test.ts`
- Test: `tests/unit/main/buddy-runner-launcher.test.ts`
- Test: `tests/unit/main/buddy-countdown.test.ts`

**Steps:**
1. Add failing tests for implementer/reviewer handoff, `role_mode=codex_implements`, OpenCode/Kimi pair handoff, seed session usage, `rounds_in_window` increments, and max-round pause.
2. Replace hard-coded `claude <-> codex` handoff with settings-derived handoff.
3. Update completion flow to match buddy-python: increment round/window counters, write context hash/sent, pause at max rounds, and use state next actor for break confirmation.
4. Update countdown pause/skip to store selected next actor and event payloads like buddy-python.
5. Verify focused runner/countdown tests pass.

### Task 4: Verification

**Files:**
- All touched files

**Steps:**
1. Run focused tests for prompts/store/schema/runner/countdown.
2. Run full unit test suite.
3. Run TypeScript typecheck.
4. Review git diff against this plan and report any remaining deltas.
