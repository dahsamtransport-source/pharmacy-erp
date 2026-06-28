# Security Standards

## OWASP Top 10
- SQL Injection: Use Supabase policies.
- XSS: Sanitize user input.
- CSRF: Use Supabase auth.

## Environment
- No hardcoded secrets.
- Validate all environment variables.

## Authentication
- Use Supabase Auth.
- RLS policies must be defined.
- Security definer functions restricted to authenticated users.

## Cron Hooks
- Must use `x-cron-secret` header.
- Use timing-safe comparison.
