/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#070b14",
          900: "#0b1220",
          800: "#111827",
          700: "#1e293b",
        },
        app: "var(--bg)",
        elev: "var(--bg-elev)",
        activity: "var(--activity)",
        accent: {
          DEFAULT: "var(--accent)",
          dim: "var(--accent-2)",
        },
      },
      textColor: {
        app: "var(--text)",
        dim: "var(--text-dim)",
      },
      borderColor: {
        app: "var(--border)",
      },
      backgroundColor: {
        app: "var(--bg)",
        elev: "var(--bg-elev)",
        activity: "var(--activity)",
        status: "var(--status)",
        input: "var(--bg-input)",
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
