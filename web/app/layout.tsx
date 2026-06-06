import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Model-Proxy · Control Surface",
  description: "Operator console for the Model-Proxy routing runtime.",
};

const themeInitScript = `
(() => {
  try {
    const key = "model-proxy.theme";
    const values = new Set(["light", "dark", "system"]);
    const stored = window.localStorage.getItem(key);
    const preference = values.has(stored) ? stored : "system";
    const system = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    const theme = preference === "system" ? system : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.style.colorScheme = "dark";
  }
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
