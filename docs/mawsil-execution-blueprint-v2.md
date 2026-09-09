# موصل — المخطط التنفيذي v2

## 1. القرار التنفيذي

تُعتمد الإضافات المقترحة، لكن ليس كلها في أول إصدار. تُقسم إلى ثلاث طبقات:

- **Core MVP:** المبيعات، العملاء، الديون، المخزون، الموردون، المصروفات الأساسية، الصوت العربي، قاموس المصطلحات اليمنية، HITL، تعدد العملات الأساسي، RBAC، RLS، سجل التدقيق، PWA وأوفلاين للمعاملات الحرجة.
- **V1 Expansion:** OCR متعدد الصفحات، الدفعات والمحافظ، التسويات، التنبؤ بإعادة الطلب، الصلاحيات/التشغيلات، الباركود، الطباعة الحرارية، كشوف العملاء، تذكيرات WhatsApp.
- **Platform V2:** شبكة الموردين B2B، مقارنة الأسعار على مستوى الشبكة، التكاملات المالية المرخصة، التحليلات التنبؤية المتقدمة، وربط قطاعات متعددة.

القاعدة الأساسية: لا يسمح للذكاء الاصطناعي بتنفيذ عملية مالية حساسة مباشرة؛ يحوّل الطلب إلى أمر منظم، يتحقق من الصلاحيات والقواعد، ثم يطلب اعتماداً بشرياً عند تجاوز حدود المخاطر.

## 2. القيمة المقترحة

موصل هو نظام تشغيل أعمال عربي، يمني أولاً، يحوّل الكلام والصور والمعاملات اليومية إلى عمليات تجارية قابلة للتدقيق. الهدف ليس بناء ERP تقليدي؛ الهدف تقليل اعتماد التاجر على الدفتر وواتساب والذاكرة، مع واجهة بسيطة تعمل في ظروف اتصال غير مستقرة.

## 3. النواة المعمارية

```text
WhatsApp / PWA / Voice / Camera / Barcode
                    |
             AI Orchestrator
                    |
       +------------+-------------+
       |            |             |
     Sales      Inventory      Finance
       |            |             |
       +------------+-------------+
                    |
        Rules + Permissions + HITL
                    |
        Next.js / Supabase / Postgres
                    |
       Audit + RLS + Offline Sync
```

طبقة الذكاء تستخدم Responses API وAgents SDK للأوامر متعددة الخطوات، مع الصوت/Realtime عند الحاجة، والرؤية لاستخراج الفواتير والمستندات. توثيق OpenAI الحالي يدعم Responses وAgents والصوت وأدوات ربط البيانات. 

## 4. الوحدات النهائية

### A — AI & Voice Engine

- قاموس اللهجات والمصطلحات اليمنية مع aliases لكل مصطلح.
- فهم أوامر مثل: «سجل لمحمد 5 كراتين مياه بالدين».
- استخراج العميل، المنتج، الكمية، العملة، السعر، وطريقة السداد.
- WhatsApp Voice Notes كقناة إدخال، مع نتيجة قابلة للمراجعة قبل الاعتماد.
- Semantic Product Search باستخدام الاسم والمرادفات والمادة الفعالة والوصف.
- Vision/OCR متعدد الصفحات للفواتير.
- HITL للعمليات الحساسة.
- حفظ raw input وstructured command وdecision/audit trail.

### B — Finance & Multi-Currency

- YER قديم، YER جديد، SAR، USD.
- سعر الصرف مرتبط بكل عملية وليس رقماً عالمياً واحداً فقط.
- ربح/خسارة فروقات الصرف.
- المصروفات والتكاليف غير المباشرة.
- حساب هامش الربح الإجمالي والصافي.
- حسابات نقد/محفظة/بنك.
- مطابقة إشعارات التحويل وكشوف الحسابات عند توفر مصدر موثوق.

لا يُبنى موصل كجهة حفظ أموال أو بنك؛ التكامل المالي يكون مع مزودين مرخصين وبحسب المتطلبات التنظيمية المحلية. اتجاه اليمن نحو البنية التحتية للمدفوعات الرقمية يجعل طبقة التكامل الاستقبالية مهمة مستقبلاً. 

### C — Inventory & Supply Chain

- وحدات متعددة: حبة، درزن، باكت، كرتون.
- Barcode.
- Batches/Expiry.
- Inventory movements كسجل مصدر الحقيقة.
- جرد متحرك.
- Predictive reorder.
- مسودة Purchase Order لا تنفيذ شراء آلي دون موافقة.

### D — CRM & Debt

- Customer credit limit.
- كشف حساب مباشر.
- سجل كل بيع وسداد.
- تذكيرات التحصيل.
- روابط كشف الحساب.
- منع البيع الآجل عند تجاوز الحد وفق سياسة التاجر.

### E — Offline & POS

- PWA Offline-first.
- IndexedDB للمعاملات المحلية.
- Service Worker للأصول والعمل دون اتصال.
- Idempotency keys لكل عملية قابلة لإعادة الإرسال.
- Sync queue مع حالات queued/processing/synced/failed.
- Barcode camera.
- Bluetooth thermal printing عندما يدعم المتصفح/الجهاز ذلك عملياً.

IndexedDB مناسب لتخزين البيانات المنظمة محلياً والعمل دون اتصال، وService Worker هو أساس نمط offline-first في الويب الحديث. 

### F — Staff & Security

الأدوار الأساسية:

- owner
- manager
- staff
- inventory

تُطبق RLS على مستوى merchant_id مع ربط المستخدمين بالمنشأة عبر merchant_members. يجب أن يكون كل جدول مكشوف للـData API محمياً بسياسات RLS مناسبة، مع مراجعة الدوال ذات الصلاحيات المرتفعة. هذا يتوافق مع إرشادات Supabase الحالية حول RLS وAuth. 

Audit logs غير قابلة للتعديل أو الحذف، وكل عملية حساسة تحمل actor ووقتاً وسبباً وpayload مناسباً.

### G — Supplier Network

يؤجل إلى ما بعد ثبات النواة. يبدأ كسجل موردين ومقارنة أسعار داخل متجر التاجر، ثم يتحول إلى شبكة B2B متعددة التجار بعد وجود قاعدة مستخدمين وبيانات شراء كافية.

## 5. نموذج البيانات

الجداول الأساسية الحالية والموسعة:

- merchants
- merchant_members
- products
- product_units
- product_batches
- customers
- suppliers
- sales
- sale_items
- purchases
- purchase_items
- inventory_movements
- customer_payments
- expenses
- currencies
- exchange_rates
- financial_accounts
- payment_reconciliations
- approval_requests
- offline_operations
- reorder_suggestions
- debt_reminders
- audit_logs

**مبدأ مهم:** الرصيد والمخزون الظاهران للتطبيق يجب أن يكونا مشتقين من عمليات قابلة للتدقيق، وليس من حقول يمكن تعديلها بلا أثر.

## 6. مراحل التنفيذ

### M0 — Architecture & Product Contract

- تثبيت نطاق MVP.
- تعريف قاموس المصطلحات اليمنية.
- تعريف الصلاحيات وحدود المخاطر.
- تعريف idempotency وaudit requirements.
- وضع اختبارات القواعد المالية قبل بناء الواجهات.

### M1 — Identity, Tenant & Security

- Supabase Auth.
- merchant_members.
- RLS.
- RBAC.
- audit immutability.
- اختبار منع cross-tenant access.

### M2 — Inventory & Catalog

- المنتجات.
- الوحدات والتحويلات.
- الباركود.
- batches/expiry.
- inventory movements.
- جرد متنقل.

### M3 — Sales, Customers & Debt

- POS سريع.
- بيع نقدي وآجل.
- حدود ائتمانية.
- كشف حساب.
- customer payments.
- idempotent transaction processing.

### M4 — Purchases & Finance

- الموردون.
- المشتريات.
- المصروفات.
- الحسابات النقدية والمحافظ والبنوك.
- العملات وأسعار الصرف.
- gross/net margin.

### M5 — AI Orchestrator

مسار كل أمر:

```text
Input -> Normalize -> Intent -> Entity extraction -> Validate
      -> Permission check -> Risk check -> Tool plan
      -> HITL if required -> Execute -> Audit -> Response
```

لا يسمح للـLLM بتجاوز قواعد الصلاحيات أو إنشاء SQL عشوائي أو تنفيذ mutation حساس دون أدوات backend محددة.

### M6 — Voice & WhatsApp

- Voice transcription.
- Yemeni normalization.
- Confirmation message.
- WhatsApp webhook/adapter.
- Voice notes.
- Retry and deduplication.

### M7 — Vision & OCR

- Multi-page invoices.
- Handwritten/printed extraction مع confidence scores.
- مراجعة الحقول منخفضة الثقة.
- حفظ المستند الأصلي.
- تحويل النتيجة إلى draft purchase لا إلى شراء نهائي مباشرة.

### M8 — Offline POS

- IndexedDB.
- Service Worker.
- Offline queue.
- Conflict resolution.
- Idempotency.
- Sync monitoring.

### M9 — Analytics & Prediction

- sales dashboard.
- net margin.
- aging debts.
- dead stock.
- expiry risk.
- reorder prediction.
- suggested purchase orders.

### M10 — Pilot

- 3–10 تجار في البداية.
- قياس دقة الأوامر الصوتية.
- قياس sync failures.
- قياس inventory variance.
- قياس debt collection usage.
- تسجيل كل حالات فشل AI وتصحيحها.

### M11 — Production Hardening

- CI/CD.
- dependency/security scans.
- database migration checks.
- RLS regression tests.
- financial invariant tests.
- backup/restore drill.
- observability.
- rate limits.

### M12 — B2B Platform

- supplier onboarding.
- supplier catalog.
- price intelligence.
- RFQ/order workflows.
- network analytics.
- integration with licensed financial/payment providers where permitted.

## 7. HITL ومصفوفة المخاطر

| العملية | آلية التنفيذ |
|---|---|
| تسجيل بيع نقدي صغير | يمكن تنفيذه مباشرة بعد تحقق القواعد |
| بيع آجل ضمن حد العميل | تنفيذ مباشر إذا كانت الصلاحيات تسمح |
| تجاوز حد الدين | رفض أو طلب موافقة |
| تعديل سعر التكلفة | موافقة مدير/مالك |
| حذف/إلغاء دين | موافقة مالك |
| شراء كبير | draft + approval |
| تعديل مخزون كبير | approval + audit |
| تغيير سعر صرف | صلاحية إدارية + audit |

## 8. WhatsApp

WhatsApp ليس قاعدة بيانات؛ هو قناة. كل رسالة تدخل عبر webhook، تُعطى idempotency key، تحفظ كحدث، ثم تمر إلى orchestrator. الرد المالي المهم يكون واضحاً وقابلاً للتأكيد.

## 9. OCR والبحث الدلالي

OCR لا يكتب مباشرة إلى الجداول النهائية. الناتج يمر عبر:

`document -> extraction -> normalization -> confidence -> draft -> human confirmation -> commit`

والبحث الدلالي يظل مقيداً بكتالوج التاجر. في القطاعات الصحية لا يقدم النظام تشخيصاً طبياً؛ البحث عن المنتجات/الأدوية يطابق الكتالوج والبيانات الموثقة فقط.

## 10. CI/CD والجودة

كل Pull Request يجب أن يمر على:

- TypeScript typecheck.
- lint.
- production build.
- unit tests.
- financial calculations tests.
- idempotency tests.
- RLS isolation tests.
- migration checks.
- dependency/security checks.

الهدف: منع دمج كود يكسر الحسابات أو عزل بيانات التجار.

## 11. ترتيب الأولوية

### P0 — لا إطلاق بدونها

RLS، Auth، RBAC، audit، inventory movements، sales، customer debt، idempotency، financial invariants، basic offline queue، HITL.

### P1 — بعد النواة مباشرة

Voice، WhatsApp، OCR، barcode، expiry، multi-currency، expenses، customer statements، payment reconciliation.

### P2 — بعد إثبات الاستخدام

Predictive reorder، advanced analytics، Bluetooth printing، automated reminders، richer wallet integrations.

### P3 — بعد الوصول إلى شبكة تجار

B2B sourcing، supplier marketplace، cross-merchant price intelligence، network effects.

## 12. الميزانية التنفيذية المحدثة

التقدير السابق يبقى صالحاً كنطاق مبدئي، لكن الإضافات ترفع تكلفة V1 إذا أُدخلت كلها مبكراً.

- Prototype: **$100–300**.
- MVP Core: **$1,000–1,500** مستهدفاً.
- Production V1 مع Voice/OCR/Offline/Finance/RBAC: **$2,500–6,000** بحسب مستوى التكامل والاختبارات.
- تشغيل أولي: تقريباً **$60–300/شهر** قبل رسوم WhatsApp أو مزودي الدفع أو أحجام AI الكبيرة.

لا يُفترض شراء كل التكاملات الخارجية في اليوم الأول. الإنفاق يتبع إثبات الاستخدام.

## 13. مؤشرات النجاح

- ≥95% من المعاملات لا تتكرر عند المزامنة.
- 0 cross-tenant data leaks في اختبارات RLS.
- ≥98% نجاح حساب الإجماليات والديون في الاختبارات.
- خفض زمن تسجيل البيع مقارنة بالطريقة اليدوية.
- خفض أخطاء الجرد.
- زيادة نسبة تحصيل الديون.
- نسبة الأوامر الصوتية التي تحتاج تصحيحاً بشرياً تتناقص شهرياً.
- زمن مزامنة مقبول بعد عودة الاتصال.

## 14. قرار المنتج

لا نريد بناء 30 ميزة منفصلة. نبني **محرك معاملات تجارية موثوق** ثم نضيف فوقه قنوات الذكاء والصوت والصورة وWhatsApp والتحليلات. كل ميزة جديدة يجب أن تستخدم نفس قواعد الهوية، الصلاحيات، idempotency، audit، وHITL.

هذا يجعل موصل قابلاً للتوسع من محل واحد إلى مؤسسة متعددة الفروع، ثم إلى شبكة B2B، دون إعادة بناء قاعدة البيانات أو نموذج الأمان.
