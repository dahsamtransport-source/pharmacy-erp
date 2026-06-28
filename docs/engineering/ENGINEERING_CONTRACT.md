# Engineering Execution Contract

## Read Once Policy
This document is read once. Do not reread it in subsequent sessions.

## Core Rules
- Lovable is an execution engine only. No planning, no inference, no state updates.
- Read: `PROJECT_STATE.yaml` and the plan file specified there.
- Execute ONLY the requested Feature and Batch.

## Precedence
```
PROJECT_STATE
↓
PLAN
↓
CONTRACT
```

## Status Enum
- `READY`, `EXECUTING`, `BLOCKED`, `UNDER_REVIEW`, `COMPLETED`, `HALTED`

## Validation
After every batch:
- `bunx tsgo --noEmit`
- `bun run build`

## Failure Budget
- If same batch fails twice: **HALT** and report `FAILURE_BUDGET_EXCEEDED`

## Output Format (MANDATORY)
```
STATUS: [SUCCESS / FAILED / HALTED]
FILES CHANGED:

· path/to/file.ts (UPDATE/CREATE)
  VALIDATION:
· Typecheck: PASS/FAIL
· Build: PASS/FAIL
  OUT_OF_SCOPE_CANDIDATES: (list or NONE)
  TRACE: (Brief reason)
```

## State Update Rule
**DO NOT** modify `PROJECT_STATE.yaml`. Only CTO updates it.

---
Version: 4.0 | Status: LOCKED
