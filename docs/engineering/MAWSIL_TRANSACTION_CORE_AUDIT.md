# Mawsil Transaction Core — Audit & Baseline

## Verified discovery and audit — 2026-09-09

Status: **NOT READY**. The historical findings below describe a foundation,
not a completed transaction core.

- Authenticated GitHub discovery listed eight accessible repositories across
  `dahsamtransport-source` and `muslly-pharmcy`, with no further repository page.
  All returned branches and open/closed PRs were inspected.
- `dahsamtransport-source/pharmacy-erp` uniquely matched both requested branch
  names and PR #4 (`mawsil/transaction-core-ai` into `feat/mawsil-ai-os-mvp`).
- Audited head: `ea0b0250a7eb1f027b82a8f12ef68b21061d0a39`;
  base: `cbf2c5fa5ce95b0850f697a0fbc6af18f50b3d74`. PR #4 was open and mergeable,
  with `mergeable_state=unstable`. The existing branch was cloned unchanged.
- GitHub Actions run `34310626990`, check `102336376599`, did not start:
  GitHub reports the account is locked due to a billing issue. This is not a
  typecheck, build, or test result. The account owner must resolve the billing
  restriction before hosted CI can establish readiness.

### Confirmed code and migration findings

1. `/api/ai/orchestrate` has no authentication, membership, role checks, input
   length limit, or rate limiting before the model invocation. Do not expose it
   as a production business endpoint in its present state.
2. The agent prepares plans only. No atomic sales/purchases/payments/expenses
   service or RPC exists. Its interruption state is returned to the caller;
   no persisted, payload-bound approval/resume workflow exists.
3. `sync_sale_inventory` inserts movements for **all** items of the sale on
   every item insertion. Inserting another item can repeat an existing movement
   idempotency key and fail. It does not update or lock `stock_quantity`.
4. RLS permits direct stock/balance changes and management deletion of financial
   rows and inventory movements. Policies on child items verify parent tenancy
   but do not enforce that the referenced product belongs to that tenant.
5. An approval insert may supply `status=approved` and reviewer fields: the
   policy checks only membership and `requested_by`. Approval consumption is
   not bound to a canonical payload, expiry, or a single execution.
6. Sales have no unique idempotency constraint; other tables have isolated keys
   but no operation-wide request hash/result store. Concurrent execution,
   rollback, balances, reversals, and tenant-safe foreign keys are unverified.
7. Audit rows have an UPDATE/DELETE rejection trigger, but lack the complete
   trusted actor/role/request/approval fields required by this task. Append-only
   audit behavior, grants, and privileged execution still need runtime tests.
8. Dependencies use `latest`, there is no lockfile, and no unit, database,
   integration, API, concurrency, or E2E test commands exist at this head.
9. The CodeQL workflow used translated workflow keys, an undefined language
   matrix, and invalid executable content. It is corrected to the documented
   JavaScript/TypeScript workflow with `build-mode: none` and limited grants.

### Access and verification boundaries

- GitHub API and Git access are verified through the existing Git Credential
  Manager account. No new repository or duplicate PR was created.
- No Supabase/Database or OpenAI Platform connector tools are exposed in this
  session, and no Supabase/database/OpenAI environment variables were present.
  No local `.env*` file was found in this checkout. This does not establish the
  absence of credentials or projects in the user's deployment environment.
- Docker CLI exists, but its Linux engine socket was unavailable. No migration
  was applied, no production data changed, and no database test has passed.
- Findings above come from versioned SQL; deployed schema, grants, RLS, drift,
  and production configuration have **not** been inspected.
- Scope remains Transaction Core, Supabase/database, authorization, restricted
  AI tools, and CI/CD. sync.labs and Media are excluded.

### Remaining execution gates

Implement and test atomic domain operations, ledger/source-of-truth rules,
DB-enforced idempotency, trusted backend identity, tenant-safe constraints,
append-only audit, persisted approvals, reversal transactions, narrow AI tools,
negative security and real concurrency tests, and deployment verification.
The original readiness checklist remains unsatisfied; discovery and a workflow
repair do not establish production readiness.

## Baseline

The implementation baseline for Mawsil is `feat/mawsil-ai-os-mvp` in `dahsamtransport-source/pharmacy-erp`.
This work continues from that branch without changing `main`.

## Findings

### 1. AI orchestration

The previous AI layer was a keyword classifier only. It could identify broad business areas, but it did not produce a validated transaction plan, enforce an approval boundary, or call a model.

Status after this change: **improved**.

- OpenAI Agents SDK is now the orchestration runtime.
- Structured output is validated with Zod.
- The model is explicitly forbidden from direct SQL/database access.
- Sensitive transaction preparation is behind a human approval boundary.
- The exposed HTTP endpoint is server-side only and never returns the API key.

### 2. Transaction execution safety

No financial, debt, inventory, purchase, or supplier mutation is wired directly to the agent.

This is intentional. The next transaction-core step must expose narrow server-side tools backed by Postgres RPC/functions with authorization and idempotency checks. The LLM must never receive a generic database tool.

### 3. Multi-tenant security

The existing migrations already establish `merchant_id` tenancy, membership checks, and RLS foundations. Before production, policies must still be tightened from broad member-level `FOR ALL` access to role-specific operations for sensitive mutations.

### 4. Ledger/source-of-truth risk

The existing schema contains both summary balances/stock fields and ledger-style movement/payment tables. The production invariant should make ledger records the source of truth and derive summaries from them, with controlled reconciliation paths.

### 5. Required next hardening

1. Add role-aware Postgres RPCs for sales, inventory movements, payments, purchases, and debt adjustments.
2. Enforce idempotency at the RPC boundary.
3. Add financial/inventory invariants and RLS regression tests.
4. Persist HITL approval requests in `approval_requests` and bind them to an exact transaction hash/payload.
5. Add an authenticated UI flow for approving/rejecting pending operations.
6. Add model/evaluation tests for Arabic, Yemeni terminology, ambiguity, and adversarial instructions.

## Safety rule

The agent may propose. The application validates. The database authorizes. Human approval is required for high-impact operations. Audit logging records the final action.
