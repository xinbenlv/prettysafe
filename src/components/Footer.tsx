export default function Footer() {
  return (
    <footer className="py-8 text-center glass-card border-0 border-t rounded-none">
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
    </footer>
  );
}
