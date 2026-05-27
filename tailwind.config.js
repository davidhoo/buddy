/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        'bg-elevated': 'var(--bg-elevated)',
        'bg-subtle': 'var(--bg-subtle)',
        'bg-muted': 'var(--bg-muted)',
        fg: 'var(--fg)',
        'fg-secondary': 'var(--fg-secondary)',
        'fg-muted': 'var(--fg-muted)',
        'fg-inverse': 'var(--fg-inverse)',
        border: 'var(--border)',
        'border-subtle': 'var(--border-subtle)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-soft': 'var(--accent-soft)',
        'accent-soft-hover': 'var(--accent-soft-hover)',
        'success-bg': 'var(--success-bg)',
        'success-fg': 'var(--success-fg)',
        danger: 'var(--danger)',
        'danger-hover': 'var(--danger-hover)',
        'accent-primary': 'var(--accent-primary)',
        'accent-primary-hover': 'var(--accent-primary-hover)',
        'status-running': 'var(--status-running)',
        'status-paused': 'var(--status-paused)',
        'scrollbar-thumb': 'var(--scrollbar-thumb)',
        'scrollbar-thumb-hover': 'var(--scrollbar-thumb-hover)',
        'actor-claude': 'var(--actor-claude)',
        'actor-codex': 'var(--actor-codex)',
        'actor-opencode': 'var(--actor-opencode)',
        'actor-kimi': 'var(--actor-kimi)',
      }
    }
  },
  plugins: []
}
