// The panel's title row (owner, 2026-10-31, memor.id screenshot): the project's name is the title, the environment chip and Context follow it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TitleRow } from './Panel';

test('title row: the bucket name renders as the heading, then the environment chip and Context; the right end stays clear', () => {
  const html = renderToStaticMarkup(createElement(TitleRow, { name: 'memor.id', env: 'stg', where: 'memor/web · https://stg.memor.id', onContext: () => undefined }));
  assert.match(html, /<h1[^>]*data-testid="bucket-name"[^>]*>memor\.id<\/h1>/);
  assert.match(html, /truncate/, 'a long name truncates');
  assert.ok(html.indexOf('memor.id</h1>') < html.indexOf('>stg<') && html.indexOf('>stg<') < html.indexOf('aria-label="Context"'), 'name, then env, then (i)');
  assert.match(html, /pr-14/, 'the SDK close keeps its corner');
  const signedOut = renderToStaticMarkup(createElement(TitleRow, { name: 'Konfersi', env: null, where: '', onContext: null }));
  assert.match(signedOut, />Konfersi<\/h1>/);
  assert.doesNotMatch(signedOut, /Context/, 'no Context before connecting');
});
