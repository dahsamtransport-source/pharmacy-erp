# YmPharma accounting workspace — Medical Enterprise design

Applied to the accounting application on top of `delivery/readiness-and-ledger` (`ab057872f9af65a236fdebe6243d199a5b4493bf`), not the separate pharmacy storefront repository.

## User-facing changes

- Navy right-hand navigation and teal primary actions, with shared opaque surfaces and readable tables.
- Consistent styling across overview, POS, purchasing, inventory, financial statements and account ledger.
- Light/dark appearance saved on the device; server rendering starts with the stable light snapshot.
- Global inventory search remains available on mobile; Ctrl/Cmd K focuses it.
- Mobile navigation closes with Escape, traps keyboard focus, restores focus, and releases the scroll lock.
- Reduced-motion users see dashboard cards immediately. Print rules remain independent of screen themes.

Existing accounting API calls, exact decimal arithmetic, transaction identifiers, roles, tenancy, database migrations and remote integrations are unchanged.

## Validation

- 54 frontend tests passed, including theme persistence and keyboard navigation.
- TypeScript, ESLint and production build passed.
- Chromium: five navigation destinations, theme persistence after reload, Ctrl K, mobile drawer Escape/focus restoration, desktop and 390px mobile overflow checks passed; no page errors.
- Browser checks used the disconnected state, not production credentials or financial transactions. Existing functional tests cover POS, rejection/cart preservation, reports and account ledger using isolated fixtures.

The changes must be pulled and the app rebuilt/restarted on the computer hosting the local ERP before that running installation displays the design. A GitHub merge does not update a user's local process automatically.
