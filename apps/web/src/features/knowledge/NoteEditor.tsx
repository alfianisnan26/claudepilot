import { Button, Dialog, cn, useToast } from '@isnanme/ui';
import type { NoteQuickHit, NoteView, WriteNoteResult } from '@portal/contracts';
import { AlertTriangle, Bold, CheckSquare, GitCompare, Hash, Heading, IndentDecrease, IndentIncrease, Italic, Link2, List, Paperclip, Redo2, Undo2 } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { conflictOf, errorText, knowledgeApi } from './api';
import { diffLines, useDebounced } from './hooks';

export type EditStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

export interface EditorHandle {
  /** Saves what is pending now; resolves when it is done (or failed). */
  flush: () => Promise<void>;
}

interface Theirs {
  version: string | null;
  content: string | null;
  deleted: boolean;
}

/** Replaces `start..end` with `text` through the browser's own edit (so Undo works), then places the caret. */
function replaceRange(el: HTMLTextAreaElement, start: number, end: number, text: string, caret?: [number, number?]) {
  el.focus();
  el.setSelectionRange(start, end);
  const done = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  if (!done) {
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (caret) el.setSelectionRange(caret[0], caret[1] ?? caret[0]);
}

const lineBounds = (value: string, pos: number): [number, number] => {
  const start = value.lastIndexOf('\n', pos - 1) + 1;
  const end = value.indexOf('\n', pos);
  return [start, end < 0 ? value.length : end];
};

/** Enter in a list item starts the next item; Enter on an empty item ends the list. */
function continueList(el: HTMLTextAreaElement): boolean {
  const { value, selectionStart: s, selectionEnd: e } = el;
  if (s !== e) return false;
  const [from, to] = lineBounds(value, s);
  const before = value.slice(from, s);
  const m = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/.exec(before);
  if (!m) return false;
  const rest = before.slice(m[0].length);
  if (!rest.trim() && !value.slice(s, to).trim()) {
    replaceRange(el, from, to, '', [from]);
    return true;
  }
  const marker = /^\d/.test(m[2]!) ? `${parseInt(m[2]!, 10) + 1}${m[2]!.slice(-1)}` : m[2]!;
  replaceRange(el, s, s, `\n${m[1]}${marker}${m[3]}${m[4] ? '[ ] ' : ''}`);
  return true;
}

function indentLines(el: HTMLTextAreaElement, outdent: boolean) {
  const { value, selectionStart: s, selectionEnd: e } = el;
  const [from] = lineBounds(value, s);
  const [, to] = lineBounds(value, e > s && value[e - 1] === '\n' ? e - 1 : e);
  const lines = value.slice(from, to).split('\n');
  const changed = lines.map((l) => (outdent ? l.replace(/^( {1,2}|\t)/, '') : `  ${l}`));
  const next = changed.join('\n');
  if (next === lines.join('\n')) return;
  const first = changed[0]!.length - lines[0]!.length;
  replaceRange(el, from, to, next, [Math.max(from, s + first), Math.max(from, e + (next.length - (to - from)))]);
}

function wrap(el: HTMLTextAreaElement, mark: string) {
  const { value, selectionStart: s, selectionEnd: e } = el;
  const sel = value.slice(s, e);
  if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= mark.length * 2) replaceRange(el, s, e, sel.slice(mark.length, -mark.length), [s, e - mark.length * 2]);
  else replaceRange(el, s, e, `${mark}${sel}${mark}`, sel ? [s + mark.length, e + mark.length] : [s + mark.length]);
}

function prefixLines(el: HTMLTextAreaElement, prefix: string) {
  const { value, selectionStart: s, selectionEnd: e } = el;
  const [from] = lineBounds(value, s);
  const [, to] = lineBounds(value, e);
  const lines = value.slice(from, to).split('\n');
  const all = lines.every((l) => l.startsWith(prefix));
  const next = lines.map((l) => (all ? l.slice(prefix.length) : l.startsWith(prefix) ? l : `${prefix}${l}`)).join('\n');
  replaceRange(el, from, to, next, [s + (all ? -prefix.length : prefix.length), e + (next.length - lines.join('\n').length)]);
}

function cycleHeading(el: HTMLTextAreaElement) {
  const { value, selectionStart: s } = el;
  const [from, to] = lineBounds(value, s);
  const line = value.slice(from, to);
  const m = /^(#{1,6}) /.exec(line);
  const level = m ? m[1]!.length : 0;
  const next = level >= 3 ? line.replace(/^#{1,6} /, '') : `${'#'.repeat(level + 1)} ${m ? line.slice(m[0].length) : line}`;
  replaceRange(el, from, to, next, [from + next.length]);
}

const SuggestLimit = 5;

/**
 * The editor: a plain text area with a touch-sized toolbar, list continuation, `[[` suggestions from the vault,
 * and saving that never loses text. It saves a moment after the last keystroke, with the version it started
 * from; if the note changed meanwhile, the save is refused and the writer chooses (theirs, mine, or compare).
 */
export const NoteEditor = forwardRef<EditorHandle, { vaultId: string; path: string; view: NoteView | null; attachments: string; onStatus: (s: EditStatus) => void; onSaved: (r: WriteNoteResult, content: string) => void }>(
  function NoteEditor({ vaultId, path, view, attachments, onStatus, onSaved }, ref) {
    const toast = useToast();
    const area = useRef<HTMLTextAreaElement>(null);
    const picker = useRef<HTMLInputElement>(null);
    const startText = view ? view.content : '';
    const [text, setText] = useState(startText);
    const textRef = useRef(startText);
    const base = useRef<{ version: string | null; content: string }>({ version: view?.version ?? null, content: startText });
    const saving = useRef(false);
    const again = useRef(false);
    const [status, setStatus] = useState<EditStatus>('saved');
    const [theirs, setTheirs] = useState<Theirs | null>(null);
    const [compare, setCompare] = useState(false);
    const [suggest, setSuggest] = useState<{ from: number; to: number; items: NoteQuickHit[] } | null>(null);
    const suggestSeq = useRef(0);

    // The callbacks change with every render of the page around; saving must not (it would flush on each keystroke).
    const latest = useRef({ onStatus, onSaved, toast });
    latest.current = { onStatus, onSaved, toast };
    const update = useCallback((s: EditStatus) => {
      setStatus(s);
      latest.current.onStatus(s);
    }, []);

    const save = useCallback(async () => {
      if (saving.current) {
        again.current = true;
        return;
      }
      const content = textRef.current;
      const b = base.current;
      if ((content === b.content && b.version) || (!content && !b.version)) {
        update('saved');
        return;
      }
      saving.current = true;
      update('saving');
      try {
        const r = await knowledgeApi.putNote(vaultId, path, b.version ? { content, baseVersion: b.version } : { content, create: true });
        base.current = { version: r.version, content };
        setTheirs(null);
        latest.current.onSaved(r, content);
        if (r.warnings[0]) latest.current.toast(r.warnings[0]);
        update(textRef.current === content ? 'saved' : 'dirty');
      } catch (e) {
        const c = conflictOf(e);
        if (c) {
          setTheirs({ version: c.currentVersion, content: c.content, deleted: c.deleted });
          update('conflict');
        } else {
          update('error');
          latest.current.toast(errorText(e, 'Could not save.'), 'error');
        }
      } finally {
        saving.current = false;
        if (again.current) {
          again.current = false;
          void save();
        }
      }
    }, [vaultId, path, update]);
    const saveRef = useRef(save);
    saveRef.current = save;

    const { call: scheduleSave, cancel: cancelSave } = useDebounced(() => void saveRef.current(), 1200);
    useImperativeHandle(
      ref,
      () => ({
        flush: async () => {
          cancelSave();
          await saveRef.current();
        },
      }),
      [cancelSave],
    );

    // Leaving the editor (or the tab) saves what is pending.
    useEffect(() => {
      const hide = () => {
        if (document.visibilityState !== 'hidden') return;
        cancelSave();
        void saveRef.current();
      };
      document.addEventListener('visibilitychange', hide);
      return () => {
        document.removeEventListener('visibilitychange', hide);
        cancelSave();
        void saveRef.current();
      };
    }, [cancelSave]);

    // The note changed elsewhere while this was open: take it when there is nothing of mine, else offer the choice.
    useEffect(() => {
      if (!view || view.version === base.current.version) return;
      if (textRef.current === base.current.content) {
        base.current = { version: view.version, content: view.content };
        textRef.current = view.content;
        setText(view.content);
        update('saved');
      } else {
        setTheirs({ version: view.version, content: view.content, deleted: false });
        update('conflict');
      }
    }, [view, update]);

    const change = (value: string) => {
      textRef.current = value;
      setText(value);
      if (status !== 'conflict') update('dirty');
      scheduleSave();
    };

    const checkSuggest = () => {
      const el = area.current;
      if (!el || el.selectionStart !== el.selectionEnd) return setSuggest(null);
      const caret = el.selectionStart;
      const m = /\[\[([^[\]\n|#]*)$/.exec(el.value.slice(Math.max(0, caret - 80), caret));
      if (!m) return setSuggest(null);
      const from = caret - m[0].length;
      const seq = ++suggestSeq.current;
      void knowledgeApi
        .quick(vaultId, m[1]!)
        .then((items) => seq === suggestSeq.current && setSuggest({ from, to: caret, items: items.slice(0, SuggestLimit) }))
        .catch(() => undefined);
    };

    const choose = (hit: NoteQuickHit) => {
      const el = area.current;
      if (!el || !suggest) return;
      const name = hit.kind === 'note' ? hit.path.replace(/\.md$/i, '').split('/').pop()! : hit.path;
      const hasClose = el.value.slice(suggest.to, suggest.to + 2) === ']]';
      replaceRange(el, suggest.from, suggest.to + (hasClose ? 2 : 0), `[[${name}]]`);
      setSuggest(null);
    };

    /** Uploads a file into the vault's attachments folder (a free name) and embeds it where the caret is. */
    const attach = async (file: File) => {
      const clean = file.name.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/^\.+/, '') || 'file';
      const dot = clean.lastIndexOf('.');
      const stem = dot > 0 ? clean.slice(0, dot) : clean;
      const ext = dot > 0 ? clean.slice(dot) : '';
      for (let n = 1; n <= 6; n++) {
        const name = n === 1 ? clean : `${stem}-${n}${ext}`;
        try {
          const r = await knowledgeApi.uploadFile(vaultId, attachments ? `${attachments}/${name}` : name, file);
          const el = area.current;
          if (el) replaceRange(el, el.selectionStart, el.selectionEnd, `![[${r.path.split('/').pop()}]]`);
          return;
        } catch (e) {
          if (conflictOf(e) || (e as { status?: number }).status === 409) continue;
          latest.current.toast(errorText(e, 'Could not attach it.'), 'error');
          return;
        }
      }
      latest.current.toast('Could not find a free name.', 'error');
    };

    const act = (fn: (el: HTMLTextAreaElement) => void) => () => {
      const el = area.current;
      if (el) fn(el);
    };

    const useTheirs = () => {
      if (!theirs) return;
      base.current = { version: theirs.version, content: theirs.content ?? '' };
      textRef.current = theirs.content ?? '';
      setText(theirs.content ?? '');
      setTheirs(null);
      update('saved');
    };
    const keepMine = () => {
      if (!theirs) return;
      base.current = { version: theirs.deleted ? null : theirs.version, content: theirs.deleted ? '' : (theirs.content ?? '') };
      setTheirs(null);
      update('dirty');
      void save();
    };

    return (
      <div className="flex h-full min-h-0 flex-col">
        {status === 'conflict' && theirs && (
          <div role="alert" className="flex items-center gap-2 border-b border-line bg-amber-500/10 px-3 py-1.5 text-[13px] font-medium">
            <AlertTriangle className="size-4 shrink-0 text-amber-600" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{theirs.deleted ? 'Deleted elsewhere' : 'Changed elsewhere'}</span>
            {!theirs.deleted && (
              <button type="button" title="Compare" aria-label="Compare" onClick={() => setCompare(true)} className="press inline-flex size-8 items-center justify-center rounded-lg hover:bg-surface-2">
                <GitCompare className="size-4" />
              </button>
            )}
            {!theirs.deleted && (
              <Button size="sm" variant="secondary" onClick={useTheirs}>
                Theirs
              </Button>
            )}
            <Button size="sm" onClick={keepMine}>
              Mine
            </Button>
          </div>
        )}
        <textarea
          ref={area}
          value={text}
          onChange={(e) => change(e.target.value)}
          onKeyUp={checkSuggest}
          onClick={checkSuggest}
          onKeyDown={(e) => {
            const el = e.currentTarget;
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing && continueList(el)) e.preventDefault();
            else if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && /^\s*([-*+]|\d+[.)])\s/.test(el.value.slice(lineBounds(el.value, el.selectionStart)[0], el.selectionStart))) {
              e.preventDefault();
              indentLines(el, e.shiftKey);
            } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              cancelSave();
              void save();
            }
          }}
          spellCheck
          aria-label="Note text"
          placeholder="Start writing"
          className="min-h-0 w-full flex-1 resize-none bg-transparent px-4 py-3 text-[16px] leading-[1.6] text-ink outline-hidden placeholder:text-muted sm:text-[14.5px]"
        />
        {suggest && suggest.items.length > 0 && (
          <ul className="flex gap-1.5 overflow-x-auto border-t border-line bg-surface px-2 py-1.5 [scrollbar-width:none]" aria-label="Links">
            {suggest.items.map((h) => (
              <li key={h.path} className="shrink-0">
                <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={() => choose(h)} className="press max-w-[14rem] truncate rounded-lg bg-surface-2 px-2.5 py-1.5 text-[13px] font-medium">
                  {h.alias ? `${h.alias} → ${h.name}` : h.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={picker}
          type="file"
          accept="image/*,application/pdf,audio/*,video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void attach(f);
          }}
        />
        <div role="toolbar" aria-label="Format" className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-t border-line bg-surface px-1.5 py-1 [scrollbar-width:none]">
          <Tool label="Heading" onClick={act(cycleHeading)}>
            <Heading className="size-[18px]" />
          </Tool>
          <Tool label="Bold" onClick={act((el) => wrap(el, '**'))}>
            <Bold className="size-[18px]" />
          </Tool>
          <Tool label="Italic" onClick={act((el) => wrap(el, '*'))}>
            <Italic className="size-[18px]" />
          </Tool>
          <Tool label="List" onClick={act((el) => prefixLines(el, '- '))}>
            <List className="size-[18px]" />
          </Tool>
          <Tool label="Task" onClick={act((el) => prefixLines(el, '- [ ] '))}>
            <CheckSquare className="size-[18px]" />
          </Tool>
          <Tool label="Link to a note" onClick={act((el) => replaceRange(el, el.selectionStart, el.selectionEnd, `[[${el.value.slice(el.selectionStart, el.selectionEnd)}]]`, [el.selectionStart + 2 + (el.selectionEnd - el.selectionStart)]))}>
            <Link2 className="size-[18px]" />
          </Tool>
          <Tool label="Tag" onClick={act((el) => replaceRange(el, el.selectionStart, el.selectionEnd, '#'))}>
            <Hash className="size-[18px]" />
          </Tool>
          <Tool label="Attach a file" onClick={() => picker.current?.click()}>
            <Paperclip className="size-[18px]" />
          </Tool>
          <Tool label="Indent" onClick={act((el) => indentLines(el, false))}>
            <IndentIncrease className="size-[18px]" />
          </Tool>
          <Tool label="Outdent" onClick={act((el) => indentLines(el, true))}>
            <IndentDecrease className="size-[18px]" />
          </Tool>
          <span className="mx-1 h-5 w-px shrink-0 bg-line" aria-hidden="true" />
          <Tool label="Undo" onClick={act((el) => (el.focus(), document.execCommand('undo')))}>
            <Undo2 className="size-[18px]" />
          </Tool>
          <Tool label="Redo" onClick={act((el) => (el.focus(), document.execCommand('redo')))}>
            <Redo2 className="size-[18px]" />
          </Tool>
        </div>
        {compare && theirs?.content !== null && theirs && <CompareDialog mine={text} theirs={theirs.content ?? ''} onClose={() => setCompare(false)} />}
      </div>
    );
  },
);

function Tool({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      // Keep the text area focused (and the keyboard up) when a tool is tapped.
      onPointerDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn('press inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-ink-soft hover:bg-surface-2 hover:text-ink sm:size-9')}
    >
      {children}
    </button>
  );
}

/** What differs between the text on the server and mine, line by line. */
export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  if (!lines) return <p className="text-[13px] text-muted">Too long to compare.</p>;
  // Collapse long unchanged stretches.
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.kind === 'same') {
      let j = i;
      while (j < lines.length && lines[j]!.kind === 'same') j++;
      const run = lines.slice(i, j);
      const keepHead = i === 0 ? 0 : 2;
      const keepTail = j === lines.length ? 0 : 2;
      if (run.length > keepHead + keepTail + 1) {
        run.slice(0, keepHead).forEach((r, k) => out.push(<DiffRow key={`${i}h${k}`} kind="same" text={r.text} />));
        out.push(
          <div key={`${i}gap`} className="px-3 py-0.5 text-[11.5px] text-muted">
            {run.length - keepHead - keepTail} unchanged lines
          </div>,
        );
        run.slice(run.length - keepTail).forEach((r, k) => out.push(<DiffRow key={`${i}t${k}`} kind="same" text={r.text} />));
      } else run.forEach((r, k) => out.push(<DiffRow key={`${i}s${k}`} kind="same" text={r.text} />));
      i = j;
    } else {
      out.push(<DiffRow key={i} kind={l.kind} text={l.text} />);
      i++;
    }
  }
  return <div className="overflow-x-auto rounded-xl border border-line bg-surface-2/40 py-1 font-mono text-[12.5px] leading-relaxed">{out}</div>;
}

function DiffRow({ kind, text }: { kind: 'same' | 'add' | 'del'; text: string }) {
  return (
    <div className={cn('flex min-w-0 gap-2 px-3', kind === 'add' && 'bg-emerald-500/15', kind === 'del' && 'bg-red-500/15')}>
      <span aria-hidden="true" className="w-3 shrink-0 text-muted select-none">
        {kind === 'add' ? '+' : kind === 'del' ? '-' : ''}
      </span>
      <span className="min-w-0 break-words whitespace-pre-wrap">{text || ' '}</span>
      <span className="sr-only">{kind === 'add' ? 'added' : kind === 'del' ? 'removed' : ''}</span>
    </div>
  );
}

function CompareDialog({ mine, theirs, onClose }: { mine: string; theirs: string; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} title="Theirs → mine">
      <DiffView before={theirs} after={mine} />
    </Dialog>
  );
}
