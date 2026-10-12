import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayName, dispositionHeader, extensionOf, NAME_MAX, STAGED_NAME, stagedName, uniqueEntryName } from './names.js';

const SHA = 'f3a9c1d2e4b5a6978899aabbccddeeff00112233445566778899aabbccddeeff';

test('displayName: only the last part of a path, no controls, no direction overrides, bounded', () => {
  assert.equal(displayName('report.pdf'), 'report.pdf');
  assert.equal(displayName('../../etc/passwd'), 'passwd');
  assert.equal(displayName('C:\\Users\\me\\Desktop\\notes.txt'), 'C:_Users_me_Desktop_notes.txt', 'a backslash is never kept: an unzip on Windows reads it as a separator');
  assert.equal(displayName('/home/node/.ssh/id_rsa'), 'id_rsa');
  assert.equal(displayName('a\u{0}b\u{7}c\nd.txt'), 'abcd.txt', 'control characters are dropped');
  assert.equal(displayName('invoice\u{202e}fdp.exe'), 'invoicefdp.exe', 'a right-to-left override would make it read as another extension');
  assert.equal(displayName('\u{2066}x\u{2069}.png'), 'x.png');
  assert.equal(displayName('zero\u{200b}width\u{feff}.md'), 'zerowidth.md');
  assert.equal(displayName('  spaced   out  .txt  '), 'spaced out .txt');
  assert.equal(displayName('..'), 'file');
  assert.equal(displayName('...hidden'), 'hidden');
  assert.equal(displayName('trailing.'), 'trailing');
  assert.equal(displayName(''), 'file');
  assert.equal(displayName(undefined, 'upload'), 'upload');
  assert.equal(displayName(42 as unknown), 'file');
  assert.equal(displayName('Laporan Bulan Oktober (final) – résumé.pdf'), 'Laporan Bulan Oktober (final) – résumé.pdf', 'ordinary Unicode stays');
  const long = `${'x'.repeat(300)}.pdf`;
  const cut = displayName(long);
  assert.ok([...cut].length <= NAME_MAX, 'bounded');
  assert.ok(cut.endsWith('.pdf'), 'the extension survives a cut');
  assert.equal([...displayName('é'.repeat(300))].length, NAME_MAX, 'counted in characters, not bytes');
});

test('extensionOf: lower-case, plain, or nothing', () => {
  assert.equal(extensionOf('Report.PDF'), 'pdf');
  assert.equal(extensionOf('archive.tar.gz'), 'gz');
  assert.equal(extensionOf('noext'), '');
  assert.equal(extensionOf('weird.ex t'), '');
  assert.equal(extensionOf('a.' + 'x'.repeat(20)), '');
  assert.equal(extensionOf('.bashrc'), '');
});

test('stagedName: ASCII only, no path, the content hash keeps two files apart and one file the same', () => {
  const name = stagedName('Laporan Bulan Oktober (final) – résumé.pdf', SHA);
  assert.match(name, STAGED_NAME);
  assert.equal(name, 'Laporan-Bulan-Oktober-final-resume-f3a9c1d2.pdf');
  assert.equal(stagedName('Laporan Bulan Oktober (final) – résumé.pdf', SHA), name, 'the same file always lands on the same path');
  assert.notEqual(stagedName('report.pdf', SHA), stagedName('report.pdf', `00${SHA.slice(2)}`), 'different content, different path');
  for (const hostile of ['../../etc/passwd', '/abs/path.txt', 'a b;rm -rf *.txt', '$(whoami).sh', '`id`.txt', 'new\nline.txt', '日本語.txt', '..', '.hidden', '   ', 'x'.repeat(400) + '.csv']) {
    const staged = stagedName(displayName(hostile), SHA);
    assert.match(staged, STAGED_NAME, hostile);
    assert.ok(!staged.includes('/') && !staged.includes('..'), hostile);
  }
  assert.equal(stagedName('noext', SHA), 'noext-f3a9c1d2');
  assert.equal(stagedName('日本語.txt', SHA), 'file-f3a9c1d2.txt');
});

test('dispositionHeader: a quoted ASCII name, the real one in filename* when it differs; never a path or a quote', () => {
  assert.equal(dispositionHeader('attachment', 'report.pdf'), 'attachment; filename="report.pdf"');
  assert.equal(dispositionHeader('inline', 'photo.png'), 'inline; filename="photo.png"');
  assert.equal(dispositionHeader('attachment', 'résumé.pdf'), "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  assert.equal(dispositionHeader('attachment', 'say "hi" 100%.txt'), `attachment; filename="say _hi_ 100_.txt"; filename*=UTF-8''say%20%22hi%22%20100%25.txt`);
  assert.equal(dispositionHeader('attachment', 'a\\b.txt'), 'attachment; filename="a_b.txt"', 'a backslash is not kept');
  assert.equal(dispositionHeader('attachment', '../../x\r\nSet-Cookie: a=b.txt'), 'attachment; filename="xSet-Cookie: a=b.txt"', 'no header injection');
  assert.ok(!/[\r\n]/.test(dispositionHeader('attachment', 'a\r\nb')));
  assert.equal(dispositionHeader('attachment', ''), 'attachment; filename="download"');
});

test('uniqueEntryName: a zip never holds two entries of one name, whatever the case', () => {
  const taken = new Set<string>();
  assert.equal(uniqueEntryName('a.txt', taken), 'a.txt');
  assert.equal(uniqueEntryName('a.txt', taken), 'a (2).txt');
  assert.equal(uniqueEntryName('A.TXT', taken), 'A (3).TXT');
  assert.equal(uniqueEntryName('noext', taken), 'noext');
  assert.equal(uniqueEntryName('noext', taken), 'noext (2)');
  assert.equal(uniqueEntryName('../evil', taken), 'evil', 'an entry name is never a path');
  assert.equal(uniqueEntryName('a:b?c*d<e>f|g"h.txt', taken), 'a_b_c_d_e_f_g_h.txt', 'characters Windows refuses in a name (or reads as a stream) are not kept');
});
