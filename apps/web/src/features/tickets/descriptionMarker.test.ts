// PILOT-1111: the reporter's deployment footer starts with an HTML comment marker (apps/server/src/reporter/describe.ts); the ticket page
// printed it as text ("<!-- reporter:deployments -->"). With hideComments the comment is dropped and the footer below it still shows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../chat/Markdown';

const footer = '<!-- reporter:deployments -->\n### Deployment\n\n- Fix commits: none known yet\n- stg: unknown\n';
const body = `The hero is cut.\n\n${footer}`;

test('ticket description: the deployment footer marker is invisible, the footer is not', () => {
  const html = renderToStaticMarkup(createElement(Markdown, { text: body, hideComments: true }));
  assert.doesNotMatch(html, /reporter:deployments/);
  assert.doesNotMatch(html, /&lt;!--/);
  assert.match(html, /Deployment/);
  assert.match(html, /The hero is cut/);
});

test('without hideComments raw HTML still shows as text (chat), and other HTML is never rendered', () => {
  assert.match(renderToStaticMarkup(createElement(Markdown, { text: body })), /reporter:deployments/);
  const html = renderToStaticMarkup(createElement(Markdown, { text: '<b onclick="x()">bold</b>\n\n<!-- a --> <i>x</i>', hideComments: true }));
  assert.doesNotMatch(html, /<b onclick/);
  assert.doesNotMatch(html, /<i>x<\/i>/);
});
