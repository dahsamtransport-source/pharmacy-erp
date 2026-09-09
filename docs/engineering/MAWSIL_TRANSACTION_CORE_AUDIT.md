# Mawsil Transaction Core — Audit & Baseline

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
