// Client-safe heuristic only. Never use this classification to authorize a write.
export type BusinessIntent = 'sales' | 'inventory' | 'debts' | 'suppliers' | 'analytics' | 'unknown';

export function classifyBusinessIntent(input: string): BusinessIntent {
  const text = input.trim().toLowerCase().normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/g, '');
  if (!text) return 'unknown';
  if (/تقرير|أرباح|ارباح|ربح|تحليل|مبيعات اليوم|ملخص/.test(text)) return 'analytics';
  if (/مورد|شراء|توريد|مشتريات/.test(text)) return 'suppliers';
  if (/بيع|باع|اشترى|طلب|فاتورة|مبيعات|أخذ|اخذ/.test(text)) return 'sales';
  if (/دين|مديون|عليه|سداد|تحصيل/.test(text)) return 'debts';
  if (/مخزون|كمية|ناقص|نفد|صنف|بضاعة/.test(text)) return 'inventory';
  return 'unknown';
}
