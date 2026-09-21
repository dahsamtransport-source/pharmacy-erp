# Mawsil verification and release gates

Date: 2026-09-21. Scope: the existing execution branch and PR #4; no merge,
production migration, live financial operation, or hosted Site deployment.

## Evidence, not readiness claims

| Check | Evidence in this change | Limit |
| --- | --- | --- |
| Typecheck | `next typegen && tsc --noEmit` passed | Not runtime correctness |
| Lint | ESLint passed | Not a security audit |
| API/auth-adapter unit tests | 18 passed | Supabase and model are mocked |
| Database regression | Migrations 0001–0008, positive flows and 55 expected rejection checks passed in PGlite | Only pgcrypto extension installation is skipped; no digest stub; not independent sessions |
| Native PostgreSQL | Harness and PostgreSQL 16 CI service added | Not run locally; hosted CI success still required |
| Production build | Next.js build passed | Not deployment or browser E2E |
| Runtime dependency audit | `npm audit --omit=dev --audit-level=high` reported 0 vulnerabilities | Registry advisory snapshot, not proof of absence of vulnerabilities |
| Real Supabase | Not run | Connector/configuration and staging project are required |
| Hosted CI/CodeQL | Earlier attempts failed before steps started | Account owner must inspect Actions; do not infer a code-test failure |

The prior MD5 digest replacement in the PGlite harness has been removed. Native
SHA-256 is checked against its known `abc` vector. Fresh native PostgreSQL runs
install actual pgcrypto and apply every SQL file without replacement.

## Explicit engine contract

- Every RPC verifies `auth.uid()` and the merchant role; an absent role is denied.
- Calls serialize per merchant using a row lock, in READ COMMITTED only.
  REPEATABLE READ/SERIALIZABLE callers fail explicitly instead of reading stale
  inventory after a lock wait. This conservative design trades tenant throughput
  for simpler correctness; do not remove the lock without concurrent proof.
- Actor + merchant + key + equal JSON payload identify a replay. Committed
  results return before changed stock, debt or consumed-approval checks.
  A different actor or changed payload is rejected.
- Supplier payments, inventory adjustments and invoice reversals require an
  approved, unexpired, unused capability matching action, merchant, requester,
  payload and its SHA-256. Other current manual RPCs enforce roles and validate
  an approval if supplied; no model is connected to these write RPCs.
- The requester may also be an owner/manager reviewer. This is human confirmation,
  **not** a segregation-of-duties/two-person-control claim. A stricter business
  policy needs explicit design and migration.
- Quantity precision is at most 3 decimals; money precision is at most 2;
  NaN, infinities, missing, negative or otherwise invalid inputs fail. Duplicate
  product lines are rejected, not implicitly merged. Totals are rounded per line.
- Credit sales need a customer and cannot exceed the management-set credit
  limit. Direct balance/credit-limit changes are denied.
- Stock comes from movements, not the legacy stock cache. Client unit changes,
  repeated opening stock and positive expiry movements are denied.
- Ledger history cannot be deleted/truncated by API roles. A simulated failure
  during the final audit insert verifies rollback of the preceding invoice,
  items, debt, movement and operation records.

Public RPC signatures are preserved. `set_customer_credit_limit` is a new
owner/manager RPC with an audit trail. The `mawsil_private` schema must not be
added to the Data API's exposed schemas or granted to API roles.

## Intentional fail-closed restrictions

| Area | Current behavior | Remaining work |
| --- | --- | --- |
| Multiple currencies | Only the merchant reporting currency is accepted; existing mixed-currency transactions block new operations | Per-currency debt and settlement ledgers, reconciliation, FX rounding policy |
| Settled returns | Any paid invoice or party with payments is rejected conservatively | Invoice allocations, partial returns, refund and account entries |
| Cash/bank accounts | Only supplier-payment outflows are represented | Complete inflow/outflow ledger, opening balances, cash reconciliation; current account balance is not a complete cash position |
| Product units/batches | Ancillary writes are disabled | Verified conversion, lot allocation and expiry engine |
| AI | Planning is disabled by default, and always marked not executed | Live auth and model checks, distributed per-user/tenant rate limits, budgets, Arabic/adversarial evaluations |
| UI/Offline | Local section suggestion only | Real sign-in, data screens, approval/rejection UX, durable retry/sync queue and E2E tests |
| Sites | Existing Next.js/API project preserved | Compatible server deployment design; do not silently static-export away the API |
| Templates/Pets/sync.labs | No template/pet/media changes made | Separate concrete artifact and purpose after core readiness |

## Native PostgreSQL harness

On a disposable local test server, set `MAWSIL_TEST_DATABASE_URL` to a loopback
URL ending in `/postgres` and run:

```sh
npm run test:db:postgres
```

The harness refuses cloud hosts, query parameters and other database names.
It creates a uniquely named `mawsil_test_...` database, applies migrations,
executes the same regression suite, then opens two independent sessions for:

1. Two buyers of the final stock unit: one commit, one insufficient-stock error.
2. The same operation/key concurrently: one invoice and identical results.
3. A first writer rolling back: the waiting operation can commit safely.

A separate observer confirms that the second session actually waited on a
database lock; elapsed time alone is not treated as proof. Cleanup drops only
the database created by this run. The `anon`/`authenticated` non-login roles
are cluster-scoped test roles, so use a disposable cluster. This is not a
migration/deployment command.

## Required before production

1. Connect the intended Supabase **staging** project and verify its identity.
   Inventory deployed migrations, ownership, grants, RLS and schema drift.
   Never blindly apply altered historical migrations over an existing database.
2. Run native PostgreSQL and staging regressions, real JWT/auth failures,
   PostgREST/RLS tests and independent-session races; resolve failures.
3. Reconcile legacy mixed currencies, inconsistent balances/units and partial
   account history. Back up and exercise restore before any migration rollout.
4. Finish the missing ledgers/refunds and a real authenticated operator UI.
   Verify offline retries and human approval end-to-end.
5. Obtain successful hosted CI and CodeQL/security/dependency checks on the
   exact candidate commit; this change does not bypass branch protections.
6. Select and verify a compatible hosting path, staging smoke tests, runtime
   secrets, monitoring, budget/rate gates, rollback and restore procedures.
   Publish/merge only after these gates, not because a local build passed.
