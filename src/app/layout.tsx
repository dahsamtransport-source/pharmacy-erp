import type { Metadata } from "next";
import "@fontsource/tajawal/400.css";
import "@fontsource/tajawal/500.css";
import "@fontsource/tajawal/700.css";
import "@fontsource/tajawal/800.css";
import "./globals.css";
export const metadata: Metadata = {
  title: "YmPharma | إدارة الصيدلية والمالية",
  description:
    "مساحة عمل عربية للمبيعات والمشتريات والتشغيلات والتقارير المالية",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
