import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Model-Proxy · Control Surface",
  description: "Operator console for the Model-Proxy routing runtime.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
