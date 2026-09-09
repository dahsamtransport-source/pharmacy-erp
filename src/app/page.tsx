'use client';

import { useMemo, useState } from 'react';
import { classifyBusinessIntent, type BusinessIntent } from '@/lib/ai/orchestrator';

const cards: Array<{ title: string; description: string; intent: BusinessIntent }> = [
  { title: 'المبيعات', description: 'سجل البيع والطلبات بسرعة.', intent: 'sales' },
  { title: 'المخزون', description: 'اعرف الكميات والنواقص.', intent: 'inventory' },
  { title: 'الديون', description: 'تابع العملاء والمديونيات.', intent: 'debts' },
  { title: 'الموردون', description: 'تابع التوريد والمشتريات.', intent: 'suppliers' },
  { title: 'التحليلات', description: 'راجع الأرباح والمبيعات.', intent: 'analytics' },
];

const labels: Record<BusinessIntent, string> = {
  sales: 'المبيعات',
  inventory: 'المخزون',
  debts: 'الديون',
  suppliers: 'الموردون',
  analytics: 'التحليلات',
  unknown: 'غير محدد',
};

export default function HomePage() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<BusinessIntent | null>(null);
  const intent = useMemo(() => classifyBusinessIntent(input), [input]);

  function execute() {
    setResult(intent);
  }

  return (
    <main className="shell">
      <header className="hero">
        <span className="eyebrow">MAWSIL AI BUSINESS OS</span>
        <h1>موصل</h1>
        <p>مساعدك الذكي لإدارة تجارتك من الكلام إلى الفعل.</p>
      </header>

      <section className="command-card" aria-labelledby="command-title">
        <h2 id="command-title">قل لموصل ماذا تريد</h2>
        <p className="muted">مثال: سجل أن محمد أخذ 5 كراتين مياه بالدين</p>
        <div className="command-row">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') execute();
            }}
            aria-label="أمر موصل"
            placeholder="اكتب أمرًا تجاريًا..."
          />
          <button type="button" onClick={execute} disabled={!input.trim()}>
            نفّذ
          </button>
        </div>
        {result && (
          <div className="result" role="status">
            <strong>القسم المقترح:</strong> {labels[result]}
          </div>
        )}
      </section>

      <section className="cards" aria-label="أقسام موصل">
        {cards.map((card) => (
          <button
            className="card"
            key={card.intent}
            type="button"
            onClick={() => {
              setInput('');
              setResult(card.intent);
            }}
          >
            <span className="card-title">{card.title}</span>
            <span className="card-description">{card.description}</span>
          </button>
        ))}
      </section>
    </main>
  );
}
