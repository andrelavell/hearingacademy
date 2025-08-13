export function clamp(str, max) {
  const s = String(str || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + '…';
}

export function ensureSeoFields({ title, description }) {
  return {
    title: clamp(title, 60),
    description: clamp(description, 160),
  };
}
