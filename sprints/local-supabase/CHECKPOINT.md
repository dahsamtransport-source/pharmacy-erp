# نقطة استئناف

- الفرع: `tooling/local-supabase`، فوق `sprint5/ympharma-financial-reports` عند `85288c1`.
- المنجز: Supabase CLI مثبت بإصدار 2.117.0، config معزول يعرض `ym_api` فقط، تشغيل/إيقاف/ترحيل محلي وشبكة loopback، ستة حسابات تدريب بكلمات عشوائية تحفظ محليًا، smoke عبر Auth، PostgreSQL مؤقت لاختبارات التزامن، إصلاح حظر localhost عند غياب WAN.
- الملفات: `scripts/local-*.mjs`، `sprints/01-database/supabase/config.toml`، `src/lib/pharmacy/connectivity.ts` ومواضع الاتصال، tests، npm/CI، دليل Windows.
- نتائج: 12 أدوات، 46 واجهة، 54 SQL/RLS على PGlite، lint/typecheck/build ناجحة.
- العائق المتحقق: Docker/Podman ومقبس Docker غير موجودين في بيئة الجلسة. لم تُشغّل حاويات، أو يُنشأ مستخدم تدريب، أو يُنفذ smoke أو تزامن فعلي.
- التالي: على جهاز Windows مع Docker Linux containers شغّل `local:doctor` ثم `local:start` و`local:seed` و`local:smoke` و`local:test-db` و`local:dev`. سجّل نتائج Docker والأجهزة في TEST_REPORT.
- الحماية: لا أوامر ربط/ترحيل سحابية، لا بيانات إنتاج، لا مفاتيح في المتصفح سوى publishable، ولا كلمات مرور مطبوعة في المحادثة. الهجرات وPROJECT_STATE وcheckout السابق لم تتغير.
