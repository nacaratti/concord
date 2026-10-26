const paths: Record<string, string> = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2a5 5 0 0 1-10 0H5Z',
  headphones:
    'M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9Z',
  hangup:
    'M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9a11.5 11.5 0 0 0-2.66 1.85.99.99 0 0 1-1.4 0L.29 13.08a.99.99 0 0 1 0-1.4A16.94 16.94 0 0 1 12 7c4.54 0 8.66 1.78 11.71 4.68a.99.99 0 0 1 0 1.4l-2.48 2.48a.99.99 0 0 1-1.4 0 11.3 11.3 0 0 0-2.67-1.85.99.99 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9Z',
  speaker: 'M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4Z',
}

/** Ícones em SVG; `slashed` desenha o risco vermelho de "desligado". */
export function Icon({ name, size = 20, slashed = false }: { name: keyof typeof paths; size?: number; slashed?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="icon">
      <path d={paths[name]} fill="currentColor" />
      {slashed && <path d="M3 3 21 21" stroke="var(--red)" strokeWidth="2.5" strokeLinecap="round" />}
    </svg>
  )
}
