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
          900: "#060606",
          850: "#0A0A0A",
          800: "#0E0E0E",
          700: "#111111",
          600: "#161616",
          500: "#1B1B1B",
          400: "#242424",
          300: "#2E2E2E",
          200: "#3E3E3E",
        },
        bone: {
          900: "#F3F1EC",
          700: "#D9D6CF",
          500: "#A09D97",
          300: "#64635F",
        },
        phosphor: {
          500: "#CDFF00",
          400: "#B9E800",
          300: "#9ECC00",
          100: "rgba(205, 255, 0, 0.12)",
          50: "rgba(205, 255, 0, 0.05)",
        },
        alert: {
          500: "#FF3B30",
          300: "#FF9580",
        },
      },
      boxShadow: {
        edge: "inset 0 0 0 1px #1F1F1F",
        "edge-phosphor": "inset 0 0 0 1px rgba(205, 255, 0, 0.4)",
        "ring-phosphor": "0 0 0 1px rgba(205, 255, 0, 0.6)",
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
