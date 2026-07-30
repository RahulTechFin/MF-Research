/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Canvas (dark theme) — P8
        'bg-base':   '#0B1120',
        'bg-card':   '#111A2E',
        'bg-raised': '#18233C',
        'line':      '#24314F',
        'text-hi':   '#F1F5FB',
        'text-mid':  '#9FB0CC',
        'text-low':  '#5E6F8F',
        // Identity colors
        equity:    '#3B82F6',
        hybrid:    '#8B5CF6',
        debt:      '#14B8A6',
        other:     '#F59E0B',
        'accent-a':'#22D3EE',
        'accent-b':'#F472B6',
        gain:      '#34D399',
        loss:      '#F87171',
        // Quartile colors
        q1: '#16A34A',
        q2: '#edb91aff',
        q3: '#FB923C',
        q4: '#DC2626',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        ui:      ['"Inter"', 'sans-serif'],
      },
      borderRadius: {
        card: '10px',
      },
      boxShadow: {
        card: '0 4px 24px 0 rgba(0,0,0,0.45)',
        glow: '0 0 20px 0 rgba(34,211,238,0.15)',
      },
      transitionDuration: {
        DEFAULT: '140ms',
      },
    },
  },
  plugins: [],
}
