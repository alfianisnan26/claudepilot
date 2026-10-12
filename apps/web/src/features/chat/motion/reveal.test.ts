import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitBlocks } from './blocks';
import { rehypeReveal } from './reveal';
import { scanWords } from './words';

const FULL = 1e9;

/** The block rendered the way the chat does, cut at `cut` (and with words before `staticCut` plain). */
const reveal = (md: string, cut: number, staticCut = 0) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], rehypePlugins: [[rehypeReveal, { cut, staticCut }]] }, md));
const plain = (md: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, md));

const tidy = (html: string) => html.replace(/>\s+</g, '><').trim();
/** The reveal's own spans removed, so a fully revealed document can be compared with a plain render. */
const unwrap = (html: string) =>
  tidy(
    html
      .replace(/<span class="mo-[ws]">([^<]*)<\/span>/g, '$1')
      .replace(/<span class="mo-[ws]">(.*?)<\/span>/g, '$1')
      .replace(/<code class="mo-[ws]">/g, '<code>')
      .replace(/<div class="mo-[ws]">(<pre>.*?<\/pre>)<\/div>/gs, '$1'),
  );
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** The end offset of every word of `md` (what the reveal's cut moves along). */
const wordEnds = (md: string): number[] => {
  const ends: number[] = [];
  scanWords(md, 0, true, ends);
  return ends;
};

const DOCS: Record<string, string> = {
  paragraphs: 'First paragraph with **bold text**, *emphasis*, `inline code` and a [link](https://example.com/a/b?c=d) in it.\n\nSecond paragraph, which has a hard\nline break and ~~strike~~.\n',
  lists:
    '## Steps\n\n1. Install the package\n2. Run `npm test`\n   - nested **one**\n   - nested two\n3. Ship it\n\n- [x] done item\n- [ ] open item\n\n* star one\n* star two\n',
  looseList: '1. First item\n\n   More about the first.\n\n2. Second item\n\n   ```sh\n   run it\n\n   again\n   ```\n\n3. Third\n',
  code: 'Before the code.\n\n```ts\nconst a = 1;\nfunction f(x: number) {\n  return x * 2;\n}\n```\n\nAfter the code, with `x` inline.\n',
  table: 'A table:\n\n| Name | Size | Note |\n| :--- | ---: | --- |\n| alpha | 10 | the **first** one |\n| beta | 200 | `code` cell |\n\nDone.\n',
  quote: '> A quoted line that\n> continues here\n\n> Another quote with *emphasis*.\n\n---\n\nAfter the rule.\n',
  mixed:
    '# Title here\n\nSome intro text — with an em dash, “quotes”, an emoji 🎉🎉, and https://example.com/a/very/long/unbroken/url/that/keeps/going/and/going?with=query&and=more#anchor end.\n\nEscapes: \\*not bold\\*, 1 &lt; 2 &amp; 3, and a_b_c.\n\n- a\n- b\n\n```\nplain fence\n```\n',
};

describe('rehypeReveal: cutting rendered Markdown', () => {
  it('shows nothing at the start and the whole block at the end (same structure as a plain render)', () => {
    for (const [name, md] of Object.entries(DOCS)) {
      assert.equal(reveal(md, 0), '', name);
      assert.equal(unwrap(reveal(md, FULL)), tidy(plain(md)), name);
    }
  });

  it('only ever grows: each step shows the words of the one before and then some', () => {
    for (const [name, md] of Object.entries(DOCS)) {
      const full = text(unwrap(reveal(md, FULL)));
      let prev = '';
      for (const cut of wordEnds(md)) {
        const now = text(reveal(md, cut));
        assert.ok(full.startsWith(now), `${name} @${cut}: ${JSON.stringify(now)} is not the start of the document`);
        assert.ok(now.length >= prev.length, `${name} @${cut}: shrank`);
        prev = now;
      }
      assert.equal(prev, full, name);
    }
  });

  it('never cuts inside a word, and shows no Markdown markers once the closing marker has arrived', () => {
    const md = DOCS.paragraphs!;
    const ends = wordEnds(md);
    for (const cut of ends) {
      const shown = text(reveal(md, cut));
      for (const w of shown.split(' ')) assert.ok(!/^\*\*?[^*]|[^*]\*\*?$/.test(w), `a marker showed: ${w} @${cut}`);
    }
    // "**bold text**": the cut sits after "text**", and by then the words are inside <strong>.
    const at = md.indexOf('text**') + 'text**'.length;
    assert.match(reveal(md, at), /<strong><span class="mo-w">bold<\/span> <span class="mo-w">text<\/span><\/strong>/);
  });

  it('resolves emphasis by what has arrived, not by what has been shown', () => {
    // The closing "**" is beyond the cut: the words are already bold (they were parsed with it).
    const md = 'Use **very careful words** please.\n';
    const cut = md.indexOf('very') + 'very'.length;
    assert.match(reveal(md, cut), /<strong><span class="mo-w">very<\/span><\/strong>/);
  });

  it('wraps each word in its own span and leaves the spaces between them as text', () => {
    assert.equal(reveal('one two three\n', 'one two'.length), '<p><span class="mo-w">one</span> <span class="mo-w">two</span></p>');
  });

  it('marks words that finished their animation as still, and the rest as playing', () => {
    const md = 'alpha beta gamma delta\n';
    const html = reveal(md, md.indexOf('delta') + 5, md.indexOf('beta') + 4);
    assert.equal(html, '<p><span class="mo-s">alpha</span> <span class="mo-s">beta</span> <span class="mo-w">gamma</span> <span class="mo-w">delta</span></p>');
  });

  it('keeps a list a list, and shows an item only once its first word is revealed', () => {
    const md = '- one two\n- three four\n';
    assert.equal(tidy(reveal(md, 5)), '<ul><li><span class="mo-w">one</span></li></ul>');
    const more = reveal(md, md.indexOf('three') + 5);
    assert.match(more, /<ul>\n?<li><span class="mo-w">one<\/span> <span class="mo-w">two<\/span><\/li>\n?<li><span class="mo-w">three<\/span><\/li>\n?<\/ul>/);
  });

  it('shows a fenced code block line by line, whole lines only', () => {
    const md = DOCS.code!;
    const line1 = md.indexOf('const a = 1;') + 'const a = 1;'.length;
    // In the middle of the first line: the code block has not appeared.
    assert.ok(!reveal(md, md.indexOf('const a') + 3).includes('<pre>'));
    // After the first line's last word, but the line has no newline passed yet: still not shown.
    assert.ok(!reveal(md, line1).includes('<pre>'));
    // The cut moves on to the second line's first word: line 1 is complete.
    const second = reveal(md, md.indexOf('function') + 'function'.length);
    assert.match(second, /<div class="mo-w"><pre><code class="language-ts">const a = 1;\n<\/code><\/pre><\/div>/);
    // No spans inside code.
    assert.ok(!/<pre>.*?mo-[ws].*?<\/pre>/s.test(reveal(md, FULL)));
    // Whole at the end.
    assert.match(reveal(md, FULL), /return x \* 2;\n\}\n/);
  });

  it('shows a table a row at a time: the cells of a row appear together', () => {
    const md = DOCS.table!;
    const header = md.indexOf('Note |') + 'Note'.length; // inside the header row's last cell
    assert.ok(!reveal(md, header).includes('<table'), 'a half header row does not show');
    const afterHeader = md.indexOf('| alpha');
    const withHeader = reveal(md, afterHeader + 2);
    assert.match(withHeader, /<thead>/);
    assert.ok(!withHeader.includes('<tbody'), 'no body row yet');
    assert.ok(!reveal(md, md.indexOf('one |') + 3).includes('alpha'), 'half a row does not show');
    const row1 = reveal(md, md.indexOf('one |') + 'one |'.length);
    assert.match(row1, /<td[^>]*><span class="mo-w">/);
    assert.ok(row1.includes('alpha') && row1.includes('first'));
    assert.ok(!row1.includes('beta'));
  });

  it('shows inline code as one piece', () => {
    const md = 'Run `git commit -m x` now\n';
    assert.ok(!reveal(md, md.indexOf('commit') + 6).includes('<code'), 'half a command does not show');
    assert.match(reveal(md, md.indexOf('x` now') + 4), /<code class="mo-w">git commit -m x<\/code>/);
  });

  it('keeps links as links, with their words inside', () => {
    const md = 'See [the long docs page](https://example.com/docs) for more.\n';
    const html = reveal(md, md.indexOf('long') + 4);
    assert.match(html, /<a href="https:\/\/example.com\/docs"><span class="mo-w">the<\/span> <span class="mo-w">long<\/span><\/a>/);
  });

  it('keeps a very long unbroken URL as one word', () => {
    const md = DOCS.mixed!;
    const url = 'https://example.com/a/very/long/unbroken/url/that/keeps/going/and/going?with=query&and=more#anchor';
    const before = reveal(md, md.indexOf(url) - 2);
    assert.ok(!before.includes('example.com/a/very'));
    const after = reveal(md, md.indexOf(url) + url.length);
    assert.ok(after.includes('mo-w">https://example.com/a/very/long/unbroken/url/that/keeps/going/and/going?with=query&amp;and=more#anchor</span>'));
  });

  it('handles escapes and entities, whose text is shorter than their source', () => {
    const md = 'Escapes: \\*not bold\\*, 1 &lt; 2 &amp; 3, ok.\n';
    // Reveal up to "2" (after "&lt;"): the visible text must not run ahead of the cut or lag far behind.
    const cut = md.indexOf('2 &amp;') + 1;
    const shown = text(reveal(md, cut));
    assert.equal(shown, 'Escapes: *not bold*, 1 < 2');
    const all = text(reveal(md, FULL));
    assert.equal(all, 'Escapes: *not bold*, 1 < 2 & 3, ok.');
  });

  it('shows text written without spaces a few characters at a time', () => {
    const md = '今天天气很好，我们一起去公园散步吧。\n';
    const ends = wordEnds(md);
    assert.ok(ends.length >= 4);
    let prev = 0;
    for (const cut of ends) {
      const shown = text(reveal(md, cut)).replace(/ /g, '');
      assert.ok(md.replace(/\n/g, '').startsWith(shown), `${shown} at ${cut}`);
      assert.ok(shown.length >= prev);
      prev = shown.length;
    }
    assert.equal(text(reveal(md, FULL)).replace(/ /g, ''), md.trim());
  });

  it('shows emoji whole', () => {
    const md = 'Party 🎉🎉🎉 time\n';
    assert.match(reveal(md, md.indexOf('time') - 1), /🎉🎉🎉/);
  });
});

/** The point of splitting a reply into blocks: rendered one by one, they come out as the whole reply does. */
describe('blocks render like the whole reply', () => {
  const asBlocks = (md: string) => splitBlocks(md).map((b) => plain(md.slice(b.start, b.end))).join('');

  it('for every sample reply', () => {
    for (const [name, md] of Object.entries(DOCS)) {
      assert.equal(tidy(asBlocks(md)), tidy(plain(md)), name);
    }
  });

  it('at every point of the stream (text cut at a word, as it arrives)', () => {
    let different = 0;
    let total = 0;
    for (const [name, md] of Object.entries(DOCS)) {
      for (const end of wordEnds(md)) {
        const prefix = md.slice(0, end);
        total++;
        if (tidy(asBlocks(prefix)) !== tidy(plain(prefix))) {
          different++;
          assert.fail(`${name}: the prefix ending ${JSON.stringify(prefix.slice(-30))} renders differently split`);
        }
      }
    }
    assert.ok(total > 100 && different === 0);
  });
});
