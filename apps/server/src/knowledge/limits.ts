// Knowledge: the caps every path, write and import is held to (Knowledge PRD §17.3). Defaults are the
// PRD's; `PORTAL_KNOWLEDGE_*` can lower or raise the size caps, never the path rules.

export interface KnowledgeLimits {
  /** A note, in bytes. */
  noteBytes: number;
  /** One agent write (a note body, an edit, an append), in bytes. */
  agentWriteBytes: number;
  /** One attachment. */
  attachmentBytes: number;
  /** Files (notes and attachments) in one vault. */
  vaultFiles: number;
  /** A vault's total size. */
  vaultBytes: number;
  /** Frontmatter, in bytes (a block longer than this isn't read as frontmatter). */
  frontmatterBytes: number;
  /** Frontmatter properties kept in the index, as JSON. */
  propsBytes: number;
  /** Links kept in the index for one note. */
  linksPerNote: number;
  /** Tags kept in the index for one note. */
  tagsPerNote: number;
  /** A zip upload, packed and unpacked, and the largest compression ratio accepted. */
  importPackedBytes: number;
  importUnpackedBytes: number;
  importRatio: number;
  /** Versions kept per note, and the journal's size per vault. */
  versionsPerNote: number;
  journalBytesPerVault: number;
  /** Edits by one actor to one note within this many ms update the newest history row (autosave). */
  coalesceMs: number;
  /** A search query, and results per call (API and MCP). */
  queryChars: number;
  searchApiLimit: number;
  searchMcpLimit: number;
  /** Characters in one text block returned over MCP (the Portal MCP's own cap on a labelled text field). */
  mcpTextChars: number;
  /** How long a deleted vault stays in `trash/`, and how long a deleted note stays restorable. */
  trashVaultDays: number;
  deletedNoteDays: number;
}

const MiB = 1024 * 1024;

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function knowledgeLimits(env: NodeJS.ProcessEnv = process.env): KnowledgeLimits {
  const mib = (name: string, fallbackMib: number, minMib: number, maxMib: number) => int(env, name, fallbackMib, minMib, maxMib) * MiB;
  return {
    noteBytes: mib('PORTAL_KNOWLEDGE_MAX_NOTE_MB', 1, 1, 16),
    agentWriteBytes: 256 * 1024,
    attachmentBytes: mib('PORTAL_KNOWLEDGE_MAX_ATTACHMENT_MB', 25, 1, 200),
    // A vault exports as one classic zip, which holds at most 65,535 entries.
    vaultFiles: int(env, 'PORTAL_KNOWLEDGE_MAX_FILES', 60_000, 100, 60_000),
    vaultBytes: mib('PORTAL_KNOWLEDGE_MAX_VAULT_MB', 2048, 10, 100_000),
    frontmatterBytes: 32 * 1024,
    propsBytes: 4 * 1024,
    linksPerNote: 5000,
    tagsPerNote: 200,
    importPackedBytes: mib('PORTAL_KNOWLEDGE_IMPORT_MB', 100, 1, 1024),
    importUnpackedBytes: mib('PORTAL_KNOWLEDGE_IMPORT_UNPACKED_MB', 500, 1, 4096),
    importRatio: 100,
    versionsPerNote: 200,
    journalBytesPerVault: 256 * MiB,
    coalesceMs: 5 * 60_000,
    queryChars: 256,
    searchApiLimit: 100,
    searchMcpLimit: 50,
    mcpTextChars: 8_000,
    trashVaultDays: 14,
    deletedNoteDays: 30,
  };
}
