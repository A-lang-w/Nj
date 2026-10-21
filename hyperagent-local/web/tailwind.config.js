/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  // The canvas is forced-dark (see index.html/index.css): bind `dark:`
  // variants to the class, not the OS setting, or light-mode systems render
  // light-mode text on the dark canvas at ~1:1 contrast.
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "rgb(6, 6, 6)",
        foreground: "rgb(235, 235, 235)",
        card: {
          DEFAULT: "rgba(255, 255, 255, 0.04)",
          foreground: "rgb(237, 237, 237)",
        },
        popover: {
          DEFAULT: "rgb(13, 13, 13)",
          foreground: "rgb(237, 237, 237)",
        },
        primary: {
          DEFAULT: "rgb(237, 237, 237)",
          foreground: "rgb(9, 9, 9)",
          hover: "rgb(200, 200, 200)",
          50: "rgb(250, 250, 250)",
          100: "rgb(245, 245, 245)",
          200: "rgb(237, 237, 237)",
          300: "rgb(220, 220, 220)",
          400: "rgb(200, 200, 200)",
          500: "rgb(180, 180, 180)",
          600: "rgb(150, 150, 150)",
          700: "rgb(120, 120, 120)",
          800: "rgb(80, 80, 80)",
          900: "rgb(40, 40, 40)",
          950: "rgb(20, 20, 20)",
        },
        secondary: {
          DEFAULT: "rgba(255, 255, 255, 0.08)",
          foreground: "rgb(237, 237, 237)",
        },
        muted: {
          DEFAULT: "rgba(255, 255, 255, 0.06)",
          foreground: "rgb(153, 153, 153)",
        },
        accent: {
          DEFAULT: "rgba(255, 255, 255, 0.12)",
          foreground: "rgb(237, 237, 237)",
        },
        destructive: "#e40014",
        success: "#009767",
        warning: "#dd7400",
        info: "#155dfc",
        pending: "rgb(153, 153, 153)",
        border: "rgba(255, 255, 255, 0.08)",
        input: "rgb(6, 6, 6)",
        ring: "rgba(255, 255, 255, 0.2)",
        surface: "rgb(13, 13, 13)",
        glow: "rgba(255, 255, 255, 0.05)",
        sidebar: {
          DEFAULT: "rgb(13, 13, 13)",
          foreground: "rgb(237, 237, 237)",
          primary: "rgb(237, 237, 237)",
          "primary-foreground": "rgb(9, 9, 9)",
          accent: "rgba(255, 255, 255, 0.08)",
          "accent-foreground": "rgb(237, 237, 237)",
          border: "rgba(255, 255, 255, 0.08)",
          ring: "rgba(255, 255, 255, 0.2)",
        },
        chart: {
          1: "#3e8343",
          2: "#b44d34",
          3: "#00838a",
          4: "#a26a9d",
          5: "#876e37",
        },
      },
      fontFamily: {
        sans: [
          "Geist",
          '"Geist Fallback"',
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        display: [
          "seasonSans",
          '"seasonSans Fallback"',
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
      },
      borderRadius: {
        DEFAULT: "0.875rem",
      },
      animation: {
        "accordion-down":
          "accordion-down var(--motion-duration-standard) var(--motion-ease-standard)",
        "accordion-up":
          "accordion-up var(--motion-duration-standard) var(--motion-ease-standard)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
    },
  },
  plugins: [],
};
