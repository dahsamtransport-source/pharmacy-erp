# Engineering Execution Contract

## Read Once Policy
This document is read once at the start of Phase 1. Do not reread it in subsequent sessions unless explicitly instructed.

## Core Rules
- This system is an execution framework for pharmacy ERP development.
- Read: `PROJECT_STATE.yaml` and the plan file specified there.
- Execute ONLY the requested Feature and Batch in the exact order specified.
- No planning, no inference, no unscheduled state updates.

## Precedence (Conflict Resolution)
```
PROJECT_STATE.yaml (immutable)
↓
Current Plan File (phase-N.yaml)
↓
This Contract
```

## Status Enum
- `READY` - Batch ready for execution
- `EXECUTING` - Currently in progress
- `BLOCKED` - Blocked by external dependency or error
- `UNDER_REVIEW` - Awaiting code review
- `COMPLETED` - Successfully merged
- `HALTED` - Critical failure, manual intervention required

## Validation Requirements
After every batch completion:
```bash
bunx tsgo --noEmit  # TypeScript check
bun run build       # Build verification
```

## Failure Budget
- **First failure**: Debug and re-execute same batch
- **Second failure on same batch**: **HALT immediately**
- Report status: `FAILURE_BUDGET_EXCEEDED`
- Stop all execution until CTO intervention

## Output Format (MANDATORY)
Every batch must produce output in this exact format:
```
STATUS: [SUCCESS / FAILED / HALTED]

FILES CHANGED:
· path/to/file.ts (CREATE/UPDATE/DELETE)
· path/to/another.ts (CREATE/UPDATE/DELETE)

VALIDATION:
· TypeCheck: PASS/FAIL
· Build: PASS/FAIL

OUT_OF_SCOPE_CANDIDATES: 
  - None
  - OR: List of files touched outside batch scope

TRACE:
  Brief summary of changes and any issues encountered.
```

## State Immutability Rule
**DO NOT** modify `PROJECT_STATE.yaml`. Only the CTO updates it.
- Violation of this rule halts execution
- Triggers manual review before continuation

## Escalation Path
1. First blocking issue → Log in TRACE
2. Second blocking issue → Set status BLOCKED
3. Failure budget exceeded → Set status HALTED
4. Await CTO instruction before proceeding

---
**Version**: 4.0 | **Status**: LOCKED | **Effective**: Phase 1 & beyond
