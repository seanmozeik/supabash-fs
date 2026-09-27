/** Only html-to-markdown uses this module; the default command policy denies it. */
export default function BlockedTurndown(): never {
  throw new Error('html-to-markdown is not included in the Supabash Edge package.');
}
