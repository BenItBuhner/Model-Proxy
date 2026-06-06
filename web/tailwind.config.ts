import type { Config } from "tailwindcss";

const config: Config = {
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
          900: "rgb(var(--color-ink-900) / <alpha-value>)",
          850: "rgb(var(--color-ink-850) / <alpha-value>)",
          800: "rgb(var(--color-ink-800) / <alpha-value>)",
          700: "rgb(var(--color-ink-700) / <alpha-value>)",
          600: "rgb(var(--color-ink-600) / <alpha-value>)",
          500: "rgb(var(--color-ink-500) / <alpha-value>)",
          400: "rgb(var(--color-ink-400) / <alpha-value>)",
          300: "rgb(var(--color-ink-300) / <alpha-value>)",
          200: "rgb(var(--color-ink-200) / <alpha-value>)",
        },
        bone: {
          900: "rgb(var(--color-bone-900) / <alpha-value>)",
          700: "rgb(var(--color-bone-700) / <alpha-value>)",
          500: "rgb(var(--color-bone-500) / <alpha-value>)",
          300: "rgb(var(--color-bone-300) / <alpha-value>)",
        },
        phosphor: {
          500: "rgb(var(--color-phosphor-500) / <alpha-value>)",
          400: "rgb(var(--color-phosphor-400) / <alpha-value>)",
          300: "rgb(var(--color-phosphor-300) / <alpha-value>)",
          100: "rgb(var(--color-phosphor-500) / 0.12)",
          50: "rgb(var(--color-phosphor-500) / 0.05)",
        },
        alert: {
          500: "rgb(var(--color-alert-500) / <alpha-value>)",
          300: "rgb(var(--color-alert-300) / <alpha-value>)",
        },
      },
      boxShadow: {
        edge: "inset 0 0 0 1px rgb(var(--color-edge) / 1)",
        "edge-phosphor": "inset 0 0 0 1px rgb(var(--color-phosphor-500) / 0.4)",
        "ring-phosphor": "0 0 0 1px rgb(var(--color-phosphor-500) / 0.6)",
      },
      backgroundImage: {
        grid:
          "linear-gradient(var(--grid-line-strong) 1px, transparent 1px)," +
          "linear-gradient(90deg, var(--grid-line-strong) 1px, transparent 1px)",
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
