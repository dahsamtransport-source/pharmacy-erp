const cards = [
  ['المبيعات', 'ابدأ تسجيل عملية بيع'],
  ['المخزون', 'راجع الأصناف والكميات'],
  ['الديون', 'تابع العملاء والمديونيات'],
  ['الموردون', 'تابع المشتريات والموردين'],
];

export default function HomePage() {
  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: 32 }}>
      <header style={{ marginBottom: 32 }}>
        <p style={{ margin: 0, opacity: 0.65 }}>Mawsil AI Business OS</p>
        <h1 style={{ fontSize: 40, margin: '8px 0' }}>مرحباً بك في موصل</h1>
        <p style={{ fontSize: 18, margin: 0 }}>أدر تجارتك بالكلام، بسرعة وببساطة.</p>
      </header>

      <section style={{ background: 'white', padding: 24, borderRadius: 18, marginBottom: 24 }}>
        <h2 style={{ marginTop: 0 }}>ماذا تريد أن تفعل؟</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <input
            aria-label="أمر موصل"
            placeholder="مثال: سجل أن محمد أخذ 5 كراتين مياه بالدين"
            style={{ flex: 1, minWidth: 280, padding: 16, border: '1px solid #d9dde5', borderRadius: 12 }}
          />
          <button style={{ padding: '12px 22px', border: 0, borderRadius: 12, cursor: 'pointer' }}>
            نفّذ
          </button>
        </div>
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16 }}>
        {cards.map(([title, description]) => (
          <article key={title} style={{ background: 'white', padding: 22, borderRadius: 16 }}>
            <h3>{title}</h3>
            <p style={{ opacity: 0.7 }}>{description}</p>
          </article>
        ))}
      </section>
    </main>
  );
}
