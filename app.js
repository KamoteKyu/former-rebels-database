/* ============================================================
   FORMER REBELS DATABASE SYSTEM — app.js
   ============================================================ */

// ── INITIAL DATA SETUP ──────────────────────────────────────
(function initData() {
  if (!localStorage.getItem('frdb_users')) {
    const users = [
      { id: 'admin', username: 'ADMIN', password: 'admin123', role: 'ADMIN' }
    ];
    localStorage.setItem('frdb_users', JSON.stringify(users));
  }
  if (!localStorage.getItem('frdb_records')) {
    localStorage.setItem('frdb_records', JSON.stringify([]));
  }
})();

// ── STATE ────────────────────────────────────────────────────
let currentUser = null;
let currentPage = 'dashboard';
let editingRecordId = null;
let deleteTargetId = null;
let viewingRecordId = null;
let validIdSlots = [];   // [{id, dataUrl, fileName}]
let idPhotoData = null;
let japicData = null;    // {dataUrl, fileName, type}

// ── HELPERS ──────────────────────────────────────────────────
function getUsers()   { return JSON.parse(localStorage.getItem('frdb_users') || '[]'); }
function getRecords() { return JSON.parse(localStorage.getItem('frdb_records') || '[]'); }
function saveUsers(u) {
  try { localStorage.setItem('frdb_users', JSON.stringify(u)); }
  catch(e) { showToast('ERROR SAVING USERS: STORAGE FULL', 'error'); }
}
function saveRecords(r) {
  try { localStorage.setItem('frdb_records', JSON.stringify(r)); return true; }
  catch(e) {
    showToast('STORAGE QUOTA EXCEEDED — TRY REMOVING LARGE IMAGES', 'error');
    console.error('saveRecords failed:', e);
    return false;
  }
}
function genId()      { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
}

function calcAge() {
  const dob = document.getElementById('dob').value;
  if (!dob) { document.getElementById('age').value = ''; return; }
  const today = new Date();
  const birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  document.getElementById('age').value = age >= 0 ? age : '';
}

function calcAgeFromDob(dob) {
  if (!dob) return '';
  const today = new Date();
  const birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age >= 0 ? age : '';
}

function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
}

function togglePw() {
  const inp = document.getElementById('loginPass');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

// ── LOGIN / LOGOUT ───────────────────────────────────────────
function doLogin() {
  const u = document.getElementById('loginUser').value.trim().toUpperCase();
  const p = document.getElementById('loginPass').value;
  const err = document.getElementById('loginError');
  if (!u || !p) { err.textContent = 'PLEASE ENTER USERNAME AND PASSWORD.'; return; }
  const users = getUsers();
  const found = users.find(x => x.username.toUpperCase() === u && x.password === p);
  if (!found) { err.textContent = 'INVALID USERNAME OR PASSWORD.'; return; }
  currentUser = found;
  err.textContent = '';
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');
  document.getElementById('sidebarUsername').textContent = found.username;
  document.getElementById('sidebarRole').textContent = found.role;
  document.getElementById('topbarUser').textContent = found.username + ' (' + found.role + ')';
  // Show/hide admin-only nav
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = found.role === 'ADMIN' ? 'flex' : 'none';
  });
  showPage('dashboard');
  startClock();
}

document.getElementById('loginPass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});
document.getElementById('loginUser').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('loginPass').focus();
});

function doLogout() {
  currentUser = null;
  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginError').textContent = '';
  stopClock();
}

// ── CLOCK ────────────────────────────────────────────────────
let clockInterval = null;
function startClock() {
  updateClock();
  clockInterval = setInterval(updateClock, 1000);
}
function stopClock() { clearInterval(clockInterval); }
function updateClock() {
  const now = new Date();
  document.getElementById('currentDateTime').textContent =
    now.toLocaleDateString('en-PH', { weekday:'short', year:'numeric', month:'short', day:'numeric' }) +
    '  ' + now.toLocaleTimeString('en-PH');
}

// ── NAVIGATION ───────────────────────────────────────────────
function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const titles = {
    dashboard: 'DASHBOARD',
    records: 'RECORDS',
    addRecord: editingRecordId ? 'EDIT RECORD' : 'ADD NEW RECORD',
    users: 'USER MANAGEMENT'
  };
  document.getElementById('pageTitle').textContent = titles[page] || page.toUpperCase();
  document.getElementById('page-' + page).classList.add('active');

  // Highlight nav
  const navMap = { dashboard: 0, records: 1, addRecord: 2, users: 3 };
  const navItems = document.querySelectorAll('.nav-item');
  if (navMap[page] !== undefined) navItems[navMap[page]].classList.add('active');

  if (page === 'dashboard') renderDashboard();
  if (page === 'records') renderRecords();
  if (page === 'addRecord') {
    if (!editingRecordId) {
      resetForm();
      document.getElementById('formTitle').textContent = 'ADD NEW RECORD';
    }
  }
  if (page === 'users') renderUsers();

  // Close sidebar on mobile
  if (window.innerWidth <= 900) document.getElementById('sidebar').classList.remove('open');
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ── DASHBOARD ────────────────────────────────────────────────
function renderDashboard() {
  const records = getRecords();
  const thisYear = new Date().getFullYear();
  document.getElementById('statTotal').textContent = records.length;
  document.getElementById('statMale').textContent = records.filter(r => r.sex === 'MALE').length;
  document.getElementById('statFemale').textContent = records.filter(r => r.sex === 'FEMALE').length;
  document.getElementById('statThisYear').textContent = records.filter(r => {
    if (!r.dateSurrendered) return false;
    return new Date(r.dateSurrendered).getFullYear() === thisYear;
  }).length;
  document.getElementById('statRegularNPA').textContent = records.filter(r => r.membershipType === 'REGULAR NPA').length;
  document.getElementById('statMilisyang').textContent  = records.filter(r => r.membershipType === 'MILISYANG BAYAN').length;

  renderAssistanceReport(records);
  renderMembershipReport(records);

  const tbody = document.getElementById('recentTableBody');
  const recent = [...records].reverse().slice(0, 8);
  if (recent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state"><div class="empty-icon">📋</div><p>NO RECORDS YET</p></td></tr>';
    return;
  }
  tbody.innerHTML = recent.map(r => `
    <tr>
      <td>${r.lastName}, ${r.firstName} ${r.middleName || ''}</td>
      <td>${formatDate(r.dateSurrendered)}</td>
      <td>${r.areaOfOperation || '—'}</td>
      <td><span class="tag tag-green">ACTIVE</span></td>
    </tr>
  `).join('');
}

// ── ASSISTANCE REPORT ─────────────────────────────────────────
function renderAssistanceReport(records) {
  const ASST_TYPES = [
    'E-CLIP',
    'FEA REMUNERATION',
    'LIVELIHOOD',
    'MEDICAL',
    'EDUCATIONAL',
    'ISSUANCE OF CREDENTIALS',
    'PHILHEALTH',
    'OTHERS'
  ];

  // Count per type (OTHERS catches any "OTHERS: ..." entries too)
  const counts = {};
  ASST_TYPES.forEach(t => counts[t] = 0);

  records.forEach(r => {
    (r.assistance || []).forEach(a => {
      const key = a.startsWith('OTHERS') ? 'OTHERS' : a;
      if (counts[key] !== undefined) counts[key]++;
    });
  });

  const total = records.length;
  const maxCount = Math.max(...Object.values(counts), 1);

  // Beneficiaries = records that received at least one assistance
  const beneficiaries = records.filter(r => r.assistance && r.assistance.length > 0).length;
  document.getElementById('asstTotalBadge').textContent = beneficiaries + ' TOTAL BENEFICIARIES';

  // ── BAR CHART ──
  const SHORT_LABELS = {
    'E-CLIP': 'E-CLIP',
    'FEA REMUNERATION': 'FEA',
    'LIVELIHOOD': 'LIVELIHOOD',
    'MEDICAL': 'MEDICAL',
    'EDUCATIONAL': 'EDUCATIONAL',
    'ISSUANCE OF CREDENTIALS': 'CREDENTIALS',
    'PHILHEALTH': 'PHILHEALTH',
    'OTHERS': 'OTHERS'
  };

  document.getElementById('asstBars').innerHTML = ASST_TYPES.map(type => {
    const count = counts[type];
    const pct = Math.round((count / maxCount) * 100);
    return `
      <div class="asst-bar-group">
        <div class="asst-bar-wrap">
          <div class="asst-bar-count">${count}</div>
          <div class="asst-bar" style="height:${pct}%" title="${type}: ${count}"></div>
        </div>
        <div class="asst-bar-label">${SHORT_LABELS[type]}</div>
      </div>
    `;
  }).join('');

  // ── SUMMARY TABLE ──
  const tbody = document.getElementById('asstTableBody');
  tbody.innerHTML = ASST_TYPES.map(type => {
    const count = counts[type];
    const pctOfTotal = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    const barWidth = total > 0 ? Math.round((count / total) * 100) : 0;
    return `
      <tr class="${count === 0 ? 'asst-zero' : ''}">
        <td>${type}</td>
        <td style="text-align:center;font-weight:${count > 0 ? '700' : '400'};color:${count > 0 ? 'var(--accent2)' : 'var(--text3)'}">
          ${count}
        </td>
        <td style="text-align:center">${pctOfTotal}%</td>
        <td>
          <div class="asst-mini-bar-wrap">
            <div class="asst-mini-bar" style="width:${barWidth}%"></div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Total row
  const totalAsst = Object.values(counts).reduce((a, b) => a + b, 0);
  document.getElementById('asstTableFoot').innerHTML = `
    <tr class="asst-tfoot-row">
      <td>TOTAL ASSISTANCE RENDERED</td>
      <td style="text-align:center">${totalAsst}</td>
      <td style="text-align:center">—</td>
      <td></td>
    </tr>
  `;
}

// ── MEMBERSHIP TYPE REPORT ────────────────────────────────────
function renderMembershipReport(records) {
  const TYPES = ['REGULAR NPA', 'MILISYANG BAYAN'];
  const COLORS = { 'REGULAR NPA': '#f85149', 'MILISYANG BAYAN': '#d29922' };

  const counts = {};
  TYPES.forEach(t => counts[t] = 0);
  records.forEach(r => {
    if (r.membershipType && counts[r.membershipType] !== undefined) counts[r.membershipType]++;
  });

  const total = records.length;
  const withType = TYPES.reduce((s, t) => s + counts[t], 0);
  document.getElementById('membershipTotalBadge').textContent = withType + ' WITH MEMBERSHIP TYPE';

  // ── DONUT CHART (canvas) ──
  const canvas = document.getElementById('membershipDonut');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 160, 160);
  const cx = 80, cy = 80, r = 60, inner = 36;
  const total2 = withType || 1;
  let startAngle = -Math.PI / 2;
  TYPES.forEach(type => {
    const slice = (counts[type] / total2) * 2 * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, startAngle, startAngle + slice);
    ctx.closePath();
    ctx.fillStyle = COLORS[type];
    ctx.fill();
    startAngle += slice;
  });
  // Hollow centre
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, 2 * Math.PI);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg2').trim() || '#161b22';
  ctx.fill();
  // Centre text
  ctx.fillStyle = '#e6edf3';
  ctx.font = 'bold 18px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(withType, cx, cy);

  // Legend
  document.getElementById('donutLegend').innerHTML = TYPES.map(t => `
    <div class="donut-legend-item">
      <span class="donut-dot" style="background:${COLORS[t]}"></span>
      <span>${t}</span>
      <strong>${counts[t]}</strong>
    </div>
  `).join('');

  // ── TABLE ──
  document.getElementById('membershipTableBody').innerHTML = TYPES.map(type => {
    const count = counts[type];
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    const barW = total > 0 ? Math.round((count / total) * 100) : 0;
    return `
      <tr>
        <td><span class="donut-dot" style="background:${COLORS[type]};display:inline-block;margin-right:6px"></span>${type}</td>
        <td style="text-align:center;font-weight:700;color:${COLORS[type]}">${count}</td>
        <td style="text-align:center">${pct}%</td>
        <td>
          <div class="asst-mini-bar-wrap">
            <div class="asst-mini-bar" style="width:${barW}%;background:${COLORS[type]}"></div>
          </div>
        </td>
      </tr>
    `;
  }).join('') + `
    <tr style="border-top:2px solid var(--border);background:var(--bg3)">
      <td style="font-weight:700">NOT SPECIFIED</td>
      <td style="text-align:center;font-weight:700;color:var(--text2)">${total - withType}</td>
      <td style="text-align:center">${total > 0 ? (((total - withType) / total) * 100).toFixed(1) : '0.0'}%</td>
      <td></td>
    </tr>
  `;
}

// ── RECORDS LIST ─────────────────────────────────────────────
function renderRecords(filter = '') {
  let records = getRecords();
  if (filter) {
    const q = filter.toLowerCase();
    records = records.filter(r =>
      (r.lastName + ' ' + r.firstName + ' ' + r.middleName).toLowerCase().includes(q) ||
      (r.alias || '').toLowerCase().includes(q) ||
      (r.unit || '').toLowerCase().includes(q) ||
      (r.referringUnit || '').toLowerCase().includes(q)
    );
  }
  const tbody = document.getElementById('recordsTableBody');
  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10">
      <div class="empty-state"><div class="empty-icon">🔍</div><p>NO RECORDS FOUND</p></div>
    </td></tr>`;
    return;
  }
  tbody.innerHTML = records.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${r.idPhoto
        ? `<img src="${r.idPhoto}" class="record-thumb" alt="ID"/>`
        : `<div class="no-photo">👤</div>`}</td>
      <td><strong>${r.lastName}, ${r.firstName}</strong>${r.middleName ? ' ' + r.middleName : ''}</td>
      <td>${r.alias || '—'}</td>
      <td>${r.sex || '—'}</td>
      <td>${calcAgeFromDob(r.dob) || '—'}</td>
      <td>${r.unit || '—'}</td>
      <td>${formatDate(r.dateSurrendered)}</td>
      <td>${r.areaOfOperation || '—'}</td>
      <td>
        <div class="action-btns">
          <button class="btn-view" onclick="viewRecord('${r.id}')">👁 VIEW</button>
          <button class="btn-edit" onclick="editRecord('${r.id}')">✏ EDIT</button>
          <button class="btn-del" onclick="promptDelete('${r.id}')">🗑 DEL</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function filterRecords() {
  renderRecords(document.getElementById('searchInput').value);
}

// ── ID PHOTO ─────────────────────────────────────────────────
function previewIdPhoto(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    idPhotoData = e.target.result;
    const img = document.getElementById('idPhotoPreview');
    img.src = idPhotoData;
    img.style.display = 'block';
    document.getElementById('idPhotoPlaceholder').style.display = 'none';
    document.getElementById('removePhotoBtn').style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function removeIdPhoto() {
  idPhotoData = null;
  document.getElementById('idPhotoPreview').src = '';
  document.getElementById('idPhotoPreview').style.display = 'none';
  document.getElementById('idPhotoPlaceholder').style.display = 'block';
  document.getElementById('removePhotoBtn').style.display = 'none';
  document.getElementById('idPhotoInput').value = '';
}

// ── VALID ID SLOTS ───────────────────────────────────────────
function addValidIdSlot() {
  const slotId = genId();
  validIdSlots.push({ id: slotId, dataUrl: null, fileName: '' });
  renderValidIdSlots();
}

function renderValidIdSlots() {
  const container = document.getElementById('validIdContainer');
  if (validIdSlots.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = validIdSlots.map((slot, idx) => `
    <div class="upload-slot" id="slot-${slot.id}">
      <span class="upload-slot-label">VALID ID ${idx + 1}</span>
      ${slot.dataUrl
        ? `<img src="${slot.dataUrl}" class="upload-slot-preview" alt="ID"/>`
        : `<span style="font-size:24px">🪪</span>`}
      <span class="upload-slot-name">${slot.fileName || 'NO FILE SELECTED'}</span>
      <button type="button" class="upload-slot-btn" onclick="triggerSlotUpload('${slot.id}')">📁 BROWSE</button>
      <input type="file" id="slotInput-${slot.id}" accept=".jpg,.jpeg" style="display:none"
        onchange="handleSlotUpload(event,'${slot.id}')"/>
      <button type="button" class="btn-del" onclick="removeValidIdSlot('${slot.id}')" style="padding:5px 8px;font-size:0.7rem">✕</button>
    </div>
  `).join('');
}

function triggerSlotUpload(slotId) {
  document.getElementById('slotInput-' + slotId).click();
}

function handleSlotUpload(event, slotId) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const slot = validIdSlots.find(s => s.id === slotId);
    if (slot) { slot.dataUrl = e.target.result; slot.fileName = file.name.toUpperCase(); }
    renderValidIdSlots();
  };
  reader.readAsDataURL(file);
}

function removeValidIdSlot(slotId) {
  validIdSlots = validIdSlots.filter(s => s.id !== slotId);
  renderValidIdSlots();
}

// ── JAPIC ────────────────────────────────────────────────────
function previewJapic(event) {
  const file = event.target.files[0];
  if (!file) return;
  const isPdf = file.type === 'application/pdf';
  const reader = new FileReader();
  reader.onload = e => {
    japicData = { dataUrl: e.target.result, fileName: file.name.toUpperCase(), type: isPdf ? 'pdf' : 'image' };
    const preview = document.getElementById('japicPreview');
    document.getElementById('japicPlaceholder').style.display = 'none';
    preview.style.display = 'block';
    preview.innerHTML = isPdf
      ? `<div class="japic-file-info"><span style="font-size:36px">📄</span><span class="file-name">${file.name.toUpperCase()}</span></div>`
      : `<div class="japic-file-info"><img src="${e.target.result}" alt="JAPIC"/><span class="file-name">${file.name.toUpperCase()}</span></div>`;
    document.getElementById('removeJapicBtn').style.display = 'inline-block';
  };
  reader.readAsDataURL(file);
}

function removeJapic() {
  japicData = null;
  document.getElementById('japicPreview').style.display = 'none';
  document.getElementById('japicPreview').innerHTML = '';
  document.getElementById('japicPlaceholder').style.display = 'block';
  document.getElementById('removeJapicBtn').style.display = 'none';
  document.getElementById('japicInput').value = '';
}

function toggleOthersSpec() {
  const cb = document.getElementById('asst_others');
  const spec = document.getElementById('asst_others_spec');
  spec.style.display = cb.checked ? 'inline-block' : 'none';
  if (!cb.checked) spec.value = '';
}

// ── SAVE RECORD ──────────────────────────────────────────────
function saveRecord(event) {
  event.preventDefault();

  // Collect assistance
  const asstIds = ['asst_eclip','asst_fea','asst_livelihood','asst_medical','asst_educational','asst_credentials','asst_philhealth'];
  const assistance = asstIds.filter(id => document.getElementById(id).checked)
    .map(id => document.getElementById(id).value);
  if (document.getElementById('asst_others').checked) {
    const spec = document.getElementById('asst_others_spec').value.trim();
    assistance.push('OTHERS' + (spec ? ': ' + spec.toUpperCase() : ''));
  }

  const record = {
    id: editingRecordId || genId(),
    // Part I
    lastName:      document.getElementById('lastName').value.trim().toUpperCase(),
    firstName:     document.getElementById('firstName').value.trim().toUpperCase(),
    middleName:    document.getElementById('middleName').value.trim().toUpperCase(),
    alias:         document.getElementById('alias').value.trim().toUpperCase(),
    dob:           document.getElementById('dob').value,
    sex:           document.getElementById('sex').value,
    civilStatus:   document.getElementById('civilStatus').value,
    tribalGroup:   document.getElementById('tribalGroup').value,
    idPhoto:       idPhotoData,
    // Part II
    unit:              document.getElementById('unit').value.trim().toUpperCase(),
    position:          document.getElementById('position').value.trim().toUpperCase(),
    membershipType:    document.getElementById('membershipType').value,
    areaOfOperation:   document.getElementById('areaOfOperation').value,
    yearsInMovement:   document.getElementById('yearsInMovement').value,
    dateSurrendered:   document.getElementById('dateSurrendered').value,
    referringUnit:     document.getElementById('referringUnit').value.trim().toUpperCase(),
    // Part III
    assistance,
    validIds: validIdSlots.filter(s => s.dataUrl).map(s => ({ dataUrl: s.dataUrl, fileName: s.fileName })),
    // Part IV
    japic:             japicData,
    socialCaseReport:  document.getElementById('socialCaseReport').value.trim().toUpperCase(),
    // Meta
    createdBy:  currentUser.username,
    createdAt:  editingRecordId ? undefined : new Date().toISOString(),
    updatedAt:  new Date().toISOString(),
  };

  let records = getRecords();
  if (editingRecordId) {
    const idx = records.findIndex(r => r.id === editingRecordId);
    if (idx !== -1) {
      record.createdAt = records[idx].createdAt;
      records[idx] = record;
    }
    const ok = saveRecords(records);
    if (!ok) return;
    showToast('RECORD UPDATED SUCCESSFULLY', 'success');
  } else {
    record.createdAt = new Date().toISOString();
    records.push(record);
    const ok = saveRecords(records);
    if (!ok) return;
    showToast('RECORD SAVED SUCCESSFULLY', 'success');
  }
  editingRecordId = null;
  showPage('records');
}

function resetForm() {
  editingRecordId = null;
  document.getElementById('recordForm').reset();
  document.getElementById('recordId').value = '';
  document.getElementById('age').value = '';
  removeIdPhoto();
  validIdSlots = [];
  renderValidIdSlots();
  removeJapic();
  // Uncheck all assistance
  ['asst_eclip','asst_fea','asst_livelihood','asst_medical','asst_educational','asst_credentials','asst_philhealth','asst_others'].forEach(id => {
    document.getElementById(id).checked = false;
  });
  document.getElementById('asst_others_spec').style.display = 'none';
  document.getElementById('asst_others_spec').value = '';
}

// ── EDIT RECORD ──────────────────────────────────────────────
function editRecord(id) {
  const records = getRecords();
  const r = records.find(x => x.id === id);
  if (!r) return;
  editingRecordId = id;
  document.getElementById('formTitle').textContent = 'EDIT RECORD';

  // Part I
  document.getElementById('lastName').value    = r.lastName || '';
  document.getElementById('firstName').value   = r.firstName || '';
  document.getElementById('middleName').value  = r.middleName || '';
  document.getElementById('alias').value       = r.alias || '';
  document.getElementById('dob').value         = r.dob || '';
  document.getElementById('sex').value         = r.sex || '';
  document.getElementById('civilStatus').value = r.civilStatus || '';
  document.getElementById('tribalGroup').value = r.tribalGroup || '';
  calcAge();

  // ID Photo
  if (r.idPhoto) {
    idPhotoData = r.idPhoto;
    const img = document.getElementById('idPhotoPreview');
    img.src = r.idPhoto; img.style.display = 'block';
    document.getElementById('idPhotoPlaceholder').style.display = 'none';
    document.getElementById('removePhotoBtn').style.display = 'block';
  } else { removeIdPhoto(); }

  // Part II
  document.getElementById('unit').value             = r.unit || '';
  document.getElementById('position').value         = r.position || '';
  document.getElementById('membershipType').value   = r.membershipType || '';
  document.getElementById('areaOfOperation').value  = r.areaOfOperation || '';
  document.getElementById('yearsInMovement').value  = r.yearsInMovement || '';
  document.getElementById('dateSurrendered').value  = r.dateSurrendered || '';
  document.getElementById('referringUnit').value    = r.referringUnit || '';

  // Part III — assistance
  const asstMap = {
    'E-CLIP': 'asst_eclip', 'FEA REMUNERATION': 'asst_fea', 'LIVELIHOOD': 'asst_livelihood',
    'MEDICAL': 'asst_medical', 'EDUCATIONAL': 'asst_educational',
    'ISSUANCE OF CREDENTIALS': 'asst_credentials', 'PHILHEALTH': 'asst_philhealth'
  };
  Object.values(asstMap).forEach(id => document.getElementById(id).checked = false);
  document.getElementById('asst_others').checked = false;
  document.getElementById('asst_others_spec').style.display = 'none';
  document.getElementById('asst_others_spec').value = '';

  (r.assistance || []).forEach(a => {
    if (asstMap[a]) { document.getElementById(asstMap[a]).checked = true; }
    else if (a.startsWith('OTHERS')) {
      document.getElementById('asst_others').checked = true;
      document.getElementById('asst_others_spec').style.display = 'inline-block';
      const spec = a.replace('OTHERS: ', '').replace('OTHERS', '');
      document.getElementById('asst_others_spec').value = spec;
    }
  });

  // Valid IDs
  validIdSlots = (r.validIds || []).map(v => ({ id: genId(), dataUrl: v.dataUrl, fileName: v.fileName }));
  renderValidIdSlots();

  // Part IV
  if (r.japic) {
    japicData = r.japic;
    const preview = document.getElementById('japicPreview');
    document.getElementById('japicPlaceholder').style.display = 'none';
    preview.style.display = 'block';
    preview.innerHTML = r.japic.type === 'pdf'
      ? `<div class="japic-file-info"><span style="font-size:36px">📄</span><span class="file-name">${r.japic.fileName}</span></div>`
      : `<div class="japic-file-info"><img src="${r.japic.dataUrl}" alt="JAPIC"/><span class="file-name">${r.japic.fileName}</span></div>`;
    document.getElementById('removeJapicBtn').style.display = 'inline-block';
  } else { removeJapic(); }

  document.getElementById('socialCaseReport').value = r.socialCaseReport || '';

  showPage('addRecord');
  document.getElementById('formTitle').textContent = 'EDIT RECORD';
}

// ── VIEW RECORD MODAL ────────────────────────────────────────
function viewRecord(id) {
  const records = getRecords();
  const r = records.find(x => x.id === id);
  if (!r) return;
  viewingRecordId = id;

  const age = calcAgeFromDob(r.dob);
  const content = document.getElementById('modalContent');
  content.innerHTML = `
    <div class="modal-top-row">
      <div>
        ${r.idPhoto
          ? `<img src="${r.idPhoto}" class="modal-id-photo" alt="ID Photo"/>`
          : `<div class="modal-photo-placeholder">👤</div>`}
      </div>
      <div class="modal-top-info">
        <div class="modal-full-name">${r.lastName}, ${r.firstName} ${r.middleName || ''}</div>
        <div class="modal-alias">${r.alias ? 'ALIAS: ' + r.alias : ''}</div>
        <div style="margin-top:8px">
          ${r.sex ? `<span class="tag tag-blue">${r.sex}</span>` : ''}
          ${r.civilStatus ? `<span class="tag tag-blue">${r.civilStatus}</span>` : ''}
          ${r.tribalGroup ? `<span class="tag tag-blue">${r.tribalGroup}</span>` : ''}
        </div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">PART I — PERSONAL DETAILS</div>
      <div class="modal-record-grid">
        <div class="modal-field"><div class="modal-field-label">DATE OF BIRTH</div><div class="modal-field-value">${formatDate(r.dob)}</div></div>
        <div class="modal-field"><div class="modal-field-label">AGE</div><div class="modal-field-value">${age || '—'}</div></div>
        <div class="modal-field"><div class="modal-field-label">SEX</div><div class="modal-field-value">${r.sex || '—'}</div></div>
        <div class="modal-field"><div class="modal-field-label">CIVIL STATUS</div><div class="modal-field-value">${r.civilStatus || '—'}</div></div>
        <div class="modal-field"><div class="modal-field-label">TRIBAL GROUP</div><div class="modal-field-value">${r.tribalGroup || '—'}</div></div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">PART II — HISTORY IN THE MOVEMENT</div>
      <div class="modal-record-grid">
        <div class="modal-field"><div class="modal-field-label">UNIT</div><div class="modal-field-value">${r.unit || '—'}</div></div>
        <div class="modal-field"><div class="modal-field-label">POSITION</div><div class="modal-field-value">${r.position || '—'}</div></div>
        <div class="modal-field"><div class="modal-field-label">MEMBERSHIP TYPE</div><div class="modal-field-value">${r.membershipType || '—'}</div></div>
        <div class="modal-field"><div class="modal-field-label">AREA OF OPERATION</div><div class="modal-field-value">${r.areaOfOperation || '—'}</div></div>
        <div class="modal-field"><div class="modal-field-label">YEARS IN THE MOVEMENT</div><div class="modal-field-value">${r.yearsInMovement || '—'}</div></div>
        <div class="modal-field"><div class="modal-field-label">DATE SURRENDERED</div><div class="modal-field-value">${formatDate(r.dateSurrendered)}</div></div>
        <div class="modal-field"><div class="modal-field-label">REFERRING UNIT</div><div class="modal-field-value">${r.referringUnit || '—'}</div></div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">PART III — REINTEGRATION AND MONITORING</div>
      <div class="modal-field">
        <div class="modal-field-label">ASSISTANCE PROVIDED</div>
        <div class="modal-field-value" style="margin-top:6px">
          ${(r.assistance && r.assistance.length)
            ? r.assistance.map(a => `<span class="tag tag-green">${a}</span>`).join('')
            : '—'}
        </div>
      </div>
      <div class="modal-field" style="margin-top:12px">
        <div class="modal-field-label">VALID IDs</div>
        <div class="valid-id-thumbs">
          ${(r.validIds && r.validIds.length)
            ? r.validIds.map(v => `<img src="${v.dataUrl}" class="valid-id-thumb" title="${v.fileName}" onclick="window.open(this.src)" alt="${v.fileName}"/>`).join('')
            : '<span style="color:var(--text3);font-size:0.78rem">NONE UPLOADED</span>'}
        </div>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">PART IV — SOCIAL CASE PROFILE</div>
      <div class="modal-field">
        <div class="modal-field-label">JAPIC CERTIFICATE</div>
        <div class="modal-field-value" style="margin-top:6px">
          ${r.japic
            ? (r.japic.type === 'pdf'
                ? `<span class="tag tag-blue">📄 ${r.japic.fileName}</span>`
                : `<img src="${r.japic.dataUrl}" style="max-height:80px;border-radius:4px;border:1px solid var(--border);cursor:pointer" onclick="window.open(this.src)" alt="JAPIC"/>`)
            : '<span style="color:var(--text3);font-size:0.78rem">NONE UPLOADED</span>'}
        </div>
      </div>
      <div class="modal-field" style="margin-top:12px">
        <div class="modal-field-label">SOCIAL CASE STUDY REPORT</div>
        <div class="modal-field-value" style="white-space:pre-wrap;line-height:1.7;margin-top:4px">${r.socialCaseReport || '—'}</div>
      </div>
    </div>

    <div style="font-size:0.65rem;color:var(--text3);margin-top:16px;border-top:1px solid var(--border);padding-top:10px">
      RECORD ID: ${r.id} &nbsp;|&nbsp; CREATED BY: ${r.createdBy || '—'} &nbsp;|&nbsp; CREATED: ${r.createdAt ? new Date(r.createdAt).toLocaleString('en-PH') : '—'}
    </div>
  `;
  document.getElementById('viewModal').classList.remove('hidden');
}

function closeModal() { document.getElementById('viewModal').classList.add('hidden'); }
function editFromModal() { closeModal(); editRecord(viewingRecordId); }

// ── DELETE ───────────────────────────────────────────────────
function promptDelete(id) {
  deleteTargetId = id;
  document.getElementById('deleteModal').classList.remove('hidden');
}
function closeDeleteModal() {
  deleteTargetId = null;
  document.getElementById('deleteModal').classList.add('hidden');
}
function confirmDelete() {
  if (!deleteTargetId) return;
  let records = getRecords();
  records = records.filter(r => r.id !== deleteTargetId);
  saveRecords(records);
  closeDeleteModal();
  renderRecords(document.getElementById('searchInput').value);
  showToast('RECORD DELETED', 'error');
}

// ── EXPORT CSV ───────────────────────────────────────────────
function exportCSV() {
  const records = getRecords();
  if (!records.length) { showToast('NO RECORDS TO EXPORT', 'info'); return; }
  const headers = [
    'ID','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS','DATE OF BIRTH','AGE','SEX','CIVIL STATUS','TRIBAL GROUP',
    'UNIT','POSITION','MEMBERSHIP TYPE','AREA OF OPERATION','YEARS IN MOVEMENT','DATE SURRENDERED','REFERRING UNIT',
    'ASSISTANCE PROVIDED','SOCIAL CASE REPORT','CREATED BY','CREATED AT'
  ];
  const rows = records.map(r => [
    r.id, r.lastName, r.firstName, r.middleName, r.alias, r.dob, calcAgeFromDob(r.dob),
    r.sex, r.civilStatus, r.tribalGroup,
    r.unit, r.position, r.membershipType, r.areaOfOperation, r.yearsInMovement, r.dateSurrendered, r.referringUnit,
    (r.assistance || []).join('; '), r.socialCaseReport,
    r.createdBy, r.createdAt ? new Date(r.createdAt).toLocaleString('en-PH') : ''
  ].map(v => '"' + String(v || '').replace(/"/g, '""') + '"'));

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'FR_DATABASE_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV EXPORTED SUCCESSFULLY', 'success');
}

// ── USER MANAGEMENT ──────────────────────────────────────────
let editingUserId = null;

function renderUsers() {
  const users = getUsers();
  const operators = users.filter(u => u.role === 'OPERATOR');
  document.getElementById('operatorCount').textContent = operators.length;

  const list = document.getElementById('usersList');
  list.innerHTML = users.map(u => `
    <div class="user-card">
      <div class="user-card-info">
        <div class="user-card-name">${u.username}</div>
        <div class="user-card-role ${u.role === 'ADMIN' ? 'role-admin' : 'role-operator'}">${u.role}</div>
      </div>
      <div class="user-card-actions">
        ${u.role !== 'ADMIN' ? `
          <button class="btn-edit" onclick="startEditUser('${u.id}')">✏</button>
          <button class="btn-del" onclick="deleteUser('${u.id}')">🗑</button>
        ` : '<span style="font-size:0.65rem;color:var(--text3)">PROTECTED</span>'}
      </div>
    </div>
  `).join('');

  // Disable add if 5 operators already
  const addBtn = document.querySelector('.users-form-panel .btn-primary');
  if (addBtn && !editingUserId) {
    addBtn.disabled = operators.length >= 5;
    addBtn.title = operators.length >= 5 ? 'MAXIMUM 5 OPERATORS REACHED' : '';
  }
}

function startEditUser(id) {
  const users = getUsers();
  const u = users.find(x => x.id === id);
  if (!u) return;
  editingUserId = id;
  document.getElementById('userFormTitle').textContent = 'EDIT OPERATOR';
  document.getElementById('newUsername').value = u.username;
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmPassword').value = '';
  document.getElementById('userFormError').textContent = '';
}

function cancelUserEdit() {
  editingUserId = null;
  document.getElementById('userFormTitle').textContent = 'ADD OPERATOR';
  document.getElementById('newUsername').value = '';
  document.getElementById('newPassword').value = '';
  document.getElementById('confirmPassword').value = '';
  document.getElementById('userFormError').textContent = '';
}

function saveUser() {
  const username = document.getElementById('newUsername').value.trim().toUpperCase();
  const password = document.getElementById('newPassword').value;
  const confirm  = document.getElementById('confirmPassword').value;
  const errEl    = document.getElementById('userFormError');

  if (!username) { errEl.textContent = 'USERNAME IS REQUIRED.'; return; }
  if (!editingUserId && !password) { errEl.textContent = 'PASSWORD IS REQUIRED.'; return; }
  if (password && password !== confirm) { errEl.textContent = 'PASSWORDS DO NOT MATCH.'; return; }
  if (password && password.length < 6) { errEl.textContent = 'PASSWORD MUST BE AT LEAST 6 CHARACTERS.'; return; }

  let users = getUsers();
  const duplicate = users.find(u => u.username.toUpperCase() === username && u.id !== editingUserId);
  if (duplicate) { errEl.textContent = 'USERNAME ALREADY EXISTS.'; return; }

  if (editingUserId) {
    const idx = users.findIndex(u => u.id === editingUserId);
    if (idx !== -1) {
      users[idx].username = username;
      if (password) users[idx].password = password;
    }
    showToast('USER UPDATED', 'success');
  } else {
    const operators = users.filter(u => u.role === 'OPERATOR');
    if (operators.length >= 5) { errEl.textContent = 'MAXIMUM 5 OPERATORS ALLOWED.'; return; }
    users.push({ id: genId(), username, password, role: 'OPERATOR' });
    showToast('OPERATOR ADDED', 'success');
  }

  saveUsers(users);
  cancelUserEdit();
  renderUsers();
}

function deleteUser(id) {
  if (!confirm('DELETE THIS OPERATOR?')) return;
  let users = getUsers();
  users = users.filter(u => u.id !== id);
  saveUsers(users);
  renderUsers();
  showToast('OPERATOR REMOVED', 'error');
}

// ── CLOSE MODALS ON OVERLAY CLICK ───────────────────────────
document.getElementById('viewModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});
document.getElementById('deleteModal').addEventListener('click', function(e) {
  if (e.target === this) closeDeleteModal();
});
