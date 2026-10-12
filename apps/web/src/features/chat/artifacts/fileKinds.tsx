import { chatFileClass, type ChatFile, type ChatFileClass, type ChatReach } from '@portal/contracts';
import { Archive, File as FileIcon, FileAudio, FileCode2, FileSpreadsheet, FileText, FileType, FileVideo, Globe, Image as ImageIcon, type LucideIcon } from 'lucide-react';

/** The icon for a kind of file. */
const ICONS: Record<ChatFileClass, LucideIcon> = {
  image: ImageIcon,
  pdf: FileType,
  audio: FileAudio,
  video: FileVideo,
  text: FileCode2,
  html: Globe,
  archive: Archive,
  sheet: FileSpreadsheet,
  doc: FileText,
  file: FileIcon,
};

export const kindOf = (file: Pick<ChatFile, 'mediaType' | 'name'>): ChatFileClass => chatFileClass(file.mediaType, file.name);
export const iconFor = (file: Pick<ChatFile, 'mediaType' | 'name'>): LucideIcon => ICONS[kindOf(file)];

/** "850 B", "12 KB", "3.4 MB" (decimal units, like the limits). */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 999.5 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 9.95 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * What Claude can't do with an attachment, for the one note that needs saying (an InfoTip on the tile): it
 * can't listen to audio or watch video, and can't open an archive or an Office file itself. Null when there
 * is nothing to warn about (an image it sees, text and PDFs it opens).
 */
export function limitNote(file: Pick<ChatFile, 'mediaType' | 'name'> & { reach?: ChatReach }): string | null {
  if (file.reach !== 'path') return null;
  const kind = kindOf(file);
  if (kind === 'audio') return 'Claude can’t listen to audio. It gets the file’s path and can run tools on it, such as a transcriber.';
  if (kind === 'video') return 'Claude can’t watch video. It gets the file’s path and can run tools on it, such as ffmpeg.';
  if (kind === 'image') return 'Claude isn’t shown this picture (too large or an unsupported format). It gets the file’s path.';
  return 'Claude can’t open this kind of file itself. It gets the file’s path and can run tools on it.';
}
