import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'موصل | نظام تشغيل التاجر الذكي',
  description: 'نظام تشغيل أعمال عربي للتجار في اليمن',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
