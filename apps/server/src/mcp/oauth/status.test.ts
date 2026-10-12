import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asClaude, checkScript, serverName, validServer } from './status.js';

test('asClaude: only a Claude folder the portal made is ever put into a script', () => {
  assert.equal(asClaude(''), ':');
  assert.equal(asClaude('claudes/0123456789abcdef'), 'export CLAUDE_CONFIG_DIR="$HOME/.claudepilot/claudes/0123456789abcdef"');
  for (const bad of ['claudes/../../etc', 'claudes/0123456789ABCDEF', '"; rm -rf ~; "', 'claudes/0123456789abcde', '/etc', '$(id)']) assert.throws(() => asClaude(bad), /Not a Claude folder/, bad);
  assert.throws(() => checkScript([{ plugin: 'cpm-a', key: 'b', name: 'x' }], '"; id; "'), /Not a Claude folder/);
});

test('server names: only the portal’s plugin and key shapes are valid, and they quote safely', () => {
  assert.equal(serverName({ plugin: 'cpm-lab', key: 'gitea' }), 'plugin:cpm-lab:gitea');
  assert.ok(validServer({ plugin: 'cpm-lab', key: 'gitea' }));
  for (const bad of [
    { plugin: 'lab', key: 'gitea' },
    { plugin: 'cpm-lab', key: 'Gitea' },
    { plugin: "cpm-lab'; id; '", key: 'a' },
    { plugin: 'cpm-lab', key: 'a'.repeat(17) },
    { plugin: 'cpm-' + 'a'.repeat(13), key: 'a' },
  ])
    assert.equal(validServer(bad), false, JSON.stringify(bad));
  const script = checkScript([{ plugin: 'cpm-lab', key: 'gitea', name: 'Gitea' }], '');
  assert.match(script, /claude mcp get 'plugin:cpm-lab:gitea'/);
  assert.match(script, /<<<cp-auth>>>plugin:cpm-lab:gitea/);
});
