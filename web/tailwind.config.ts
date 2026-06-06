import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Geist Sans"', "-apple-system", "system-ui", "sans-serif"],
        mono: [
          '"JetBrains Mono"',
          '"Geist Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
        display: [
          '"JetBrains Mono"',
          '"Geist Mono"',
          "ui-monospace",
          "monospace",
        ],
      },
      colors: {
        ink: {
          900: "var(--ink-900)",
          850: "var(--ink-850)",
          800: "var(--ink-800)",
          700: "var(--ink-700)",
          600: "var(--ink-600)",
          500: "var(--ink-500)",
          400: "var(--ink-400)",
          300: "var(--ink-300)",
          200: "var(--ink-200)",
        },
        bone: {
          900: "var(--bone-900)",
          700: "var(--bone-700)",
          500: "var(--bone-500)",
          300: "var(--bone-300)",
        },
        phosphor: {
          500: "var(--phosphor-500)",
          400: "var(--phosphor-400)",
          300: "var(--phosphor-300)",
          100: "var(--phosphor-100)",
          50: "var(--phosphor-50)",
        },
        alert: {
          500: "var(--alert-500)",
          300: "var(--alert-300)",
        },
      },
      boxShadow: {
        edge: "var(--shadow-edge)",
        "edge-phosphor": "var(--shadow-edge-phosphor)",
        "ring-phosphor": "var(--shadow-ring-phosphor)",
      },
      backgroundImage: {
        grid:
          "linear-gradient(rgba(40,40,40,0.35) 1px, transparent 1px)," +
          "linear-gradient(90deg, rgba(40,40,40,0.35) 1px, transparent 1px)",
        "grid-mask":
          "radial-gradient(ellipse 60% 60% at 50% 0%, #000 0%, transparent 80%)",
      },
      keyframes: {
        "flicker-in": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "60%": { opacity: "0.6" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
      },
      animation: {
        "flicker-in": "flicker-in 420ms cubic-bezier(.4,0,.2,1) both",
        "slow-pulse": "pulse 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
