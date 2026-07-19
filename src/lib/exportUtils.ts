import type { EvidenceRecord } from './types';

const CSV_COLUMNS: (keyof EvidenceRecord)[] = [
  'id',
  'hormonalProduct',
  'interactingMedication',
  'interactionDirection',
  'potentialConsequence',
  'clinicianConsideration',
  'evidenceLevel',
  'population',
  'sourceTitle',
  'sourceOrganization',
  'sourceUrl',
  'sourceSection',
  'jurisdiction',
  'lastVerified',
  'physicianVerified',
  'limitations',
];

function escapeCsv(value: unknown): string {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export function recordsToCsv(records: EvidenceRecord[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = records.map((r) => CSV_COLUMNS.map((col) => escapeCsv(r[col])).join(','));
  return [header, ...rows].join('\n');
}

export function recordsToJson(records: EvidenceRecord[]): string {
  return JSON.stringify(records, null, 2);
}

// Browser download helper (no-op safe to import in Node; guarded by typeof document).
export function downloadText(filename: string, content: string, mime: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
