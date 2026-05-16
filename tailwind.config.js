/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['PingFang-SC', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        primary: {
          DEFAULT: '#0052D9',
          hover: '#266FE8',
          light: '#4787F0',
        },
        sidebar: {
          DEFAULT: '#1B2838',
          hover: '#243447',
        },
        success: '#00A870',
        danger: '#E34D59',
        warning: '#ED7B2F',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
  ],
}
