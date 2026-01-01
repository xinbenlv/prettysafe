export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="py-8 text-center glass-card border-0 border-t rounded-none space-y-3">
      <p style={{ color: 'var(--color-text-secondary)' }}>
        Built w/ ❤️ by{' '}
        <a
          href="https://prettysafe.xyz"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:text-primary-600 transition-colors underline underline-offset-2"
        >
          Project PrettySafe
        </a>
      </p>
      <p className="text-xs" style={{ color: 'var(--color-text-secondary)', opacity: 0.7 }}>
        © {currentYear} PrettySafe •{' '}
        <a
          href="https://github.com/xinbenlv/prettysafe/blob/main/LICENSE"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-primary transition-colors"
        >
          MIT License
        </a>
      </p>
      <p className="text-xs max-w-2xl mx-auto px-4" style={{ color: 'var(--color-text-secondary)', opacity: 0.7 }}>
        This project is a Public Good and open source contribution to the Safe ecosystem.
        It is not associated with nor endorsed by{' '}
        <a
          href="https://safe.global"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-primary transition-colors"
        >
          Safe.Global
        </a>
        {' '}or the <a href="https://safe.foundation" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-primary transition-colors">Safe Foundation</a>.
        <a
          href="https://safe.foundation"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-primary transition-colors"
        >
          Safe Foundation
        </a>
      </p>
    </footer>
  );
}
