/** Detect foreign letters in the current caption, including mixed-script lines.
 * Numbers, punctuation, whitespace and emoji do not need translation.
 */
export function needsKhmerTranslation(text: string): boolean {
  return /\p{L}/u.test(text.replace(/\p{Script=Khmer}/gu, ''));
}
