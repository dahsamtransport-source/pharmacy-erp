# Architecture Boundaries

## Layers
```
UI (React)
↓
Routes (TanStack Router)
↓
Services (Business Logic)
↓
Repositories (Supabase Client)
↓
Database (Supabase)
```

## Allowed Imports
- UI → Routes (navigation, state passing)
- Routes → Services (business logic execution)
- Services → Repositories (data access)
- Repositories → Repositories (shared repository patterns)

## Forbidden Imports
- UI → Direct Supabase (bypass architecture)
- UI → Services (skip routing layer)
- Routes → Repositories (skip business logic)
- Routes → Direct Database (no direct DB access)
- Services → Routes (circular dependency)
- Server code in client bundles
- Direct database imports in client-safe files

## Rationale
- **UI Layer**: View components only, no business logic
- **Routes Layer**: Page routing, user input validation, response formatting
- **Services Layer**: Business logic, calculations, orchestration between repositories
- **Repositories Layer**: Single-responsibility data access to Supabase
- **Database Layer**: Source of truth, protected by RLS policies

## File Separation
- Server-only: `*.server.ts` (never imported in client code)
- Client-safe: `*.tsx`, `*.ts` (safe to bundle in browser)

## Enforcement
- TypeScript strict mode catches import violations
- ESLint rules prevent cross-layer imports
- Code review checklist verifies layer compliance
