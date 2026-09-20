# نقطة استئناف Sprint 2

- النطاق: React UI فوق مخطط Sprint 1، منشأة واحدة، Next.js الموجود؛ لا نقل إلى Vite ولا نشر إلى موقع Oracle.
- المنجز: `AnimatedDashboard`، shell عربي، جلسة Supabase، POS، استلام مشتريات، مخزون، تقارير، إيصال وطباعة، عقود قراءة SQL، حماية مرجع المحاولات.
- الاختبارات: 24 واجهة وخدمات، 41 SQL/RLS ناجحة؛ lint/typecheck/build ناجحة. التفاصيل في TEST_REPORT.md.
- الملفات: `src/features/pharmacy`, `src/lib/pharmacy`, `src/hooks`, `src/AnimatedDashboard.tsx`, `src/app`، الهجرة `20260920013438`، `tests/frontend`، الاعتماديات وCI والتوثيق.
- العوائق: لا بيئة Supabase اختبار مهيأة؛ معاينة localhost محجوبة في المتصفح؛ GitHub Actions سبق أن توقف بسبب قفل الفوترة. اختبارات الأجهزة والطباعة والتزامن الخادمي لم تكتمل.
- التالي: مراجعة التصميم والكود ثم إعداد بيئة اختبار وربط Auth/PostgREST واختبار حسابات وأجهزة؛ لا ترحيل إنتاج قبل خطة CUTOVER وقبول السياسات.
- لا تعدّل checkout الأصلي المتسخ، ولا `docs/engineering/PROJECT_STATE.yaml`، ولا تنسخ أسرارًا إلى متغيرات NEXT_PUBLIC.
