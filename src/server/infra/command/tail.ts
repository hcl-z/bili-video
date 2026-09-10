
export const tail = (s: string): string =>
  s
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-3)
    .join(' / ')
    .slice(0, 500)
