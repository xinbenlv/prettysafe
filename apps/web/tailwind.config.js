/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        primary: {
          DEFAULT: '#1CD17D',
          50: '#F0FDF7',
          100: '#DCFCE7',
          200: '#BBF7D0',
          300: '#86EFAC',
          400: '#4ADE80',
          500: '#1CD17D',
          600: '#16A261',
          700: '#107346',
          800: '#0A442A',
          900: '#04150E',
        },
        secondary: {
          DEFAULT: '#F0A3B0',
          light: '#F8D4DA',
          dark: '#E07A8A',
        },
        text: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
        },
        surface: {
          white: 'var(--color-surface-white)',
          mint: 'var(--color-surface-mint)',
          border: 'var(--color-surface-border)',
          inner: 'var(--color-surface-inner)',
        },
      },
      boxShadow: {
        'glow': '0 4px 14px 0 rgba(28, 209, 125, 0.39)',
        'glow-lg': '0 6px 20px 0 rgba(28, 209, 125, 0.45)',
        'pink-glow': '0 4px 14px 0 rgba(240, 163, 176, 0.4)',
      },
      borderRadius: {
        '4xl': '2rem',
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
};
