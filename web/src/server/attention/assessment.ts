import type { AttentionKind } from '../../contracts/attention.ts';

/** Where an explanation may point. The host maps these to existing navigation for the item's own subject; a model never supplies
 * a URL, command or target. */
export type AssessmentSurface = 'control_access' | 'plan_checkpoint' | 'launch_card' | 'none';
export const surfacesFor = (kind: AttentionKind): AssessmentSurface[] =>
  kind === 'run' ? ['control_access', 'none'] : kind === 'plan' ? ['plan_checkpoint', 'control_access', 'none'] : ['launch_card', 'none'];
/** The host's binding of one attempt: the item revision it was asked about, and the evidence IDs actually served to it, each
 * minted by the host for that attempt and mapped to the exact source and revision returned. */
export interface AssessmentBinding {
  itemId: string; itemRevision: number; kind: AttentionKind;
  served: ReadonlyMap<string, { source: string; revision: string }>;
}
export interface Assessment {
  itemId: string; itemRevision: number; summary: string; likelyCause: string; nextSteps: string[]; uncertainties: string[];
  evidence: { id: string; note: string; source: string; revision: string }[];
  surface: AssessmentSurface;
}
/** The schema a structured CLI answer is asked to follow: a strict subset (every property required, nothing extra, no length
 * keywords). It is a request to the model; validateAssessment is the authority. */
export const ASSESSMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['itemId', 'itemRevision', 'summary', 'likelyCause', 'nextSteps', 'uncertainties', 'evidence', 'surface'],
  properties: {
    itemId: { type: 'string' }, itemRevision: { type: 'integer' }, summary: { type: 'string' }, likelyCause: { type: 'string' },
    nextSteps: { type: 'array', items: { type: 'string' } }, uncertainties: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'note'], properties: { id: { type: 'string' }, note: { type: 'string' } } } },
    surface: { type: 'string', enum: ['control_access', 'plan_checkpoint', 'launch_card', 'none'] },
  },
} as const;
export class AssessmentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const KEYS = ASSESSMENT_SCHEMA.required;
// C0 and C1 controls except newline, and bidirectional overrides that could disguise rendered text.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
function line(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) throw new AssessmentError('ASSESSMENT_FIELD', `${field} must be 1 to ${max} characters of plain text.`);
  return value;
}
function array(value: unknown, field: string, minItems: number, maxItems: number): unknown[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) throw new AssessmentError('ASSESSMENT_FIELD', `${field} must list ${minItems} to ${maxItems} entries.`);
  return value;
}
const lines = (value: unknown, field: string): string[] => array(value, field, 0, 4).map((item, index) => line(item, `${field}[${index}]`, 200));
/** Strictly validates a model's assessment against the attempt's binding. Invalid answers are rejected whole: a bad citation is never
 * dropped to salvage the rest. A valid assessment proves provenance of its citations, not the truth of its interpretation, and it
 * grants nothing: it cannot approve, resolve, certify readiness or act. */
export function validateAssessment(value: unknown, binding: AssessmentBinding): Assessment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssessmentError('ASSESSMENT_SHAPE', 'An assessment is one JSON object.');
  if (Buffer.byteLength(JSON.stringify(value)) > 8192) throw new AssessmentError('ASSESSMENT_SIZE', 'An assessment exceeds 8 KiB.');
  const b = value as Record<string, unknown>, keys = Object.keys(b);
  if (keys.length !== KEYS.length || !KEYS.every((key) => keys.includes(key))) throw new AssessmentError('ASSESSMENT_SHAPE', `An assessment has exactly the fields ${KEYS.join(', ')}.`);
  // Echoed identity must match the host's binding exactly; it is a consistency check that grants no authority.
  if (b.itemId !== binding.itemId || b.itemRevision !== binding.itemRevision) throw new AssessmentError('ASSESSMENT_BINDING', 'The answer names another item or revision.');
  if (typeof b.surface !== 'string' || !(surfacesFor(binding.kind) as string[]).includes(b.surface)) throw new AssessmentError('ASSESSMENT_SURFACE', 'The suggested destination does not fit this item.');
  const evidence = array(b.evidence, 'evidence', 1, 6).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).sort().join() !== 'id,note') throw new AssessmentError('ASSESSMENT_FIELD', `evidence[${index}] has exactly id and note.`);
    const { id, note } = entry as { id: unknown; note: unknown };
    const served = typeof id === 'string' ? binding.served.get(id) : undefined;
    if (!served) throw new AssessmentError('ASSESSMENT_EVIDENCE', `evidence[${index}] cites a reply this attempt was not served.`);
    return { id: id as string, note: line(note, `evidence[${index}].note`, 200), ...served };
  });
  if (new Set(evidence.map((e) => e.id)).size !== evidence.length) throw new AssessmentError('ASSESSMENT_EVIDENCE', 'Each evidence reply is cited once.');
  return { itemId: binding.itemId, itemRevision: binding.itemRevision, summary: line(b.summary, 'summary', 300), likelyCause: line(b.likelyCause, 'likelyCause', 600),
    nextSteps: lines(b.nextSteps, 'nextSteps'), uncertainties: lines(b.uncertainties, 'uncertainties'),
    evidence, surface: b.surface as AssessmentSurface };
}
