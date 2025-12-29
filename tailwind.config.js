/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#1CD17D',
          50: '#B4F5D4',
          100: '#A2F2C9',
          200: '#7DECB4',
          300: '#59E69E',
          400: '#34E089',
          500: '#1CD17D',
          600: '#16A261',
          700: '#107346',
          800: '#0A442A',
          900: '#04150E',
        },
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
};
