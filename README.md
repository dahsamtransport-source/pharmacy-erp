# Pharmacy ERP

YmPharma: Arabic pharmacy and accounting workspace. Sprint 2 adds the React UI on the repository's existing Next.js application; it does not migrate the project to Vite or replace the separate Oracle Sites deployment.

- [Sprint 2 setup, scope and limits](sprints/02-frontend/README.md)
- [Sprint 2 verification report](sprints/02-frontend/TEST_REPORT.md)
- [Financial reports (Sprint 5): setup and review](sprints/05-financial-reports/README.md)
- [Financial reports verification](sprints/05-financial-reports/TEST_REPORT.md)
- [Sprint 1 database baseline](sprints/01-database/README.md)

```sh
npm ci
npm run dev
```

Open http://localhost:3000. Without configuration the app explicitly shows an unconnected workspace with no fabricated metrics. Copy `.env.example` to `.env.local` and follow the Sprint 2 guide to connect a **disposable Supabase evaluation project**. The staged database migrations must not be applied to a production database.

```sh
npm test
npm run lint
npm run build
npm run typecheck
npm ci --prefix sprints/01-database --ignore-scripts
npm run test:db
```
