// Test fixtures for knowledge (not used by the portal): an Obsidian-style vault with the tricky cases of
// Knowledge PRD §9, as files and as a zip, and a generator for large vaults.

import { deflateSync } from 'node:zlib';
import { makeZip, type ZipItem } from '../skills/testkit.js';

export interface FixtureFile {
  path: string;
  content: string | Buffer;
}

/** A real, small PNG (a 48x32 gradient), so an embedded image shows something. */
export function makePng(width = 48, height = 32): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = 30 + Math.round((x / width) * 120);
      raw[i + 1] = 140 + Math.round((y / height) * 90);
      raw[i + 2] = 110;
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = makePng();

/** The files of a small vault written the way Obsidian users write them. */
export function obsidianFixture(): FixtureFile[] {
  return [
    {
      path: 'Welcome.md',
      content: [
        '---',
        'tags: [welcome, nested/tag]',
        'aliases: [Start here, Home]',
        '---',
        '# Welcome',
        '',
        'See [[Projects/Alpha plan|the plan]] and [[Daily/2026-10-11]] and [[Beta]].',
        '',
        '![[Meeting notes#Decisions]]',
        '',
        '![[diagram.png|300]]',
        '',
        '## Section Two',
        '',
        'Back to [[Alpha]] (an alias, so unresolved, as in Obsidian) #welcome',
      ].join('\n'),
    },
    {
      path: 'Projects/Alpha plan.md',
      content: ['---', 'aliases:', '  - Alpha', '  - Project A', 'tags: project', '---', '# Alpha plan', '', 'Depends on [[Beta]]. See [[Welcome#Section Two]] and [[Meeting notes#^decision-1]].', '', 'A fact worth linking to. ^fact-1'].join('\n'),
    },
    { path: 'Projects/Beta.md', content: '# Beta\n\nBack to [[Alpha plan]]. [md link](Alpha%20plan.md) and [relative](../Welcome.md#Section%20Two).\n' },
    { path: 'Meeting notes.md', content: '# Meeting notes\n\n## Decisions\n\n- we decided to ship ^decision-1\n- and to wait\n\n## Other\n\ntext\n' },
    { path: 'Notes/Meeting notes.md', content: '# A second note with the same name\n\nBack to [[Welcome]].\n' },
    { path: 'Notes/Other.md', content: 'From the Notes folder: [[Meeting notes]] (two notes have this name; the one in this folder wins).\n' },
    { path: 'Daily/2026-10-11.md', content: '- 09:00 started\n- 10:30 met about [[Projects/Alpha plan]]\n' },
    { path: 'Daily/2026-10-12.md', content: '- 08:15 planning #daily\n' },
    { path: 'Daily/2026-10-10.md', content: '- 22:00 wrote the PRD\n' },
    { path: 'Spaces and ünïcode/Café notes.md', content: 'About [[Welcome|home]] and a ☕ emoji. #café\n' },
    { path: 'Tricky/Frontmatter empty.md', content: '---\n---\nbody' },
    { path: 'Tricky/Frontmatter invalid.md', content: '---\nfoo: [unclosed\n---\nStill has a [[Beta]] link.' },
    { path: 'Tricky/CRLF.md', content: '# CRLF note\r\n\r\nline one\r\nline two with [[Beta]]\r\n' },
    { path: 'Tricky/BOM.md', content: '﻿---\ntags: [bom]\n---\n# With a byte-order mark\n' },
    { path: 'Tricky/Code blocks.md', content: 'Real [[Beta]].\n\n```md\n[[Not a link]] #not-a-tag\n```\n\nInline `[[also not]]` and %% [[hidden]] %%.\n' },
    { path: 'Tricky/Callouts.md', content: '> [!note] A note\n> body\n\n> [!tip]- Folded tip\n> hidden by default\n\n> [!warning]\n> careful\n' },
    { path: 'Tricky/Unresolved.md', content: 'A [[Does not exist]] link, another [[Does not exist]], and ![[missing.png]].\n' },
    { path: 'Tricky/Table.md', content: '| a | b |\n| - | - |\n| [[Alpha plan\\|plan]] | [[Beta]] |\n' },
    { path: 'Tricky/Entities.md', content: 'Fixes [[ticket:T-1]] from [[session:abc123|that run]] in [[workspace:docker/dev]].\n' },
    { path: 'Tricky/Weird name (1) & more.md', content: 'name with parens and an ampersand\n' },
    { path: 'img/diagram.png', content: PNG },
    { path: 'docs/spec.pdf', content: Buffer.from('%PDF-1.4\n%fake\n') },
    { path: '.obsidian/app.json', content: '{"legacyEditor":false}' },
    { path: '.obsidian/daily-notes.json', content: '{"folder":"Daily","format":"YYYY-MM-DD"}' },
    { path: '.obsidian/plugins/evil/main.js', content: 'alert(1)' },
    { path: '.trash/Old note.md', content: 'deleted in Obsidian' },
  ];
}

/** The fixture as a zip, optionally with a wrapper folder, plus things an import must skip or refuse. */
export function fixtureZip(opts: { wrapper?: string; extra?: ZipItem[]; files?: FixtureFile[] } = {}): Buffer {
  const prefix = opts.wrapper ? `${opts.wrapper}/` : '';
  const items: ZipItem[] = (opts.files ?? obsidianFixture()).map((f) => ({ name: prefix + f.path, data: f.content }));
  return makeZip([...items, ...(opts.extra ?? [])]);
}

/** A generated vault: `n` notes in nested folders that link to each other (with hubs), with tags, headings and some attachments. Deterministic. */
export function* generatedVault(n: number): Generator<FixtureFile> {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu', 'service', 'cluster', 'deploy', 'incident', 'review', 'design', 'metric', 'budget', 'roadmap', 'customer', 'release', 'queue', 'cache', 'latency'];
  const pick = () => words[Math.floor(rnd() * words.length)]!;
  const folders = ['Projects', 'Areas', 'Resources', 'Archive', 'People', 'Journal', 'Ideas', 'Reading'];
  const names = Array.from({ length: n }, (_, i) => `${pick()} ${pick()} ${i}`);
  for (let i = 0; i < n; i++) {
    const folder = `${folders[i % folders.length]}/${pick()}${i % 7}`;
    // Links go to real notes, skewed toward the first ones so a few notes become hubs.
    const links = Array.from({ length: 2 + Math.floor(rnd() * 6) }, () => `[[${names[Math.floor(n * rnd() ** 3)]}]]`);
    const body = Array.from({ length: 30 + Math.floor(rnd() * 120) }, () => pick()).join(' ');
    yield {
      path: `${folder}/${names[i]}.md`,
      content: `---\ntags: [${pick()}, ${pick()}/${pick()}]\n---\n# ${names[i]}\n\n${body}\n\n## Links\n\n${links.join('\n')}\n\n#${pick()} #${pick()}\n`,
    };
    if (i % 50 === 0) yield { path: `Attachments/img-${i}.png`, content: PNG };
  }
}
