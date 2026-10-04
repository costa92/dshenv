// Names from a team repository or DSH reach the terminal; a raw control or bidi character in one could erase, hide or
// reorder the lines a user reviews, so each is shown as its \u escape. Newlines and tabs are layout and stay.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

export function visibleText(text: string): string {
  return text.replace(HIDDEN, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
