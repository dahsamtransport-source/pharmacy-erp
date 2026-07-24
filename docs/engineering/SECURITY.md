# Security Standards

## OWASP Top 10 Mitigations

### SQL Injection
- **Mitigation**: Use Supabase prepared statements only, never string interpolation
- **Check**: Code review must verify no dynamic SQL construction
- Example ❌: `query(\`SELECT * FROM users WHERE id = ${id}\`)`
- Example ✅: `query('SELECT * FROM users WHERE id = ?', [id])`

### Cross-Site Scripting (XSS)
- **Mitigation**: Sanitize all user input before rendering
- **Check**: Use DOMPurify for HTML content, React escapes by default
- Never use `dangerouslySetInnerHTML` without sanitization
- Validate input length and format

### Cross-Site Request Forgery (CSRF)
- **Mitigation**: Use Supabase Auth (built-in CSRF protection)
- **Check**: All state-changing requests must be POST/PUT/DELETE with auth
- Verify Origin header on sensitive operations

### Authentication & Session Management
- **Mitigation**: Use Supabase Auth exclusively
- No custom session logic
- Respect session expiry, no manual extension
- Token refresh only via secure endpoint

### Sensitive Data Exposure
- No hardcoded secrets in code
- All secrets in environment variables only
- Never log passwords, API keys, or tokens
- Encrypt sensitive data at rest (Supabase encryption enabled)

## Environment Configuration
- Validate all environment variables at startup
- Throw error if critical vars are missing
- Use `.env.example` (with placeholders) for reference
- Never commit `.env` or `.env.local`

## Authentication
- Use Supabase Auth as single source of truth
- Require Row-Level Security (RLS) policies on all tables
- RLS policies must be tested before deployment
- Security Definer functions restricted to authenticated users only

## Cron Hooks & Background Jobs
- All cron endpoints must require `x-cron-secret` header
- Use timing-safe comparison for secrets (no string equality)
- Implement rate limiting per API key
- Log all cron executions with timestamp and result

## Database Security
- All tables require RLS enabled
- Default policy: DENY (explicit ALLOW only)
- Test RLS by querying as different user roles
- Regular audit of policy scope

## Dependency Management
- Audit dependencies monthly: `bun audit`
- Update critical security patches within 48 hours
- Review breaking changes before updating
- Pin versions in bun.lock, never use `*` or `latest`

## Code Review Checklist
- [ ] No hardcoded secrets
- [ ] No SQL injection vulnerabilities
- [ ] No XSS vectors (user input sanitized)
- [ ] RLS policies present and tested
- [ ] Server-only code not in client bundle
- [ ] No @ts-ignore on security code
- [ ] Error messages don't leak sensitive info
