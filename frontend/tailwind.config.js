/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        khmer: {
          50: '#f0f5ff',
          100: '#e0ebff',
          200: '#b8d4ff',
          300: '#7ab3ff',
          400: '#3d8eff',
          500: '#1a6dff',
          600: '#0052e0',
          700: '#003db5',
          800: '#003494',
          900: '#002a7a',
        },
      },
      fontFamily: {
        khmer: ['"Noto Sans Khmer"', '"Battambang"', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
