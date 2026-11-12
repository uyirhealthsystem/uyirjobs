export const fmt = n => Number(n || 0).toLocaleString('en-IN');
export const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '—');
export const when = s => (s ? new Date(s).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const kb = bytes => `${Math.max(1, Math.round(bytes / 1024))} KB`;
