export interface AcousticSpeakerStyle {
  align: string;
  bubble: string;
  dot: string;
}

export const ACOUSTIC_SPEAKER_STYLES: AcousticSpeakerStyle[] = [
  { align: 'items-start', bubble: 'border-navy/20 bg-navy/5', dot: 'bg-navy' },
  { align: 'items-end', bubble: 'border-teal/20 bg-teal/5', dot: 'bg-teal' },
  { align: 'items-start', bubble: 'border-amber/30 bg-amber/5', dot: 'bg-amber' },
  { align: 'items-end', bubble: 'border-line bg-canvas', dot: 'bg-ink-faint' },
];

export function acousticSpeakerStyleIndex(label: string): number {
  const normalized = label.trim().replace(/^speaker\s+/i, '');
  if (/^[a-z]$/i.test(normalized)) {
    return (normalized.toUpperCase().charCodeAt(0) - 65) % ACOUSTIC_SPEAKER_STYLES.length;
  }
  if (/^\d+$/.test(normalized)) {
    return Number(normalized) % ACOUSTIC_SPEAKER_STYLES.length;
  }

  let hash = 0;
  for (const character of normalized) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % ACOUSTIC_SPEAKER_STYLES.length;
}

export function acousticSpeakerStyle(label: string): AcousticSpeakerStyle {
  return ACOUSTIC_SPEAKER_STYLES[acousticSpeakerStyleIndex(label)];
}

export function acousticSpeakerDisplayLabel(label: string): string {
  const normalized = label.trim();
  if (!normalized) return 'Speaker';
  return /^speaker(?:\s|$)/i.test(normalized) ? normalized : `Speaker ${normalized}`;
}
