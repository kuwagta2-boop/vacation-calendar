// ─────────────────────────────────────────────
//  休みカレンダー — app.js
//  GitHub Issues をデータストアとして利用
// ─────────────────────────────────────────────

const VACATION_LABEL = 'vacation';
const MEMBER_LABEL_PREFIX = 'member-';
const DRIVE_FOLDER_ID = '1F8m4_6KCIJevFN1ntT8SHXbP_B-my4nv';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// 名前から固有色を生成（ハッシュ → 黄金角でHSL分散）
function nameToColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
    hash |= 0;
  }
  // 黄金角（137.508°）を使って色相を均等分散
  const hue = Math.round((((Math.abs(hash) * 0.618033988749895) % 1) * 360));
  return `hsl(${hue}, 85%, 48%)`;
}

// ─── 状態 ───────────────────────────────────
let state = {
  repo: '',
  token: '',
  gClientId: '',
  gAccessToken: '',
  year: new Date().getFullYear(),
  month: new Date().getMonth(), // 0-indexed
  vacations: [],       // { id, number, member, start, end, memo, color }
  members: {},         // { name: color }
  holidays: {},        // { "YYYY-MM-DD": "祝日名" }
  loading: false,
  deleteTarget: null,
};

// ─── Google Drive 連携 ───────────────────────

function googleSignIn() {
  return new Promise((resolve, reject) => {
    if (!state.gClientId) return reject(new Error('Google Client ID が設定されていません'));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: state.gClientId,
      scope: DRIVE_SCOPE,
      callback: (res) => {
        if (res.error) return reject(new Error(res.error));
        state.gAccessToken = res.access_token;
        resolve(res.access_token);
      },
    });
    client.requestAccessToken();
  });
}

async function getOrCreateCsvFileId(filename, accessToken) {
  // 同名ファイルが既にあれば上書き対象のIDを返す
  const q = encodeURIComponent(`name='${filename}' and '${DRIVE_FOLDER_ID}' in parents and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0].id : null;
}

async function uploadCsvToDrive(csvContent, filename, accessToken) {
  const existingId = await getOrCreateCsvFileId(filename, accessToken);
  const bom = '\uFEFF';
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' });

  if (existingId) {
    // 上書き
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/csv' },
      body: blob,
    });
  } else {
    // 新規作成（multipart）
    const meta = JSON.stringify({ name: filename, parents: [DRIVE_FOLDER_ID] });
    const form = new FormData();
    form.append('metadata', new Blob([meta], { type: 'application/json' }));
    form.append('file', blob);
    await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
  }
}

async function autoSaveCsvToDrive() {
  if (!state.gClientId) return; // Google未設定なら何もしない
  try {
    const token = state.gAccessToken || await googleSignIn();
    const y = state.year;
    const m = state.month;
    const filename = `vacation_${y}-${String(m + 1).padStart(2, '0')}.csv`;
    const csvContent = buildCsvContent(y, m);
    await uploadCsvToDrive(csvContent, filename, token);
    showStatus(`Google Drive に ${filename} を保存しました`, 'ok');
    setTimeout(() => hideStatus(), 4000);
  } catch (e) {
    // Drive保存失敗はサイレントに（メイン操作は成功済み）
    console.warn('Drive保存エラー:', e.message);
  }
}

// ─── 祝日取得 ────────────────────────────────

async function loadHolidays() {
  try {
    const res = await fetch('https://holidays-jp.github.io/api/v1/date.json');
    if (res.ok) state.holidays = await res.json();
  } catch {
    // 祝日取得失敗は無視
  }
}

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

// Issue のタイトルをパース: "[VACATION] member | 2024-01-01~2024-01-05 | memo | vtype"
function issueToVacation(issue) {
  if (!issue.title.startsWith('[VACATION]')) return null;
  try {
    const body = issue.title.replace('[VACATION]', '').trim();
    const parts = body.split(' | ');
    if (parts.length < 2) return null;
    const member = parts[0].trim();
    const [start, end] = parts[1].trim().split('~');
    const memo = parts[2] ? parts[2].trim() : '';
    const vtype = parts[3] && ['AM', 'PM'].includes(parts[3].trim()) ? parts[3].trim() : 'full';
    if (!start || !end) return null;
    return { id: issue.id, number: issue.number, member, start: start.trim(), end: end.trim(), memo, vtype };
  } catch {
    return null;
  }
}

function vacationToTitle(member, start, end, memo, vtype) {
  let title = `[VACATION] ${member} | ${start}~${end} | ${memo}`;
  if (vtype && vtype !== 'full') title += ` | ${vtype}`;
  return title;
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
    for (const issue of all) {
      const v = issueToVacation(issue);
      if (!v) continue;
      if (!state.members[v.member]) {
        state.members[v.member] = nameToColor(v.member);
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

async function addVacation(member, start, end, memo, vtype = 'full') {
  const color = state.members[member] || nameToColor(member);
  showStatus('追加中...', 'info');

  const issue = await ghFetch('/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: vacationToTitle(member, start, end, memo, vtype),
      labels: [VACATION_LABEL],
    }),
  });

  if (!state.members[member]) {
    state.members[member] = color;
  }

  const v = { id: issue.id, number: issue.number, member, start, end, memo, vtype, color };
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
    const holidayName = state.holidays[dateStr] || '';

    const dayVacations = state.vacations.filter(v => isInRange(dateStr, v.start, v.end));

    const barsHtml = dayVacations.map(v => {
      const isStart = v.start === dateStr;
      const label = escapeHtml(v.member);
      const vtype = v.vtype || 'full';
      const bgStyle = `background: ${v.color}`;
      const typeLabel = vtype !== 'full' ? vtype : '';
      const typeTitle = vtype === 'AM' ? 'AM休み' : vtype === 'PM' ? 'PM休み' : '1日休み';
      return `
        <div class="vacation-bar"
             style="${bgStyle}"
             data-vtype="${vtype}"
             title="${escapeHtml(v.member)}: ${v.start} ~ ${v.end} [${typeTitle}]${v.memo ? ' (' + v.memo + ')' : ''}"
             data-del="${v.number}">
          <span class="bar-name">${label}</span>
          ${typeLabel ? `<span class="bar-type-badge">${typeLabel}</span>` : ''}
          ${isStart ? `<span class="bar-del" data-del="${v.number}">✕</span>` : ''}
        </div>`;
    }).join('');

    cells.push(`
      <div class="cal-cell${isCurrentMonth ? '' : ' other-month'}${isToday ? ' today' : ''}${holidayName ? ' holiday' : ''}" data-date="${dateStr}">
        <div class="day-num" ${holidayName ? `title="${escapeHtml(holidayName)}"` : ''}>${date.getDate()}</div>
        ${holidayName ? `<div class="holiday-name">${escapeHtml(holidayName)}</div>` : ''}
        ${barsHtml}
      </div>
    `);
  }

  body.innerHTML = cells.join('');

  // 日付セルクリックで休み追加モーダルを開く
  body.querySelectorAll('.cal-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', () => {
      if (!state.repo || !state.token) return;
      const dateStr = cell.dataset.date;
      document.getElementById('input-name-select').value = '';
      document.getElementById('new-member-wrap').classList.add('hidden');
      document.getElementById('input-name-new').value  = '';
      document.getElementById('input-start').value = dateStr;
      document.getElementById('input-end').value   = dateStr;
      document.getElementById('input-memo').value  = '';
      document.querySelector('input[name="vtype"][value="full"]').checked = true;
      document.getElementById('add-modal').classList.remove('hidden');
    });
  });

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
  const sel = document.getElementById('input-name-select');
  const current = sel.value;
  sel.innerHTML = '';

  // プレースホルダー
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- 選択してください --';
  sel.appendChild(placeholder);

  // 既存メンバー（五十音順）
  Object.keys(state.members).sort().forEach(name => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    sel.appendChild(o);
  });

  // 新規追加は一番下
  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '＋ 新しいメンバーを追加';
  sel.appendChild(newOpt);

  // 選択を復元（可能なら）
  if ([...sel.options].some(o => o.value === current)) sel.value = current;
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

// ─── CSV出力 ─────────────────────────────────

function buildCsvContent(y, m) {
  const rows = [['名前', '日付', '種別', 'メモ']];
  const lastDate = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= lastDate; d++) {
    const dateStr = toDateStr(new Date(y, m, d));
    for (const v of state.vacations) {
      if (isInRange(dateStr, v.start, v.end)) {
        const typeLabel = v.vtype === 'AM' ? 'AM休み' : v.vtype === 'PM' ? 'PM休み' : '1日休み';
        rows.push([v.member, dateStr, typeLabel, v.memo || '']);
      }
    }
  }
  return rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

function exportCSV() {
  const y = state.year;
  const m = state.month;
  const csv = buildCsvContent(y, m);
  const bom = '\uFEFF';
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vacation_${y}-${String(m + 1).padStart(2, '0')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── 設定 ────────────────────────────────────

function loadSettings() {
  state.repo      = localStorage.getItem('gh_repo')      || '';
  state.token     = localStorage.getItem('gh_token')     || '';
  state.gClientId = localStorage.getItem('g_client_id')  || '958063370820-rd874sgoi27r1riel1kel55nmc2nph7v.apps.googleusercontent.com';
  return !!(state.repo && state.token);
}

function saveSettings(repo, token, gClientId) {
  state.repo      = repo;
  state.token     = token;
  state.gClientId = gClientId;
  localStorage.setItem('gh_repo',      repo);
  localStorage.setItem('gh_token',     token);
  localStorage.setItem('g_client_id',  gClientId);
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

  // CSVダウンロード
  document.getElementById('btn-csv').addEventListener('click', exportCSV);

  // 設定モーダル
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('input-repo').value    = state.repo;
    document.getElementById('input-token').value   = state.token;
    document.getElementById('input-gclient').value = state.gClientId;
    document.getElementById('settings-modal').classList.remove('hidden');
  });
  document.getElementById('btn-cancel-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.add('hidden');
  });
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const repo      = document.getElementById('input-repo').value.trim();
    const token     = document.getElementById('input-token').value.trim();
    const gClientId = document.getElementById('input-gclient').value.trim();
    if (!repo || !token) { alert('リポジトリとトークンを入力してください'); return; }
    saveSettings(repo, token, gClientId);
    document.getElementById('settings-modal').classList.add('hidden');
    document.getElementById('btn-add').disabled = false;
    document.getElementById('btn-csv').disabled = false;
    await loadVacations();
  });

  // 名前セレクト：「新しいメンバーを追加」選択時にテキスト入力を表示
  document.getElementById('input-name-select').addEventListener('change', () => {
    const isNew = document.getElementById('input-name-select').value === '__new__';
    document.getElementById('new-member-wrap').classList.toggle('hidden', !isNew);
    if (isNew) document.getElementById('input-name-new').focus();
  });

  // 休み追加モーダル
  document.getElementById('btn-add').addEventListener('click', () => {
    const today = toDateStr(new Date());
    document.getElementById('input-name-select').value = '';
    document.getElementById('new-member-wrap').classList.add('hidden');
    document.getElementById('input-name-new').value  = '';
    document.getElementById('input-start').value = today;
    document.getElementById('input-end').value   = today;
    document.getElementById('input-memo').value  = '';
    document.querySelector('input[name="vtype"][value="full"]').checked = true;
    document.getElementById('add-modal').classList.remove('hidden');
  });
  document.getElementById('btn-cancel-add').addEventListener('click', () => {
    document.getElementById('add-modal').classList.add('hidden');
  });
  document.getElementById('btn-submit-add').addEventListener('click', async () => {
    const selectVal = document.getElementById('input-name-select').value;
    const rawName = selectVal === '__new__'
      ? document.getElementById('input-name-new').value
      : selectVal;
    const name = rawName.trim().replace(/　/g, ' ');
    const start = document.getElementById('input-start').value;
    const end   = document.getElementById('input-end').value;
    const memo  = document.getElementById('input-memo').value.trim();
    const vtype = document.querySelector('input[name="vtype"]:checked')?.value || 'full';
    if (!name)  { alert('名前を入力してください'); return; }
    if (!start || !end) { alert('日付を入力してください'); return; }
    if (start > end)    { alert('終了日は開始日以降にしてください'); return; }
    document.getElementById('add-modal').classList.add('hidden');
    try {
      await addVacation(name, start, end, memo, vtype);
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
  await loadHolidays();

  const ready = loadSettings();
  renderCalendar(); // 空のカレンダーを表示

  if (ready) {
    document.getElementById('btn-add').disabled = false;
    document.getElementById('btn-csv').disabled = false;
    await loadVacations();
  } else {
    showStatus('右上の ⚙️ から GitHub リポジトリと Personal Access Token を設定してください', 'info');
    // 設定モーダルを自動表示
    document.getElementById('settings-modal').classList.remove('hidden');
  }
})();
