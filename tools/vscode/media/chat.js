// The Chat view's page script (loaded by nonce; the CSP allows nothing else). Every string from the portal is set with textContent:
// an agent's or a workspace's text can never become markup, a link or a script here.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const title = document.getElementById('title');
  const state = document.getElementById('state');
  const form = document.getElementById('form');
  const text = document.getElementById('text');
  const send = document.getElementById('send');
  const MAX_ROWS = 500;
  const LABEL = { user: 'You', assistant: 'Claude', tool_use: 'Tool', request: 'Asks', resolved: 'Answered', error: 'Error', result: 'Done' };

  function enable(on) {
    text.disabled = !on;
    send.disabled = !on;
  }

  function row(e) {
    const div = document.createElement('div');
    div.className = `row ${e.kind}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = LABEL[e.kind] || e.kind;
    div.appendChild(who);
    const body = document.createElement('span');
    body.className = 'body';
    if (e.kind === 'tool_use') body.textContent = e.toolName || 'a tool';
    else if (e.kind === 'request') body.textContent = `${e.text || 'a request'}${e.toolName ? ` (${e.toolName})` : ''}`;
    else if (e.kind === 'result') body.textContent = 'Turn finished';
    else body.textContent = e.text || '';
    div.appendChild(body);
    return div;
  }

  function note(t, cls) {
    const div = document.createElement('div');
    div.className = `note ${cls || ''}`;
    div.textContent = t;
    log.appendChild(div);
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'reset') {
      log.replaceChildren();
      title.textContent = typeof m.title === 'string' ? m.title : 'Agent';
      state.textContent = '';
      enable(true);
      return;
    }
    if (m.type === 'events') {
      if (typeof m.title === 'string') title.textContent = m.title;
      if (typeof m.state === 'string') state.textContent = m.state;
      enable(m.state !== 'ended');
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      for (const e of Array.isArray(m.events) ? m.events : []) log.appendChild(row(e));
      while (log.childElementCount > MAX_ROWS) log.firstElementChild.remove();
      if (atBottom) log.scrollTop = log.scrollHeight;
      return;
    }
    if (m.type === 'sent') {
      text.value = '';
      send.disabled = false;
      return;
    }
    if (m.type === 'error') {
      note(typeof m.text === 'string' ? m.text : 'Something failed.', 'error');
      send.disabled = false;
    }
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = text.value;
    if (!value.trim()) return;
    send.disabled = true;
    vscode.postMessage({ type: 'send', text: value });
  });

  text.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });
})();
