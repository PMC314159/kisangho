const $ = selector => document.querySelector(selector);
const ui = { form: $('#chat-form'), input: $('#message'), send: $('#send'), messages: $('#messages'), conversation: $('#conversation'), typing: $('#typing'), notice: $('#notice'), older: $('#load-older') };
const history = new Map();
let mode = 'chat', busy = false, syncing = false, initial = true;
let retry = null;
let historyEpoch = 0, resetToken = null, resetting = false;
try {
  const saved = JSON.parse(localStorage.getItem('sangho-draft') || 'null');
  if (saved && typeof saved.message === 'string') {
    ui.input.value = saved.message.slice(0, 4000);
    mode = saved.mode === 'scene' ? 'scene' : 'chat';
    retry = saved;
  }
} catch { /* Browser storage is optional; server memory does not depend on it. */ }

function notice(text = '') {
  ui.notice.textContent = text;
  ui.notice.hidden = !text;
}
function saveDraft() {
  try {
    localStorage.setItem('sangho-draft', JSON.stringify({ message: ui.input.value, mode, requestId: retry?.requestId }));
  } catch { /* Private browsing may disable local storage. */ }
}
function resize() {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(ui.input.scrollHeight, 150)}px`;
  $('#char-count').textContent = `${ui.input.value.length} / 4000`;
}
function setMode(next) {
  mode = next;
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
  $('#mode-hint').textContent = mode === 'chat' ? '짧게 주고받는 일상' : '표정과 마음까지 담는 장면';
  saveDraft();
}
function setBusy(value) {
  busy = value;
  ui.input.disabled = value;
  ui.send.disabled = value;
  $('#reset').disabled = value;
  ui.typing.hidden = !value;
  ui.form.setAttribute('aria-busy', String(value));
  document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = value; });
}
async function api(action, options = {}) {
  const response = await fetch(`/api/${action}`, { ...options, cache: 'no-store', signal: AbortSignal.timeout(115000) });
  let data;
  try { data = await response.json(); } catch { throw new Error('서버 응답을 읽지 못했어요. 잠시 뒤 다시 시도해 주세요.'); }
  if (!response.ok) throw new Error(data.error || '요청을 완료하지 못했어요.');
  return data;
}
const sorted = () => [...history.values()].sort((a, b) => a.id - b.id);
const dayFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
function render() {
  const fragment = document.createDocumentFragment();
  let day;
  for (const message of sorted()) {
    const nextDay = dayFormat.format(message.created_at);
    if (nextDay !== day) {
      const label = document.createElement('div'); label.className = 'day-label'; label.textContent = nextDay; fragment.append(label); day = nextDay;
    }
    const article = document.createElement('article'); article.className = `message ${message.role === 'user' ? 'user' : 'assistant'} ${message.mode === 'scene' ? 'scene' : ''}`;
    const author = document.createElement('div'); author.className = 'message-author'; author.textContent = message.role === 'user' ? '예지' : '기상호';
    const row = document.createElement('div'); row.className = 'bubble-row';
    const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = message.content;
    const time = document.createElement('time'); time.dateTime = new Date(message.created_at).toISOString(); time.textContent = timeFormat.format(message.created_at);
    row.append(bubble, time); article.append(author, row); fragment.append(article);
  }
  ui.messages.replaceChildren(fragment);
}
function bottom() { ui.conversation.scrollTop = ui.conversation.scrollHeight; }
async function refresh() {
  if (syncing || busy) return;
  syncing = true;
  $('#refresh').disabled = true;
  const atBottom = ui.conversation.scrollHeight - ui.conversation.scrollTop - ui.conversation.clientHeight < 100;
  const epoch = historyEpoch;
  try {
    const data = await api('history');
    if (epoch !== historyEpoch) return;
    if (resetToken !== null && resetToken !== data.resetToken) {
      history.clear();
      initial = true;
      historyEpoch++;
    }
    resetToken = data.resetToken;
    for (const message of data.messages) history.set(message.id, message);
    if (initial) ui.older.hidden = !data.hasMore;
    render();
    if (initial || atBottom) bottom();
    initial = false;
  } catch (error) {
    $('#announcement').textContent = '대화 기록을 불러오지 못했어요. 새로고침으로 다시 시도할 수 있어요.';
  } finally { syncing = false; $('#refresh').disabled = false; }
}

ui.older.addEventListener('click', async () => {
  const earliest = sorted()[0]?.id;
  if (!earliest) return;
  ui.older.disabled = true;
  const previousHeight = ui.conversation.scrollHeight;
  const previousTop = ui.conversation.scrollTop;
  const epoch = historyEpoch;
  try {
    const data = await api(`history?before=${earliest}`);
    if (epoch !== historyEpoch) return;
    if (resetToken !== data.resetToken) { await refresh(); return; }
    for (const message of data.messages) history.set(message.id, message);
    render();
    ui.older.hidden = !data.hasMore;
    ui.conversation.scrollTop = previousTop + ui.conversation.scrollHeight - previousHeight;
  } catch (error) { notice(error.message); }
  finally { ui.older.disabled = false; }
});

ui.form.addEventListener('submit', async event => {
  event.preventDefault();
  const message = ui.input.value.trim();
  if (busy || !message) return;
  if (retry?.message !== message || retry?.mode !== mode || !retry?.requestId) retry = { requestId: crypto.randomUUID(), message, mode };
  ui.input.value = message;
  saveDraft();
  setBusy(true); notice(); bottom();
  try {
    const result = await api('chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(retry) });
    for (const item of result.messages) history.set(item.id, item);
    render();
    ui.input.value = ''; retry = null; saveDraft(); resize();
    $('#announcement').textContent = '상호의 답장이 도착했고 대화가 저장됐어요.';
    notice(result.warning || '');
  } catch (error) {
    notice(error.name === 'TimeoutError' ? '답장을 기다리다 연결이 끊겼어요. 새로고침으로 저장 여부를 확인하거나 같은 메시지를 다시 보내 주세요.' : error.message);
  } finally { setBusy(false); bottom(); ui.input.focus(); }
});

ui.input.addEventListener('input', () => { resize(); saveDraft(); });
ui.input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && window.matchMedia('(min-width: 641px)').matches) {
    event.preventDefault(); ui.form.requestSubmit();
  }
});
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#refresh').addEventListener('click', refresh);
$('#reset').addEventListener('click', () => {
  if (busy) return;
  $('#reset-error').hidden = true;
  $('#reset-dialog').showModal();
});
$('#reset-cancel').addEventListener('click', () => $('#reset-dialog').close());
$('#reset-dialog').addEventListener('cancel', event => { if (resetting) event.preventDefault(); });
$('#reset-confirm').addEventListener('click', async () => {
  if (busy || resetting) return;
  resetting = true;
  historyEpoch++;
  setBusy(true);
  ui.typing.hidden = true;
  $('#reset-confirm').disabled = true;
  $('#reset-cancel').disabled = true;
  $('#reset-error').hidden = true;
  try {
    const result = await api('reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'RESET_ALL' }) });
    resetToken = result.resetToken;
    history.clear();
    retry = null;
    ui.input.value = '';
    saveDraft(); resize(); render();
    ui.older.hidden = true;
    initial = false;
    $('#reset-dialog').close();
    notice('대화와 기억을 초기화했어요. 첫 만남부터 다시 시작해요.');
    $('#announcement').textContent = '대화와 기억을 모두 초기화했어요.';
  } catch (error) {
    $('#reset-error').textContent = error.message;
    $('#reset-error').hidden = false;
  } finally {
    resetting = false;
    setBusy(false);
    $('#reset-confirm').disabled = false;
    $('#reset-cancel').disabled = false;
    if (!$('#reset-dialog').open) ui.input.focus();
  }
});
$('#export').addEventListener('click', async () => {
  $('#export').disabled = true;
  try {
    const response = await fetch('/api/export', { cache: 'no-store' });
    if (!response.ok) {
      const error = await response.json(); throw new Error(error.error || '기록을 내려받지 못했어요.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `sangho-yeji-${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    notice('대화 기록과 현재 장기기억을 파일로 보관했어요.');
  } catch (error) { notice(error.message); }
  finally { $('#export').disabled = false; }
});
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 30000);
setMode(mode); resize(); refresh();
