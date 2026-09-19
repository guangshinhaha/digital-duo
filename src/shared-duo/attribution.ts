/**
 * The one line every shared duo answer carries, naming what it is and who
 * owns it (#70 AC1) — appended by answerSharedDuo to every return path
 * (a covered answer, an out-of-scope decline, or a decision decline),
 * never omitted and never driven by anything in the persona file or the
 * environment (#70 AC3: "there is no setting producing an unattributed
 * answer" — there is no parameter anywhere in this module that could
 * suppress it). Deliberately avoids any language that could read as a
 * person, a colleague, or an employee (concept.md §12's own guardrail,
 * echoed as #70's out-of-scope item): "the shared duo" and "an automated
 * reference desk", never a name, a face, or a first-person claim to be
 * the owner.
 */
export function attributionLine(ownerName: string): string {
  return `— the shared duo, an automated reference desk with no personal author, owned by ${ownerName} (accountable for this answer).`;
}

/** Appends the fixed attribution line to `text`, on its own paragraph. The one place this happens, so every return path in answerSharedDuo goes through it rather than each remembering to attach attribution itself. */
export function withAttribution(text: string, ownerName: string): string {
  return `${text}\n\n${attributionLine(ownerName)}`;
}
