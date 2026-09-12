/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          muted: 'hsl(var(--primary-muted))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        // Risk levels. Always paired with an icon and a text label in the UI -
        // colour alone must never carry the meaning.
        risk: {
          low: 'hsl(var(--risk-low))',
          'low-bg': 'hsl(var(--risk-low-bg))',
          'low-border': 'hsl(var(--risk-low-border))',
          medium: 'hsl(var(--risk-medium))',
          'medium-bg': 'hsl(var(--risk-medium-bg))',
          'medium-border': 'hsl(var(--risk-medium-border))',
          high: 'hsl(var(--risk-high))',
          'high-bg': 'hsl(var(--risk-high-bg))',
          'high-border': 'hsl(var(--risk-high-border))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 4px)',
        '2xl': 'calc(var(--radius) + 10px)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        // Elderly-mode scale, used by the simplified interface.
        'elder-sm': ['1.125rem', { lineHeight: '1.75rem' }],
        'elder-base': ['1.375rem', { lineHeight: '2rem' }],
        'elder-lg': ['1.75rem', { lineHeight: '2.25rem' }],
        'elder-xl': ['2.25rem', { lineHeight: '2.5rem' }],
        'elder-2xl': ['3rem', { lineHeight: '1.1' }],
        'elder-3xl': ['4rem', { lineHeight: '1.05' }],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(16 24 40 / 0.04), 0 1px 3px 0 rgb(16 24 40 / 0.06)',
        'card-hover': '0 4px 8px -2px rgb(16 24 40 / 0.08), 0 2px 4px -2px rgb(16 24 40 / 0.04)',
        panel: '0 8px 24px -4px rgb(16 24 40 / 0.10), 0 4px 8px -4px rgb(16 24 40 / 0.06)',
        focus: '0 0 0 3px hsl(var(--ring) / 0.35)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        // A slow, calm pulse for high-risk emphasis. Deliberately gentle:
        // this interface must convey urgency without alarming an 80-year-old.
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.72' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.96)', opacity: '0.7' },
          '70%': { transform: 'scale(1.06)', opacity: '0' },
          '100%': { transform: 'scale(1.06)', opacity: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'fade-in': 'fade-in 0.25s ease-out',
        'slide-up': 'slide-up 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-soft': 'pulse-soft 2.4s ease-in-out infinite',
        'pulse-ring': 'pulse-ring 2.4s cubic-bezier(0.16, 1, 0.3, 1) infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
