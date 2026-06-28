# Code Standards

## TypeScript
- Strict mode enabled.
- No `any`.
- No `@ts-ignore`.

## Architecture
- Server code must not leak to client.
- Use lazy imports for server-only modules.
- No duplicate business logic.

## Code Quality
- DRY (Don't Repeat Yourself).
- SOLID principles.
- Clean Architecture.

## Dependencies
- Use Bun.
- Prefer official CDN over npm for security patches.
