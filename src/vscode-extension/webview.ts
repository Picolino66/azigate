import { randomBytes } from 'node:crypto'

export function createNonce(): string {
  return randomBytes(18).toString('base64url')
}

/*
 * Página do painel. Regras de segurança (ADR-028):
 * - CSP sem rede (`default-src 'none'`); script e estilo só com o nonce da renderização;
 * - todo texto vindo do agente ou do agentd entra por `textContent`, nunca como HTML;
 * - o script só fala com o host por `postMessage`, que valida cada mensagem recebida.
 */
const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); display: flex; flex-direction: column; height: 100vh; }
header { padding: 8px 10px 6px; display: grid; gap: 6px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.row { display: flex; gap: 6px; align-items: center; min-width: 0; }
.row > label { flex: 0 0 auto; opacity: .8; font-size: .92em; width: 74px; }
select, textarea, button { font: inherit; color: inherit; }
select { flex: 1 1 auto; min-width: 0; padding: 3px 4px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 2px; }
button { padding: 3px 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); white-space: nowrap; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, select:focus-visible, textarea:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.status { font-size: .9em; display: flex; gap: 6px; align-items: center; min-width: 0; }
.status .text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .9; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--vscode-disabledForeground, #888); }
.dot.ok { background: var(--vscode-testing-iconPassed, #3fb950); }
.dot.warn { background: var(--vscode-editorWarning-foreground, #d29922); }
.dot.err { background: var(--vscode-errorForeground, #f85149); }
main { flex: 1 1 auto; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.empty { opacity: .7; margin: auto 0; text-align: center; line-height: 1.5; padding: 0 8px; }
.msg { white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
.user { align-self: flex-end; max-width: 92%; padding: 6px 9px; border-radius: 6px;
  background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
.who { font-weight: 600; margin-top: 4px; }
.tool, .info, .usage { font-family: var(--vscode-editor-font-family); font-size: .9em; opacity: .85; white-space: pre-wrap; word-break: break-word; }
.tool::before { content: "▸ "; }
.failed { color: var(--vscode-errorForeground); opacity: 1; }
.error { color: var(--vscode-errorForeground); white-space: pre-wrap; word-break: break-word; }
.usage { opacity: .65; }
.approval { border: 1px solid var(--vscode-editorWarning-foreground, #d29922); border-radius: 4px; padding: 8px; display: grid; gap: 6px;
  background: var(--vscode-inputValidation-warningBackground, transparent); }
.approval .label { font-family: var(--vscode-editor-font-family); font-size: .92em; word-break: break-word; }
.approval .actions { display: flex; gap: 6px; }
.approval .result { font-size: .9em; opacity: .85; }
footer { border-top: 1px solid var(--vscode-panel-border, transparent); padding: 8px 10px; display: grid; gap: 6px; }
textarea { width: 100%; min-height: 56px; max-height: 40vh; resize: vertical; padding: 6px; border-radius: 2px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
.composer-actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
.composer-actions .hint { margin-right: auto; font-size: .85em; opacity: .65; }
`

const SCRIPT = `
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const input = $('input');
  let state = null;
  let agentText = null;
  const approvals = new Map();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function stick() { log.scrollTop = log.scrollHeight; }
  function clearEmpty() { const e = $('empty'); if (e) e.remove(); }
  function add(node) { clearEmpty(); log.appendChild(node); stick(); return node; }

  function fillSelect(select, items, value) {
    const current = Array.from(select.options).map((o) => o.value + '|' + o.textContent).join(',');
    const next = items.map((i) => i.value + '|' + i.label).join(',');
    if (current !== next) {
      select.replaceChildren(...items.map((i) => { const o = el('option', '', i.label); o.value = i.value; return o; }));
    }
    if (value !== undefined) select.value = value;
  }

  function setStatus(id, cls, text) {
    const dot = $(id + '-dot');
    dot.className = 'dot ' + cls;
    $(id + '-text').textContent = text;
  }

  function render(s) {
    state = s;
    fillSelect($('provider'), s.providers.map((p) => ({ value: p.id, label: p.label + (p.available === false ? ' (indisponível)' : '') })), s.provider);
    const ws = s.workspaces.length ? s.workspaces.map((w) => ({ value: w, label: w })) : [{ value: '', label: 'nenhum workspace' }];
    fillSelect($('workspace'), ws, s.workspace || '');
    $('provider').disabled = s.busy;
    $('workspace').disabled = s.busy || !s.workspaces.length;

    if (s.connection.ok) setStatus('conn', 'ok', 'agentd conectado');
    else setStatus('conn', 'err', s.connection.message || 'sem conexão');

    const srv = s.server;
    let srvText = 'Workspace Server ';
    let cls = '';
    if (s.workspaceWorker) { cls = 'ok'; srvText += 'conectado (' + s.workspaceWorker + ')'; }
    else if (srv.status === 'starting') { cls = 'warn'; srvText += 'iniciando…'; }
    else if (srv.status === 'running') { cls = 'warn'; srvText += 'iniciado, aguardando o agentd'; }
    else if (srv.status === 'failed') { cls = 'err'; srvText += 'falhou' + (srv.detail ? ': ' + srv.detail : ''); }
    else srvText += 'parado';
    setStatus('srv', cls, srvText);
    const local = srv.status === 'running' || srv.status === 'starting';
    $('srv-toggle').textContent = local ? 'Parar' : 'Iniciar';
    $('srv-toggle').dataset.action = local ? 'stopServer' : 'startServer';
    $('srv-toggle').disabled = srv.status === 'starting';

    $('send').disabled = s.busy || !s.connection.ok;
    $('cancel').hidden = !s.busy;
    $('session-text').textContent = s.session ? 'sessão ' + s.session.id : 'sem sessão';
  }

  function entry(e) {
    agentText = null;
    switch (e.kind) {
      case 'user': add(el('div', 'msg user', e.text)); break;
      case 'agent': add(el('div', 'who', e.provider)); agentText = add(el('div', 'msg', '')); break;
      case 'tool': add(el('div', 'tool', e.label)); break;
      case 'tool-failed': add(el('div', 'tool failed', e.label + ' (' + e.status + ')')); break;
      case 'info': add(el('div', 'info', e.text)); break;
      case 'error': add(el('div', 'error', 'erro: ' + e.text)); break;
      case 'usage': add(el('div', 'usage', e.text)); break;
    }
  }

  function approval(id, label) {
    agentText = null;
    const card = el('div', 'approval');
    card.appendChild(el('div', '', '⚠ O agente pede aprovação para:'));
    card.appendChild(el('div', 'label', label));
    const actions = el('div', 'actions');
    const allow = el('button', 'primary', 'Permitir');
    const deny = el('button', '', 'Negar');
    allow.addEventListener('click', () => decide(id, 'allow'));
    deny.addEventListener('click', () => decide(id, 'deny'));
    actions.append(allow, deny);
    card.appendChild(actions);
    approvals.set(id, card);
    add(card);
    allow.focus();
  }

  function decide(id, decision) {
    const card = approvals.get(id);
    if (card) card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    vscode.postMessage({ type: 'decide', approvalId: id, decision });
  }

  function resolved(id, text) {
    const card = approvals.get(id);
    if (!card) { add(el('div', 'info', text)); return; }
    approvals.delete(id);
    const actions = card.querySelector('.actions');
    if (actions) actions.replaceWith(el('div', 'result', text));
  }

  function send() {
    const text = input.value.trim();
    if (!text || !state || state.busy) return;
    vscode.postMessage({ type: 'send', text });
    input.value = '';
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'state') render(m.state);
    else if (m.type === 'entry') entry(m.entry);
    else if (m.type === 'delta') { if (!agentText) agentText = add(el('div', 'msg', '')); agentText.textContent += m.text; stick(); }
    else if (m.type === 'approval') approval(m.approvalId, m.label);
    else if (m.type === 'approvalResolved') resolved(m.approvalId, m.text);
    else if (m.type === 'reset') {
      approvals.clear(); agentText = null;
      log.replaceChildren(el('div', 'empty', 'Nova sessão. A próxima mensagem inicia o agente escolhido.'));
    }
  });

  $('provider').addEventListener('change', (e) => vscode.postMessage({ type: 'selectProvider', provider: e.target.value }));
  $('workspace').addEventListener('change', (e) => { if (e.target.value) vscode.postMessage({ type: 'selectWorkspace', workspace: e.target.value }); });
  $('new').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('srv-toggle').addEventListener('click', (e) => vscode.postMessage({ type: e.currentTarget.dataset.action || 'startServer' }));
  $('send').addEventListener('click', send);
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  vscode.postMessage({ type: 'ready' });
})();
`

export function renderWebviewHtml(options: { nonce: string; cspSource: string }): string {
  const { nonce, cspSource } = options
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
  ].join('; ')
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Azigate</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header>
  <div class="row"><label for="provider">Agente</label><select id="provider" aria-label="Agente"></select></div>
  <div class="row"><label for="workspace">Workspace</label><select id="workspace" aria-label="Workspace"></select></div>
  <div class="status"><span id="conn-dot" class="dot"></span><span id="conn-text" class="text">conectando…</span>
    <button id="refresh" title="Atualizar estado do agentd">Atualizar</button></div>
  <div class="status"><span id="srv-dot" class="dot"></span><span id="srv-text" class="text">Workspace Server parado</span>
    <button id="srv-toggle" data-action="startServer">Iniciar</button></div>
  <div class="status"><span class="text" id="session-text">sem sessão</span><button id="new" title="Encerra a sessão atual">Nova sessão</button></div>
</header>
<main id="log" aria-live="polite">
  <div id="empty" class="empty">Escolha o agente e o workspace e envie uma mensagem.<br>O agente roda na máquina do agentd e opera este projeto pelo Workspace Server.</div>
</main>
<footer>
  <textarea id="input" placeholder="Peça algo ao agente…" aria-label="Mensagem"></textarea>
  <div class="composer-actions"><span class="hint">Enter envia · Shift+Enter quebra linha</span>
    <button id="cancel" hidden>Cancelar</button><button id="send" class="primary">Enviar</button></div>
</footer>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`
}
