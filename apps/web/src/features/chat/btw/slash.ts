import { BTW_COMMAND } from '@portal/contracts';

/** A chat command typed in the composer ("/btw …"). Built as a list so other commands can join later; only the ones with a `run` handler act, the rest stay plain text. */
export interface SlashCommand {
  /** Without the slash. */
  name: string;
  /** One or two words; the suggestion's second line. */
  hint: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [{ name: BTW_COMMAND.slice(1), hint: 'Side question' }];

/** The suggestions for what is typed: only while the text is "/" and the start of a command word (no space yet). */
export function slashMatches(text: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const m = /^\/([a-z]*)$/i.exec(text);
  if (!m) return [];
  const word = m[1]!.toLowerCase();
  return commands.filter((c) => c.name.startsWith(word));
}

/** "/btw some question" -> { name: 'btw', rest: 'some question' }; null when the text isn't a command line. */
export function parseSlash(text: string): { name: string; rest: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { name: m[1]!.toLowerCase(), rest: (m[2] ?? '').trim() } : null;
}
