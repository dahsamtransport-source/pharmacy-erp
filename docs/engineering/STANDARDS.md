# Code Standards

## TypeScript
- Strict mode enabled (`strict: true` in tsconfig)
- No `any` - use specific types
- No `@ts-ignore` - fix type issues instead
- No implicit `any`

## Architecture Compliance
- Server code must never leak to client bundles
- Use lazy imports for server-only modules: `import('./module.server.ts')`
- No duplicate business logic across layers
- Repositories are single-responsibility (one domain entity per file)
- Services orchestrate repositories, never call database directly

## Code Quality
- DRY (Don't Repeat Yourself) - extract reusable logic
- SOLID principles:
  - Single Responsibility: One reason to change per module
  - Open/Closed: Open for extension, closed for modification
  - Liskov Substitution: Interfaces are consistently implemented
  - Interface Segregation: Don't force unused dependencies
  - Dependency Inversion: Depend on abstractions, not concrete implementations
- Clean Architecture: Business logic independent of frameworks

## Error Handling
- All async functions must handle errors
- Use `.catch()` or `try/catch` for promise rejection
- Never silently swallow errors
- Log errors with context (user ID, action, timestamp)

## Dependencies
- Use Bun as package manager and runtime
- Prefer official CDNs over npm for security-critical patches
- Keep dependencies minimal and up-to-date
- Lock versions in bun.lock

## Testing Mindset
- Write tests as you code
- Test error paths, not just happy paths
- Use meaningful test names describing the scenario
- Aim for >80% coverage in critical paths

## Performance
- Lazy load large components
- Use `computed()` selectively to avoid redundant calculations
- Batch database queries when possible
- Index frequently-queried columns

## Documentation
- Comment "why", not "what" (code shows what)
- Keep architecture docs in sync with code
- Document breaking changes in CHANGELOG.md
