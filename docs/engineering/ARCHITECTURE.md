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
- UI → Routes
- Routes → Services
- Services → Repositories

## Forbidden Imports
- UI → Direct Supabase
- Routes → Direct Database
- Server code in client bundles

## File Separation
- Server-only: `*.server.ts`
- Client-safe: `*.tsx`, `*.ts`
