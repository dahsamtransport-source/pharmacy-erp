export type BusinessIntent =
  | 'sales'
  | 'inventory'
  | 'debts'
  | 'suppliers'
  | 'analytics'
  | 'unknown';

export function classifyBusinessIntent(input: string): BusinessIntent {
  const text = input.trim().toLowerCase();
  if (!text) return 'unknown';
  if (/بيع|باع|اشترى|طلب|فاتورة|مبيعات/.test(text)) return 'sales';
  if (/مخزون|كمية|ناقص|نفد|صنف|بضاعة/.test(text)) return 'inventory';
  if (/دين|مديون|عليه|سداد|تحصيل/.test(text)) return 'debts';
  if (/مورد|شراء|توريد|مشتريات/.test(text)) return 'suppliers';
  if (/تقرير|أرباح|ربح|تحليل|مبيعات اليوم|ملخص/.test(text)) return 'analytics';
  return 'unknown';
}
