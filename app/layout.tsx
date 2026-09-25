import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WWIA: Humanity vs Machine Learning",
  description: "RTS táctico contemporáneo: instinto humano contra aprendizaje de máquina.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
