import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Жильё у TAU — Астана",
  description:
    "Парсер krisha.kz и olx.kz: однокомнатные квартиры и студии рядом с Turan Astana University с ИИ-отбором",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
