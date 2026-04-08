// ─────────────────────────────────────────────
//  休みカレンダー — app.js
//  GitHub Issues をデータストアとして利用
// ─────────────────────────────────────────────

const VACATION_LABEL = 'vacation';
const MEMBER_LABEL_PREFIX = 'member-';

// メンバーカラーパレット（HSL）
const PALETTE = [
  '#e53e3e', '#dd6b20', '#d69e2e', '#38a169',
  '#3182ce', '#805ad5', '#d53f8c', '#00b5d8',
  '#2d9748', '#c05621', '#6b46c1', '#2b6cb0',
];

// ─── 状態 ───────────────────────────────────
let state = {
  repo: '',
  token: '',
  year: new Date().getFullYear(),
  month: new Date().getMonth(), // 0-indexed
  vacations: [],       // { id, number, member, start, end, memo, color }
  members: {},         // { name: color }
  loading: false,
  deleteTarget: null,
};

// ─── GitHub API ──────────────────────────────

async function ghFetch(path, options = {}) {
  const url = `https://api.github.com/repos/${state.repo}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${state.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

// Issue のタイトルをパース: "[VACATION] member | 2024-01-01~2024-01-05 | memo"
function issueToVacation(issue) {
  if (!issue.title.startsWith('[VACATION]')) return null;
  try {
    const body = issue.title.replace('[VACATION]', '').trim();
    const parts = body.split(' | ');
    if (parts.length < 2) return null;
    const member = parts[0].trim();
    const [start, end] = parts[1].trim().split('~');
    const memo = parts[2] ? parts[2].trim() : '';
    if (!start || !end) return null;
    return { id: issue.id, number: issue.number, member, start: start.trim(), end: end.trim(), memo };
  } catch {
    return null;
  }
}

function vacationToTitle(member, start, end, memo) {
  return `[VACATION] ${member} | ${start}~${end}${memo ? ' | ' + memo : ''}`;
}

async function ensureLabel(name, color) {
  const labelName = MEMBER_LABEL_PREFIX + name;
  // ラベルがなければ作成
  try {
    await ghFetch(`/labels/${encodeURIComponent(labelName)}`);
  } catch {
    await ghFetch('/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: labelName, color: color.replace('#', '') }),
    }).catch(() => {});
  }
  try {
    await ghFetch(`/labels/${encodeURIComponent(VACATION_LABEL)}`);
  } catch {
    await ghFetch('/labels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: VACATION_LABEL, color: '0075ca' }),
    }).catch(() => {});
  }
}

async function loadVacations() {
  showStatus('読み込み中...', 'info');
  state.loading = true;
  renderCalendar();

  try {
    // ページング対応（最大500件）
    let all = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await ghFetch(
        `/issues?labels=${VACATION_LABEL}&state=open&per_page=100&page=${page}`
      );
      all = all.concat(batch);
      if (batch.length < 100) break;
    }

    state.members = {};
    state.vacations = [];
    let colorIdx = 0;

    for (const issue of all) {
      const v = issueToVacation(issue);
      if (!v) continue;
      if (!state.members[v.member]) {
        state.members[v.member] = PALETTE[colorIdx % PALETTE.length];
        colorIdx++;
      }
      v.color = state.members[v.member];
      state.vacations.push(v);
    }

    showStatus(`${state.vacations.length} 件の休みを読み込みました`, 'ok');
    setTimeout(() => hideStatus(), 3000);
  } catch (e) {
    showStatus(`エラー: ${e.message}`, 'error');
  }

  state.loading = false;
  renderLegend();
  renderCalendar();
  updateMemberDatalist();
}

async function addVacation(member, start, end, memo) {
  const color = state.members[member] || PALETTE[Object.keys(state.members).length % PALETTE.length];
  showStatus('追加中...', 'info');

  await ensureLabel(member, color);

  const issue = await ghFetch('/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: vacationToTitle(member, start, end, memo),
      labels: [VACATION_LABEL, MEMBER_LABEL_PREFIX + member],
    }),
  });

  if (!state.members[member]) {
    state.members[member] = color;
  }

  const v = { id: issue.id, number: issue.number, member, start, end, memo, color };
  state.vacations.push(v);

  renderLegend();
  renderCalendar();
  updateMemberDatalist();
  showStatus(`${member} の休みを追加しました`, 'ok');
  setTimeout(() => hideStatus(), 3000);
}

async function deleteVacation(number) {
  showStatus('削除中...', 'info');
  await ghFetch(`/issues/${number}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed' }),
  });

  state.vacations = state.vacations.filter(v => v.number !== number);

  // 使われなくなったメンバーを凡例から除外
  const usedMembers = new Set(state.vacations.map(v => v.member));
  for (const m of Object.keys(state.members)) {
    if (!usedMembers.has(m)) delete state.members[m];
  }

  renderLegend();
  renderCalendar();
  updateMemberDatalist();
  showStatus('削除しました', 'ok');
  setTimeout(() => hideStatus(), 3000);
}

// ─── レンダリング ────────────────────────────

function renderLegend() {
  const legend = document.getElementById('legend');
  legend.innerHTML = Object.entries(state.members)
    .map(([name, color]) => `
      <div class="legend-item">
        <span class="legend-dot" style="background:${color}"></span>
        <span>${escapeHtml(name)}</span>
      </div>
    `).join('');
}

function renderCalendar() {
  const body = document.getElementById('calendar-body');
  const label = document.getElementById('month-label');

  const y = state.year;
  const m = state.month;
  label.textContent = `${y}年 ${m + 1}月`;

  if (state.loading) {
    body.innerHTML = '<div class="loading-spinner">読み込み中...</div>';
    return;
  }

  const firstDay = new Date(y, m, 1).getDay();  // 0=日
  const lastDate = new Date(y, m + 1, 0).getDate();
  const todayStr = toDateStr(new Date());

  // カレンダーのセルを生成
  const cells = [];
  const totalCells = Math.ceil((firstDay + lastDate) / 7) * 7;

  for (let i = 0; i < totalCells; i++) {
    const dayOffset = i - firstDay;
    const date = new Date(y, m, 1 + dayOffset);
    const dateStr = toDateStr(date);
    const isCurrentMonth = date.getMonth() === m;
    const isToday = dateStr === todayStr;

    const dayVacations = state.vacations.filter(v => isInRange(dateStr, v.start, v.end));

    const barsHtml = dayVacations.map(v => {
      const isStart = v.start === dateStr;
      const label = isStart ? escapeHtml(v.member) : '';
      return `
        <div class="vacation-bar"
             style="background:${v.color}"
             title="${escapeHtml(v.member)}: ${v.start} ~ ${v.end}${v.memo ? ' (' + v.memo + ')' : ''}"
             data-del="${v.number}">
          <span class="bar-name">${label}</span>
          ${isStart ? `<span class="bar-del" data-del="${v.number}">✕</span>` : ''}
        </div>`;
    }).join('');

    cells.push(`
      <div class="cal-cell${isCurrentMonth ? '' : ' other-month'}${isToday ? ' today' : ''}">
        <div class="day-num">${date.getDate()}</div>
        ${barsHtml}
      </div>
    `);
  }

  body.innerHTML = cells.join('');

  // 削除ボタンのイベント
  body.querySelectorAll('[data-del]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const number = parseInt(el.dataset.del);
      const v = state.vacations.find(v => v.number === number);
      if (!v) return;
      state.deleteTarget = number;
      document.getElementById('delete-desc').textContent =
        `${v.member} の休み（${v.start} ~ ${v.end}）を削除しますか？`;
      document.getElementById('delete-modal').classList.remove('hidden');
    });
  });
}

function updateMemberDatalist() {
  const dl = document.getElementById('member-list');
  dl.innerHTML = Object.keys(state.members)
    .map(n => `<option value="${escapeHtml(n)}">`)
    .join('');
}

// ─── ステータス ──────────────────────────────

function showStatus(msg, type = 'info') {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.className = `status-bar ${type}`;
}
function hideStatus() {
  const bar = document.getElementById('status-bar');
  bar.classList.add('hidden');
}

// ─── 設定 ────────────────────────────────────

function loadSettings() {
  state.repo  = localStorage.getItem('gh_repo')  || '';
  state.token = localStorage.getItem('gh_token') || '';
  return !!(state.repo && state.token);
}

function saveSettings(repo, token) {
  state.repo  = repo;
  state.token = token;
  localStorage.setItem('gh_repo',  repo);
  localStorage.setItem('gh_token', token);
}

// ─── ユーティリティ ──────────────────────────

function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function isInRange(dateStr, start, end) {
  return dateStr >= start && dateStr <= end;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── イベント登録 ────────────────────────────

function bindEvents() {
  // 月移動
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (state.month === 0) { state.month = 11; state.year--; }
    else state.month--;
    renderCalendar();
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    if (state.month === 11) { state.month = 0; state.year++; }
    else state.month++;
    renderCalendar();
  });
  document.getElementById('btn-today').addEventListener('click', () => {
    const now = new Date();
    state.year = now.getFullYear();
    state.month = now.getMonth();
    renderCalendar();
  });

  // 設定モーダル
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('input-repo').value  = state.repo;
    document.getElementById('input-token').value = state.token;
    document.getElementById('settings-modal').classList.remove('hidden');
  });
  document.getElementById('btn-cancel-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.add('hidden');
  });
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const repo  = document.getElementById('input-repo').value.trim();
    const token = document.getElementById('input-token').value.trim();
    if (!repo || !token) { alert('リポジトリとトークンを入力してください'); return; }
    saveSettings(repo, token);
    document.getElementById('settings-modal').classList.add('hidden');
    document.getElementById('btn-add').disabled = false;
    await loadVacations();
  });

  // 休み追加モーダル
  document.getElementById('btn-add').addEventListener('click', () => {
    const today = toDateStr(new Date());
    document.getElementById('input-name').value  = '';
    document.getElementById('input-start').value = today;
    document.getElementById('input-end').value   = today;
    document.getElementById('input-memo').value  = '';
    document.getElementById('add-modal').classList.remove('hidden');
  });
  document.getElementById('btn-cancel-add').addEventListener('click', () => {
    document.getElementById('add-modal').classList.add('hidden');
  });
  document.getElementById('btn-submit-add').addEventListener('click', async () => {
    const name  = document.getElementById('input-name').value.trim();
    const start = document.getElementById('input-start').value;
    const end   = document.getElementById('input-end').value;
    const memo  = document.getElementById('input-memo').value.trim();
    if (!name)  { alert('名前を入力してください'); return; }
    if (!start || !end) { alert('日付を入力してください'); return; }
    if (start > end)    { alert('終了日は開始日以降にしてください'); return; }
    document.getElementById('add-modal').classList.add('hidden');
    try {
      await addVacation(name, start, end, memo);
    } catch (e) {
      showStatus(`エラー: ${e.message}`, 'error');
    }
  });

  // 削除確認モーダル
  document.getElementById('btn-cancel-delete').addEventListener('click', () => {
    document.getElementById('delete-modal').classList.add('hidden');
    state.deleteTarget = null;
  });
  document.getElementById('btn-confirm-delete').addEventListener('click', async () => {
    document.getElementById('delete-modal').classList.add('hidden');
    if (state.deleteTarget == null) return;
    const number = state.deleteTarget;
    state.deleteTarget = null;
    try {
      await deleteVacation(number);
    } catch (e) {
      showStatus(`エラー: ${e.message}`, 'error');
    }
  });

  // オーバーレイクリックで閉じる
  ['settings-modal', 'add-modal', 'delete-modal'].forEach(id => {
    document.getElementById(id).addEventListener('click', e => {
      if (e.target.id === id) {
        document.getElementById(id).classList.add('hidden');
      }
    });
  });
}

// ─── 起動 ────────────────────────────────────

(async function init() {
  bindEvents();

  const ready = loadSettings();
  renderCalendar(); // 空のカレンダーを表示

  if (ready) {
    document.getElementById('btn-add').disabled = false;
    await loadVacations();
  } else {
    showStatus('右上の ⚙️ から GitHub リポジトリと Personal Access Token を設定してください', 'info');
    // 設定モーダルを自動表示
    document.getElementById('settings-modal').classList.remove('hidden');
  }
})();
