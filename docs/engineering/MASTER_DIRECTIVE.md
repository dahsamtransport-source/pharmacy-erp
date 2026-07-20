# MUSLLY AI OS — Engineering Master Directive

## Project Vision

Transform `dahsamtransport-source/pharmacy-erp` into a **production-grade AI-powered Pharmacy ERP platform**.

**Language Composition**:
- TypeScript: 89.8%
- PL/pgSQL: 7.7%
- CSS: 1.2%
- Other: 1.3%

### Core Principle
**Never remove functionality unless clearly obsolete.** Analyze, preserve, refactor, improve.

---

## Primary Objectives (Priority Order)

1. **Production Readiness** - Enterprise-grade stability
2. **Scalability** - Handle growth without redesign
3. **Security** - Audit continuously, follow least privilege
4. **Reliability** - 99.9% uptime target
5. **Performance** - Sub-100ms API responses
6. **Clean Architecture** - Modular, maintainable code
7. **AI-First Design** - Extensible AI layer for multiple agents
8. **Developer Experience** - Clear patterns, great documentation

Every change moves the project closer to enterprise quality.

---

## Architecture Principles

### Modular Architecture
Separate responsibilities into independent, loosely-coupled modules:

```
Authentication → Users → Organizations → Pharmacy → Inventory → Suppliers
                                        ↓
                                    Products → Customers → Prescriptions
                                        ↓
                                    Orders → Billing → Reports
                                        ↓
                                    Notifications → AI → Analytics → Marketing
                                        ↓
                                    Administration
```

Each module:
- Has clear boundaries
- Exports minimal public API
- Can be tested independently
- Follows SOLID principles

### AI Platform Architecture
Build extensible AI layer supporting multiple specialized agents:

- **Pharmacy Assistant** - Drug interactions, dosage calculations
- **Inventory Assistant** - Stock optimization, reorder predictions
- **Customer Support** - Patient queries, prescription status
- **Marketing Assistant** - Campaign optimization, customer segmentation
- **Analytics Assistant** - Report generation, trend analysis
- **Executive Assistant** - KPI dashboards, strategic insights

Use abstractions (not hardcoded providers) to support OpenAI, Claude, Ollama, etc.

### Event-Driven Architecture
Avoid tight coupling through event publishing:

- Event publishing (domain events)
- Event subscriptions (listeners)
- Background processing (queues)
- Retries & dead letter handling
- Audit trails (immutable event log)

---

## Frontend Standards

### Improve & Maintain
- [ ] Accessibility (WCAG 2.1 AA minimum)
- [ ] Responsiveness (mobile-first design)
- [ ] Loading performance (<3s page load)
- [ ] State management (Redux/Zustand pattern)
- [ ] Component reuse (DRY principle)
- [ ] Design consistency (reusable design system)
- [ ] UX polish (user research-driven)

### Design System
Replace isolated UI components with a centralized, reusable design system:
- Button, Input, Modal, Card, Form, Table, etc.
- Consistent typography, spacing, colors
- Dark/light mode support
- Accessible components (ARIA labels, keyboard navigation)

---

## Backend Standards

### API Structure
- RESTful endpoints with consistent naming
- Request/response validation (JSON Schema)
- Proper HTTP status codes
- Error responses with actionable messages
- Pagination for list endpoints
- Versioning strategy (v1, v2, etc.)

### Security Layer
- Authentication (Supabase Auth)
- Authorization (Role-Based Access Control)
- Input validation (type + business rules)
- Rate limiting (per API key/user)
- Audit logging (who, what, when, why)

### Reliability
- Graceful error handling
- Structured logging (context-aware)
- Health check endpoints
- Graceful degradation on failures

---

## Database Standards

### Schema Quality
- **Consistency**: Naming conventions, data types
- **Indexes**: On frequently-queried columns, foreign keys
- **Constraints**: NOT NULL, UNIQUE, CHECK constraints
- **Foreign Keys**: Referential integrity enforced
- **Migrations**: Versioned, reversible, tested

### RLS Policies
- Row-Level Security enabled on all sensitive tables
- Default DENY, explicit ALLOW policies
- Test RLS as different user roles
- Regular audit of policy scope

### Query Performance
- Identify slow queries (>500ms)
- Add missing indexes
- Optimize N+1 query problems
- Use connection pooling

### Schema Evolution
- Never introduce breaking changes without migration path
- Review every SQL migration before adding
- Document schema changes in CHANGELOG

---

## Security Audits

### Authentication & Authorization
- [x] Supabase Auth configured
- [ ] RBAC roles defined (admin, user, guest)
- [ ] Session management reviewed
- [ ] MFA enabled for sensitive operations

### Secrets Management
- [ ] No hardcoded secrets in code
- [ ] All secrets in environment variables
- [ ] Secrets rotation policy
- [ ] .env.local in .gitignore

### Input Validation
- [ ] All user inputs validated
- [ ] SQL injection prevented (parameterized queries)
- [ ] XSS prevention (input sanitization)
- [ ] CSRF tokens on state-changing operations

### Rate Limiting
- [ ] API endpoints rate-limited
- [ ] Per-user/IP limits
- [ ] Burst handling strategy

### Audit Trail
- [ ] All sensitive operations logged
- [ ] Immutable audit log (database)
- [ ] Retention policy (>1 year)

---

## Performance Optimization

### Frontend
- [ ] Bundle size <500KB (gzipped)
- [ ] Lazy load routes
- [ ] Lazy load heavy components
- [ ] Image optimization
- [ ] Caching strategy (cache headers)

### Backend
- [ ] API latency <100ms (p95)
- [ ] Database query optimization
- [ ] Connection pooling
- [ ] Caching layer (Redis if needed)

### Monitoring
- [ ] Performance metrics tracked
- [ ] Alerts for degradation
- [ ] Regular performance audits

---

## Testing Strategy

### Test Coverage Targets
- Unit tests: >80% coverage on business logic
- Integration tests: Critical user flows
- E2E tests: Main happy paths
- Performance tests: Load testing

### Test Types
- **Unit Tests**: Individual functions/components
- **Integration Tests**: Database + API
- **E2E Tests**: Full user workflows
- **Regression Tests**: Bug fixes

### Never Reduce Coverage
Any decrease in test coverage requires CTO approval.

---

## Documentation

### Maintain & Improve
- [ ] Architecture documentation (this file)
- [ ] API documentation (OpenAPI/Swagger)
- [ ] Deployment documentation
- [ ] Environment setup guide
- [ ] Database schema documentation
- [ ] Developer onboarding checklist
- [ ] Troubleshooting guide

### Living Documentation
- Update docs when architecture changes
- Keep README current
- Document design decisions (ADRs)
- Include examples and code snippets

---

## DevOps & CI/CD

### Pipeline Review
- [ ] GitHub Actions workflows optimized
- [ ] Environment variable management
- [ ] Docker images optimized
- [ ] Build process <5 minutes
- [ ] Automated testing in CI

### Deployment Strategy
- [ ] Blue/green deployments
- [ ] Canary releases for risky changes
- [ ] Rollback procedures documented
- [ ] Release notes template

### Monitoring & Logging
- [ ] Application logs structured
- [ ] Error tracking (Sentry/similar)
- [ ] Performance monitoring
- [ ] Alerts for production issues

---

## Git & Code Review Process

### Commit Strategy
- Small, focused commits
- Meaningful commit messages (conventional commits)
- One feature per branch
- PR size <400 LOC

### Code Review Checklist
For every pull request:
1. **Functionality**: Does it work as intended?
2. **Architecture**: Follows modular principles?
3. **Security**: No vulnerabilities introduced?
4. **Tests**: Adequate coverage added?
5. **Documentation**: Updated if necessary?
6. **Performance**: No regressions?
7. **Code Quality**: SOLID principles followed?

---

## Continuous Improvement Process

### Weekly Reviews
Review for:
- Duplicated code → Extract utilities
- Performance bottlenecks → Profile and optimize
- Architectural smells → Refactor
- Security risks → Audit and patch
- Maintainability issues → Simplify

### Monthly Audits
- Dependency updates
- Security patches
- Performance benchmarks
- Test coverage trends
- Technical debt assessment

### Quarterly Strategy
- Architecture review
- Roadmap alignment
- Team feedback incorporation
- Technology evaluation

---

## Implementation Phases

### Phase 1: Foundation (SEC-P1-002 through SEC-P1-005)
- [x] Architecture boundaries defined ✅
- [x] Engineering system v4.0 initialized ✅
- [x] Code standards established ✅
- [x] Master directive integrated ✅
- [ ] Security audit framework in place

### Phase 2: Infrastructure (Next Quarter)
- [ ] Modular architecture implemented
- [ ] Testing framework expanded
- [ ] CI/CD pipelines optimized
- [ ] Documentation framework complete

### Phase 3: AI Platform (Q3 2026)
- [ ] AI abstraction layer built
- [ ] First AI agent (Pharmacy Assistant)
- [ ] Event infrastructure deployed
- [ ] Analytics dashboard

### Phase 4: Production (Q4 2026)
- [ ] 99.9% uptime achieved
- [ ] Performance targets met
- [ ] Security audit passed
- [ ] Enterprise customers onboarded

---

## Success Metrics

- **Uptime**: 99.9% SLA
- **Response Time**: p95 < 100ms
- **Test Coverage**: >80% on business logic
- **Security**: 0 critical vulnerabilities
- **Performance**: Bundle size <500KB (gzipped)
- **Documentation**: 100% of public APIs documented
- **Developer Satisfaction**: NPS >50

---

**Version**: 4.0 | **Status**: ACTIVE | **Last Updated**: 2026-07-20
