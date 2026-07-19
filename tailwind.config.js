/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#f7f6f2',
        surface: '#ffffff',
        navy: {
          DEFAULT: '#12233b',
          soft: '#24384f',
        },
        teal: {
          DEFAULT: '#0f7d78',
          soft: '#3a9b96',
        },
        amber: {
          DEFAULT: '#b7791f',
          soft: '#d9a441',
        },
        danger: {
          DEFAULT: '#a02b2b',
        },
        ink: {
          muted: '#5a6675',
          faint: '#8b95a3',
        },
        line: '#e2ded5',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
