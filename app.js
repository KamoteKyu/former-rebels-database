/* ============================================================
   FORMER REBELS DATABASE MANAGEMENT SYSTEM - app.js
   Storage: Firebase Firestore (records) + Firebase Auth (users)
            + Firebase Storage (files/photos)
   ============================================================ */

// -- FIREBASE INIT --------------------------------------------
const firebaseConfig = {
  apiKey:            "AIzaSyDhSUlOvASS_EpLAgd2RohLpn3SGIVah_I",
  authDomain:        "ocmfrdb.firebaseapp.com",
  projectId:         "ocmfrdb",
  storageBucket:     "ocmfrdb.appspot.com",
  messagingSenderId: "258793038522",
  appId:             "1:258793038522:web:9475314bf86db934191883"
};
firebase.initializeApp(firebaseConfig);
const auth    = firebase.auth();
const db      = firebase.firestore();
const storage = firebase.storage();

// -- FIRESTORE HELPERS ----------------------------------------
// Returns a promise that resolves only when a user is authenticated
function waitForAuth() {
  return new Promise(function(resolve, reject) {
    var unsubscribe = auth.onAuthStateChanged(function(user) {
      unsubscribe();
      if (user) {
        resolve(user);
      } else {
        reject(new Error('Not authenticated'));
      }
    });
  });
}

function dbGetAll() {
  return waitForAuth().then(function() {
    return db.collection('records')
      .get({ source: 'server' })
      .then(function(snap) {
        var docs = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
        // Always sort alphabetically by lastName then firstName
        docs.sort(function(a, b) {
          var la = (a.lastName  || '').toUpperCase();
          var lb = (b.lastName  || '').toUpperCase();
          var fa = (a.firstName || '').toUpperCase();
          var fb = (b.firstName || '').toUpperCase();
          if (la < lb) return -1; if (la > lb) return 1;
          if (fa < fb) return -1; if (fa > fb) return 1;
          return 0;
        });
        return docs;
      });
  });
}

function dbPut(record) {
  var id = record.id || genId();
  record.id = id;
  var safe = Object.assign({}, record);
  // Only strip if still a massive uncompressed base64 (>800KB)
  if (safe.idPhoto && safe.idPhoto.startsWith('data:') && safe.idPhoto.length > 800000) {
    safe.idPhoto = null;
    showToast('ID PHOTO TOO LARGE — ENABLE FIREBASE STORAGE', 'error');
  }
  // Sanitize nested objects — Firestore rejects undefined values
  safe = sanitizeForFirestore(safe);
  return waitForAuth().then(function() {
    return db.collection('records').doc(id).set(safe);
  });
}

// Recursively remove undefined values and replace with null
// Also strip any field containing raw base64 data (too large for Firestore)
function sanitizeForFirestore(obj) {
  if (obj === undefined || obj === null) return null;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(function(item) { return sanitizeForFirestore(item); });
  }
  var clean = {};
  Object.keys(obj).forEach(function(key) {
    var val = obj[key];
    // Strip raw base64 only if extremely large (>700KB = uncompressed)
    // Compressed images (~80KB) are allowed through
    if (typeof val === 'string' && val.startsWith('data:') && val.length > 700000) {
      clean[key] = null;
      return;
    }
    if (key === 'dataUrl') { clean[key] = null; return; }
    clean[key] = sanitizeForFirestore(val === undefined ? null : val);
  });
  return clean;
}

function dbDelete(id) {
  return waitForAuth().then(function() {
    return db.collection('records').doc(id).delete();
  });
}

// -- FIREBASE STORAGE UPLOAD ----------------------------------

// Compress an image dataUrl to max 800px wide, JPEG 65% quality
function compressImage(dataUrl, maxSize) {
  maxSize = maxSize || 800;
  return new Promise(function(resolve) {
    if (!dataUrl || !dataUrl.startsWith('data:image')) { resolve(dataUrl); return; }
    var img = new Image();
    img.onload = function() {
      var w = img.width, h = img.height;
      if (w > maxSize || h > maxSize) {
        if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
        else       { w = Math.round(w * maxSize / h); h = maxSize; }
      }
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.65));
    };
    img.onerror = function() { resolve(dataUrl); };
    img.src = dataUrl;
  });
}

function uploadFile(path, dataUrl, maxSize) {
  if (!dataUrl) return Promise.resolve(null);
  // Already a cloud URL — skip upload
  if (dataUrl.startsWith('https://')) return Promise.resolve(dataUrl);

  // Compress image first — reduces a 3MB photo to ~50-80KB
  return compressImage(dataUrl, maxSize || 800).then(function(compressed) {
    // Try Firebase Storage upload (fast if Storage is enabled)
    return new Promise(function(resolve) {
      var settled = false;
      var timer = setTimeout(function() {
        if (!settled) {
          settled = true;
          // Storage not available — use compressed base64 as fallback
          // compressImage guarantees it's small enough for Firestore
          resolve(compressed || null);
        }
      }, 15000);

      var ref = storage.ref(path);
      ref.putString(compressed, 'data_url')
        .then(function() { return ref.getDownloadURL(); })
        .then(function(url) {
          if (!settled) { settled = true; clearTimeout(timer); resolve(url); }
        })
        .catch(function(err) {
          if (!settled) {
            settled = true; clearTimeout(timer);
            resolve(compressed || null); // fallback to compressed base64
          }
        });
    });
  });
}

function uploadRecordFiles(record) {
  var base = 'records/' + record.id + '/';
  var promises = [];

  // ID Photo — compress harder (2x2 only needs 300px)
  promises.push(
    uploadFile(base + 'idPhoto.jpg', record.idPhoto, 300).then(function(url) {
      record.idPhoto = url;
    })
  );

  // JAPIC
  if (record.japic) {
    var japicSrc = record.japic.dataUrl || (record.japic.url && record.japic.url.startsWith('data:') ? record.japic.url : null);
    if (japicSrc) {
      promises.push(
        uploadFile(base + 'japic/' + (record.japic.fileName || 'japic'), japicSrc).then(function(url) {
          record.japic = { fileName: record.japic.fileName || null, url: url, type: record.japic.type || null };
        })
      );
    } else {
      // Already a clean object with cloud URL — ensure no dataUrl field
      record.japic = { fileName: record.japic.fileName || null, url: record.japic.url || null, type: record.japic.type || null };
    }
  }

  // Social Case Report
  if (record.socialCaseReport) {
    var scSrc = record.socialCaseReport.dataUrl || (record.socialCaseReport.url && record.socialCaseReport.url.startsWith('data:') ? record.socialCaseReport.url : null);
    if (scSrc) {
      promises.push(
        uploadFile(base + 'socialCase/' + (record.socialCaseReport.fileName || 'report'), scSrc).then(function(url) {
          record.socialCaseReport = { fileName: record.socialCaseReport.fileName || null, url: url, type: record.socialCaseReport.type || null };
        })
      );
    } else {
      record.socialCaseReport = { fileName: record.socialCaseReport.fileName || null, url: record.socialCaseReport.url || null, type: record.socialCaseReport.type || null };
    }
  }

  // Valid IDs
  var validIdPromises = (record.validIds || []).map(function(v, i) {
    var src = v.dataUrl || (v.url && v.url.startsWith('data:') ? v.url : null);
    if (!src) {
      record.validIds[i] = { fileName: v.fileName || null, url: v.url || null };
      return Promise.resolve();
    }
    return uploadFile(base + 'validIds/' + i + '_' + (v.fileName || 'id'), src).then(function(url) {
      record.validIds[i] = { fileName: v.fileName || null, url: url };
    });
  });
  promises = promises.concat(validIdPromises);

  return Promise.all(promises).then(function() { return record; });
}

// -- USER ROLES (Firestore) -----------------------------------
function getUserRole(uid) {
  return db.collection('users').doc(uid).get().then(function(doc) {
    return doc.exists ? doc.data() : null;
  });
}

function getUsers() {
  return db.collection('users').get().then(function(snap) {
    return snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
  });
}

// -- STATE ----------------------------------------------------
var currentUser     = null;
var currentPage     = 'dashboard';
var editingRecordId = null;
var deleteTargetId  = null;
var viewingRecordId = null;
var validIdSlots    = [];
var idPhotoData     = null;
var japicData       = null;
var socialCaseData  = null;
var allRecordsCache = [];

// -- HELPERS --------------------------------------------------
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }

var TRIBAL_GROUP_TYPES = [
  'IRAYA','ALANGAN','TADYAWAN','TAU-BUID','BANGON','BUHID','HANUNUO','RATAGNON','OTHERS','NO TRIBAL GROUP'
];
var SECTOR_IDS = ['sec_farmer','sec_women','sec_pwd','sec_youth','sec_senior','sec_solo_parent','sec_ip','sec_urban_poor','sec_others'];

function normalizeTribalGroup(val) {
  if (!val) return '';
  if (val === 'MANGYAN') return 'OTHERS';
  if (val === 'TAU-BUHID') return 'TAU-BUID';
  return TRIBAL_GROUP_TYPES.indexOf(val) !== -1 ? val : '';
}

function showToast(msg, type) {
  type = type || 'success';
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(function() { t.classList.add('hidden'); }, 3500);
}

// -- CHIME SOUND (Web Audio API) ------------------------------
function playChime() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Three ascending notes: C5 → E5 → G5
    var notes = [523.25, 659.25, 783.99];
    notes.forEach(function(freq, i) {
      var osc   = ctx.createOscillator();
      var gain  = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      var start = ctx.currentTime + i * 0.18;
      var end   = start + 0.35;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, end);
      osc.start(start);
      osc.stop(end);
    });
  } catch(e) {
    // Audio not available — silent fail
  }
}

function calcAge() {
  var dob = document.getElementById('dob').value;
  if (!dob) { document.getElementById('age').value = ''; syncSeniorCitizenSector(); return; }
  var today = new Date(), birth = new Date(dob);
  var age = today.getFullYear() - birth.getFullYear();
  var m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  document.getElementById('age').value = age >= 0 ? age : '';
  syncSeniorCitizenSector();
}

function calcAgeFromDob(dob) {
  if (!dob) return '';
  var today = new Date(), birth = new Date(dob);
  var age = today.getFullYear() - birth.getFullYear();
  var m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age >= 0 ? age : '';
}

function syncSeniorCitizenSector() {
  var ageVal = document.getElementById('age').value;
  var seniorCb = document.getElementById('sec_senior');
  if (ageVal === '') { seniorCb.checked = false; return; }
  var age = parseInt(ageVal, 10);
  seniorCb.checked = !isNaN(age) && age >= 60;
}

function syncWomenSector() {
  var sex = document.getElementById('sex').value;
  document.getElementById('sec_women').checked = (sex === 'FEMALE');
}

function formatDate(d) {
  if (!d) return '-';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });
}

function togglePw() {
  var inp = document.getElementById('loginPass');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

// -- LOGIN / LOGOUT (Firebase Auth) ---------------------------
function doLogin() {
  var u   = document.getElementById('loginUser').value.trim();
  var p   = document.getElementById('loginPass').value;
  var err = document.getElementById('loginError');
  if (!u || !p) { err.textContent = 'PLEASE ENTER EMAIL AND PASSWORD.'; return; }
  var email = u.indexOf('@') === -1 ? u.toLowerCase() + '@frdb.local' : u.toLowerCase();
  err.textContent = 'SIGNING IN...';
  auth.signInWithEmailAndPassword(email, p)
    .then(function(cred) {
      err.textContent = '';
      // Determine role by email — only admin@frdb.local is ADMIN
      var role = cred.user.email === 'admin@frdb.local' ? 'ADMIN' : 'OPERATOR';
      currentUser = {
        uid:      cred.user.uid,
        email:    cred.user.email,
        username: u.toUpperCase(),
        role:     role
      };
      onLoginSuccess();
    })
    .catch(function(e) {
      if (e.code === 'auth/user-not-found' || e.code === 'auth/wrong-password' ||
          e.code === 'auth/invalid-credential' || e.code === 'auth/invalid-email') {
        err.textContent = 'INVALID USERNAME OR PASSWORD.';
      } else {
        err.textContent = 'LOGIN ERROR: ' + e.message;
      }
    });
}

function onLoginSuccess() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');
  document.getElementById('sidebarUsername').textContent = currentUser.username;
  document.getElementById('sidebarRole').textContent     = currentUser.role;
  document.getElementById('topbarUser').textContent      = currentUser.username + ' (' + currentUser.role + ')';
  document.querySelectorAll('.admin-only').forEach(function(el) {
    el.style.display = currentUser.role === 'ADMIN' ? 'flex' : 'none';
  });
  startClock();
  resetIdleTimer(); // start idle logout timer
  // Small delay ensures Firestore receives the auth token before first read
  setTimeout(function() { showPage('dashboard'); }, 800);
}

function doLogout() {
  clearTimeout(idleTimer);
  auth.signOut().then(function() {
    currentUser = null;
    allRecordsCache = [];
    document.getElementById('mainApp').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('loginUser').value = '';
    document.getElementById('loginPass').value = '';
    document.getElementById('loginError').textContent = '';
    stopClock();
  });
}

document.getElementById('loginPass').addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });
document.getElementById('loginUser').addEventListener('keydown', function(e) { if (e.key === 'Enter') document.getElementById('loginPass').focus(); });

// -- CLOCK ----------------------------------------------------
var clockInterval = null;
function startClock() { updateClock(); clockInterval = setInterval(updateClock, 1000); }
function stopClock()  { clearInterval(clockInterval); }
function updateClock() {
  var now = new Date();
  document.getElementById('currentDateTime').textContent =
    now.toLocaleDateString('en-PH', { weekday:'short', year:'numeric', month:'short', day:'numeric' }) +
    '  ' + now.toLocaleTimeString('en-PH');
}

// -- NAVIGATION -----------------------------------------------
function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  var titles = { dashboard:'DASHBOARD', records:'RECORDS', addRecord: editingRecordId ? 'EDIT RECORD' : 'ADD NEW RECORD', users:'USER MANAGEMENT' };
  document.getElementById('pageTitle').textContent = titles[page] || page.toUpperCase();
  document.getElementById('page-' + page).classList.add('active');
  var navMap = { dashboard:0, records:1, addRecord:2, users:3 };
  var navItems = document.querySelectorAll('.nav-item');
  if (navMap[page] !== undefined) navItems[navMap[page]].classList.add('active');
  if (page === 'dashboard') {
    updateStorageBar();
    dbGetAll().then(function(records) { allRecordsCache = records; renderDashboard(records); })
      .catch(function(err) {
        console.error('[FRDB] dbGetAll error:', err.code, err.message);
        if (err.code === 'permission-denied') {
          showToast('FIRESTORE RULES BLOCKING READ — SET: allow read, write: if true', 'error');
        } else if (err.message === 'Not authenticated') {
          showToast('NOT LOGGED IN', 'error');
        } else {
          showToast('ERROR LOADING DATA: ' + err.message, 'error');
        }
      });
  }
  if (page === 'records') {
    document.getElementById('recordsTableBody').innerHTML =
      '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--text3)">LOADING...</td></tr>';
    dbGetAll().then(function(records) { allRecordsCache = records; renderRecords(records); })
      .catch(function(err) {
        console.error('[FRDB] dbGetAll error:', err.code, err.message);
        if (err.code === 'permission-denied') {
          showToast('FIRESTORE RULES BLOCKING READ — SET: allow read, write: if true', 'error');
        } else {
          showToast('ERROR LOADING DATA: ' + err.message, 'error');
        }
      });
  }
  if (page === 'addRecord' && !editingRecordId) { resetForm(); document.getElementById('formTitle').textContent = 'ADD NEW RECORD'; }
  if (page === 'users') {
    if (!currentUser || currentUser.role !== 'ADMIN') {
      showToast('ACCESS DENIED — ADMIN ONLY', 'error');
      showPage('dashboard');
      return;
    }
    renderUsers();
  }
  if (window.innerWidth <= 900) document.getElementById('sidebar').classList.remove('open');
}

function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }

// -- DASHBOARD ------------------------------------------------
function renderDashboard(records) {
  var banner = document.getElementById('recoveryBanner');
  if (banner) banner.style.display = 'none';
  document.getElementById('statTotal').textContent      = records.length;
  document.getElementById('statMale').textContent       = records.filter(function(r) { return r.sex === 'MALE'; }).length;
  document.getElementById('statFemale').textContent     = records.filter(function(r) { return r.sex === 'FEMALE'; }).length;
  document.getElementById('statRegularNPA').textContent = records.filter(function(r) { return r.membershipType === 'REGULAR NPA'; }).length;
  document.getElementById('statMilisyang').textContent  = records.filter(function(r) { return r.membershipType === 'MILISYANG BAYAN'; }).length;
  renderAssistanceReport(records);
  renderMembershipReport(records);
  renderTribalReport(records);
  renderAgeReport(records);
  renderMunicipalityReport(records);
  render4PsReport(records);
  renderSectorReport(records);
  renderReferringUnitReport(records);
  renderSurrenderByYearReport(records);
}

// -- STORAGE BAR ----------------------------------------------
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  var k = 1024, sizes = ['B','KB','MB','GB'];
  var i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function updateStorageBar() {
  var fill = document.getElementById('storageBarFill');
  var label = document.getElementById('storageUsedLabel');
  var usedEl = document.getElementById('storageUsedBytes');
  var availEl = document.getElementById('storageAvailBytes');
  var warnEl = document.getElementById('storageWarning');
  // Firebase Storage — show record count as proxy, no quota API
  label.textContent = 'CLOUD STORAGE (FIREBASE)';
  fill.style.width = '0%';
  usedEl.textContent = 'RECORDS IN CLOUD: ' + allRecordsCache.length;
  availEl.textContent = 'UNLIMITED (FIREBASE)';
  warnEl.style.display = 'none';
}

// -- SURRENDER BY YEAR REPORT ---------------------------------
function renderSurrenderByYearReport(records) {
  var START_YEAR = 2016, thisYear = new Date().getFullYear(), years = [];
  for (var y = START_YEAR; y <= thisYear; y++) years.push(y);
  var COLORS = ['#388bfd','#3fb950','#d29922','#f85149','#a371f7','#39d353','#58a6ff','#79c0ff','#ffa657','#ff7b72','#56d364'];
  var total = records.length, counts = {}, noDate = 0;
  years.forEach(function(y) { counts[y] = 0; });
  records.forEach(function(r) {
    if (!r.dateSurrendered) { noDate++; return; }
    var y = new Date(r.dateSurrendered).getFullYear();
    if (counts[y] !== undefined) counts[y]++; else counts[y] = 1;
  });
  var withDate = total - noDate;
  var maxCount = Math.max.apply(null, years.map(function(y) { return counts[y]; }).concat([1]));
  document.getElementById('surrenderYearTotalBadge').textContent = withDate + ' WITH DATE';
  document.getElementById('surrenderYearBars').innerHTML = years.map(function(y, i) {
    var count = counts[y], barPx = Math.max(Math.round((count / maxCount) * 110), count > 0 ? 4 : 0);
    var color = COLORS[i % COLORS.length];
    return '<div class="asst-bar-group"><div class="asst-bar-wrap"><div class="asst-bar-count">' + count + '</div>' +
      '<div class="asst-bar" style="height:' + barPx + 'px;background:linear-gradient(180deg,' + color + ' 0%,' + color + '99 100%)" title="' + y + ': ' + count + '"></div></div>' +
      '<div class="asst-bar-label">' + y + '</div></div>';
  }).join('');
  document.getElementById('surrenderYearTableBody').innerHTML = years.map(function(y, i) {
    var count = counts[y], pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
    var barW = total > 0 ? Math.round((count / total) * 100) : 0, color = COLORS[i % COLORS.length];
    return '<tr class="' + (count === 0 ? 'asst-zero' : '') + '">' +
      '<td><span class="donut-dot" style="background:' + color + ';display:inline-block;margin-right:6px"></span>' + y + '</td>' +
      '<td style="text-align:center;font-weight:' + (count > 0 ? '700' : '400') + ';color:' + (count > 0 ? color : 'var(--text3)') + '">' + count + '</td>' +
      '<td style="text-align:center">' + pct + '%</td>' +
      '<td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:' + barW + '%;background:' + color + '"></div></div></td></tr>';
  }).join('');
  document.getElementById('surrenderYearTableFoot').innerHTML =
    '<tr class="asst-tfoot-row"><td>NO DATE RECORDED</td><td style="text-align:center">' + noDate + '</td>' +
    '<td style="text-align:center">' + (total > 0 ? ((noDate / total) * 100).toFixed(1) : '0.0') + '%</td><td></td></tr>';
}

// -- REPORT HELPERS -------------------------------------------
var PRINT_RECORD_STYLES =
  'body{font-family:Segoe UI,Arial,sans-serif;color:#111;margin:0;padding:24px;font-size:12px}' +
  '.print-header{text-align:center;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid #111}' +
  '.print-header h1{font-size:16px;margin:0 0 4px;letter-spacing:2px}' +
  '.print-header p{margin:4px 0;font-size:11px;color:#444}' +
  '.modal-record-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
  '.modal-section{margin-bottom:16px;page-break-inside:avoid}' +
  '.modal-section-title{font-size:10px;letter-spacing:1.5px;color:#333;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #ccc;font-weight:700}' +
  '.modal-field-label{font-size:9px;letter-spacing:1px;color:#666;text-transform:uppercase}' +
  '.modal-field-value{font-size:12px;margin-top:2px}' +
  '.modal-top-row{display:flex;gap:16px;margin-bottom:16px}' +
  '.modal-id-photo{width:90px;height:90px;object-fit:cover;border:1px solid #999}' +
  '.modal-photo-placeholder{width:90px;height:90px;border:1px solid #999;display:flex;align-items:center;justify-content:center;font-size:28px}' +
  '.modal-full-name{font-size:15px;font-weight:700}' +
  '.modal-alias{font-size:11px;color:#444}' +
  '.tag{display:inline-block;padding:2px 6px;border-radius:10px;font-size:9px;margin:2px;border:1px solid #999;background:#f0f0f0;color:#111}' +
  '.valid-id-thumbs{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}' +
  '.valid-id-thumb{width:70px;height:52px;object-fit:cover;border:1px solid #999}' +
  '.japic-print-img{max-height:70px;border:1px solid #999}' +
  '.empty-upload{color:#666;font-size:11px}' +
  '.on-file-badge{display:inline-block;background:#e6f4ea;color:#1a7f37;border:1px solid #a8d5b5;border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700;letter-spacing:.5px;margin:2px}' +
  '.record-meta{font-size:9px;color:#666;margin-top:16px;padding-top:8px;border-top:1px solid #ccc}' +
  '@media print{body{padding:12px}' +
  '@page{margin:10mm 10mm 18mm 10mm;size:A4;}' +
  '@page{@bottom-center{content:"PSWDO2026";font-family:Arial,sans-serif;font-size:9pt;color:#555;letter-spacing:2px;}}' +
  '}';

var REPORT_PRINT_STYLES = PRINT_RECORD_STYLES +
  '.report-section{margin-top:20px;page-break-inside:avoid}' +
  '.report-section h2{font-size:12px;letter-spacing:1.5px;margin:0 0 8px;border-bottom:1px solid #999;padding-bottom:4px}' +
  '.report-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0}' +
  '.report-stat{border:1px solid #ccc;padding:8px;text-align:center}' +
  '.report-stat strong{display:block;font-size:16px}' +
  '.report-stat span{font-size:9px;color:#555}' +
  '.report-table{width:100%;border-collapse:collapse;font-size:11px;margin-top:8px}' +
  '.report-table th,.report-table td{border:1px solid #ccc;padding:6px 8px;text-align:left}' +
  '.report-table th{background:#f0f0f0;font-size:9px;letter-spacing:1px}' +
  '.report-table td.num{text-align:center}';

var CONFIDENTIAL_WATERMARK_STYLE =
  '.confidential-watermark{' +
    'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);' +
    'font-size:72px;font-weight:900;color:rgba(220,0,0,0.12);' +
    'letter-spacing:8px;white-space:nowrap;pointer-events:none;z-index:9999;' +
    'font-family:Arial,sans-serif;user-select:none;' +
  '}' +
  '@media print{' +
    '.confidential-watermark{' +
      'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);' +
      'font-size:80px;font-weight:900;color:rgba(220,0,0,0.15);' +
      'letter-spacing:8px;white-space:nowrap;z-index:9999;' +
      '-webkit-print-color-adjust:exact;print-color-adjust:exact;' +
    '}' +
  '}';

function buildReportTable(headers, rows) {
  return '<table class="report-table"><thead><tr>' +
    headers.map(function(h) { return '<th>' + h + '</th>'; }).join('') +
    '</tr></thead><tbody>' +
    rows.map(function(cells) {
      return '<tr>' + cells.map(function(c, i) { return '<td' + (i > 0 ? ' class="num"' : '') + '>' + c + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table>';
}

function openPrintDocument(title, bodyHtml, extraStyles) {
  var styles = (extraStyles || PRINT_RECORD_STYLES) + CONFIDENTIAL_WATERMARK_STYLE;
  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title></title><style>' + styles + '</style></head><body><div class="confidential-watermark">CONFIDENTIAL</div>' + bodyHtml + '</body></html>';
  var w = window.open('', '_blank');
  if (!w) { showToast('ALLOW POPUPS TO PRINT', 'error'); return null; }
  w.document.open(); w.document.write(html); w.document.close(); w.focus();
  setTimeout(function() { w.print(); }, 350);
  return w;
}

function generateReport() {
  function run(records) {
    if (!records.length) { showToast('NO RECORDS FOR REPORT', 'info'); return; }
    var printed = new Date().toLocaleString('en-PH');
    var generatedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';
    var body = '<div class="print-header"><h1>FORMER REBELS DATABASE MANAGEMENT SYSTEM</h1><p>DASHBOARD SUMMARY REPORT</p><p>Generated: ' + printed + '</p><p>Generated by: ' + generatedBy + '</p></div>' +
      buildDashboardReportHtml(records);
    openPrintDocument('FR Dashboard Report', body, REPORT_PRINT_STYLES);
    showToast('REPORT GENERATED', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- DASHBOARD REPORT HTML ------------------------------------
function buildDashboardReportHtml(records) {
  var total = records.length;
  var male = 0, female = 0, regularNpa = 0, milisyang = 0;
  records.forEach(function(r) {
    if (r.sex === 'MALE') male++;
    if (r.sex === 'FEMALE') female++;
    if (r.membershipType === 'REGULAR NPA') regularNpa++;
    if (r.membershipType === 'MILISYANG BAYAN') milisyang++;
  });

  // ASSISTANCE
  var ASST_TYPES = ['E-CLIP','FEA REMUNERATION','LIVELIHOOD','MEDICAL','EDUCATIONAL','ISSUANCE OF CREDENTIALS','PHILHEALTH','ISSUANCE OF SAFE CONDUCT PASS','APPLIED FOR AMNESTY','OTHERS'];
  var asstCounts = {}; ASST_TYPES.forEach(function(t){asstCounts[t]=0;});
  records.forEach(function(r){(r.assistance||[]).forEach(function(a){var k=a.indexOf('OTHERS')===0?'OTHERS':a;if(asstCounts[k]!==undefined)asstCounts[k]++;});});
  var asstRows = ASST_TYPES.map(function(t){var c=asstCounts[t];return[t,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];});
  asstRows.push(['TOTAL ASSISTANCE RENDERED', ASST_TYPES.reduce(function(s,t){return s+asstCounts[t];},0), '-']);

  // MEMBERSHIP
  var MEM_TYPES = ['REGULAR NPA','MILISYANG BAYAN'];
  var memCounts = {}; MEM_TYPES.forEach(function(t){memCounts[t]=0;});
  records.forEach(function(r){if(r.membershipType&&memCounts[r.membershipType]!==undefined)memCounts[r.membershipType]++;});
  var withMem = MEM_TYPES.reduce(function(s,t){return s+memCounts[t];},0);
  var memRows = MEM_TYPES.map(function(t){var c=memCounts[t];return[t,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];});
  memRows.push(['NOT SPECIFIED',total-withMem,total>0?(((total-withMem)/total)*100).toFixed(1)+'%':'0.0%']);

  // TRIBAL GROUP
  var tribalCounts = {}; TRIBAL_GROUP_TYPES.forEach(function(t){tribalCounts[t]=0;});
  records.forEach(function(r){var k=normalizeTribalGroup(r.tribalGroup);if(k&&tribalCounts[k]!==undefined)tribalCounts[k]++;});
  var withTribal = TRIBAL_GROUP_TYPES.reduce(function(s,t){return s+tribalCounts[t];},0);
  var tribalRows = TRIBAL_GROUP_TYPES.map(function(t){var c=tribalCounts[t];return[t,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];});
  tribalRows.push(['NOT SPECIFIED',total-withTribal,total>0?(((total-withTribal)/total)*100).toFixed(1)+'%':'0.0%']);

  // AGE BRACKET
  var BRACKETS=[{label:'18 & BELOW',min:0,max:18},{label:'19 - 24',min:19,max:24},{label:'25 - 30',min:25,max:30},{label:'31 - 40',min:31,max:40},{label:'41 - 59',min:41,max:59},{label:'60 & ABOVE',min:60,max:999}];
  var ageCounts=BRACKETS.map(function(){return 0;}); var withAge=0;
  records.forEach(function(r){var age=parseInt(calcAgeFromDob(r.dob));if(isNaN(age))return;withAge++;for(var i=0;i<BRACKETS.length;i++){if(age>=BRACKETS[i].min&&age<=BRACKETS[i].max){ageCounts[i]++;break;}}});
  var ageRows=BRACKETS.map(function(b,i){var c=ageCounts[i];return[b.label,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];});
  ageRows.push(['TOTAL WITH AGE DATA',withAge,'-']);

  // MUNICIPALITY
  var OCC = MUNICIPALITIES_BY_PROVINCE['OCCIDENTAL MINDORO'];
  var ORI = MUNICIPALITIES_BY_PROVINCE['ORIENTAL MINDORO'];
  var ALL_MUN = OCC.concat(ORI);
  var munCounts={}; ALL_MUN.forEach(function(m){munCounts[m]=0;}); var noMun=0, outsideMindoro=0;
  records.forEach(function(r){if(r.addressProvince==='OUTSIDE MINDORO'){outsideMindoro++;return;}var m=r.addressMunicipality||'';if(m&&munCounts[m]!==undefined)munCounts[m]++;else noMun++;});
  var munRows=ALL_MUN.map(function(m){var c=munCounts[m];return[m,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];});
  munRows.push(['OUTSIDE MINDORO',outsideMindoro,total>0?((outsideMindoro/total)*100).toFixed(1)+'%':'0.0%']);
  munRows.push(['NOT SPECIFIED',noMun,total>0?((noMun/total)*100).toFixed(1)+'%':'0.0%']);

  // 4Ps
  var fourPsYes=records.filter(function(r){return r.fourPs==='YES';}).length;
  var fourPsNo=records.filter(function(r){return r.fourPs==='NO';}).length;
  var fourPsNoData=total-fourPsYes-fourPsNo;
  var fourPsRows=[['YES',fourPsYes,total>0?((fourPsYes/total)*100).toFixed(1)+'%':'0.0%'],['NO',fourPsNo,total>0?((fourPsNo/total)*100).toFixed(1)+'%':'0.0%'],['NOT SPECIFIED',fourPsNoData,total>0?((fourPsNoData/total)*100).toFixed(1)+'%':'0.0%']];

  // SECTOR
  var SECTORS=['FARMER/FISHERFOLK','WOMEN','PWD','CHILDREN AND YOUTH','SENIOR CITIZEN','SOLO PARENT','INDIGENOUS PEOPLE','URBAN POOR','OTHERS'];
  var secCounts={}; SECTORS.forEach(function(s){secCounts[s]=0;});
  records.forEach(function(r){(r.sector||[]).forEach(function(s){var k=s.indexOf('OTHERS')===0?'OTHERS':s;if(secCounts[k]!==undefined)secCounts[k]++;});});
  var withSec=records.filter(function(r){return r.sector&&r.sector.length>0;}).length;
  var secRows=SECTORS.map(function(s){var c=secCounts[s];return[s,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];});
  secRows.push(['NO SECTOR SPECIFIED',total-withSec,total>0?(((total-withSec)/total)*100).toFixed(1)+'%':'0.0%']);

  // REFERRING UNIT
  var UNITS=['102nd SAC','1st Infantry "Always First" Battalion','1st OMPMFC','203rd Infantry "Bantay Kapayapaan" Brigade','23MICO','2CMO Battalion','2nd OMPMFC','402nd B MC RMFB 4B','405th B MC RMFB 4B','4th Infantry "Scorpion" Battalion','68th Infantry "Kaagapay" Battalion','76th Infantry "Victrix" Battalion','ISAFP','PIT Occidental Mindoro RIU 4B','OTHERS'];
  var unitCounts={}; UNITS.forEach(function(u){unitCounts[u]=0;}); var noUnit=0;
  records.forEach(function(r){var u=r.referringUnit||'';if(!u){noUnit++;return;}var k=u.indexOf('OTHERS')===0?'OTHERS':u;if(unitCounts[k]!==undefined)unitCounts[k]++;else noUnit++;});
  var unitRows=UNITS.map(function(u){var c=unitCounts[u];return[u,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];});
  unitRows.push(['NOT SPECIFIED',noUnit,total>0?((noUnit/total)*100).toFixed(1)+'%':'0.0%']);

  // SURRENDER BY YEAR
  var START_YEAR=2016, curYear=new Date().getFullYear();
  var yrRows=[], noDate=0;
  for(var y=START_YEAR;y<=curYear;y++){var c=records.filter(function(r){return r.dateSurrendered&&new Date(r.dateSurrendered).getFullYear()===y;}).length;yrRows.push([String(y),c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%']);}
  noDate=records.filter(function(r){return !r.dateSurrendered;}).length;
  yrRows.push(['NO DATE RECORDED',noDate,total>0?((noDate/total)*100).toFixed(1)+'%':'0.0%']);

  return (
    '<div class="report-section"><h2>SUMMARY STATISTICS</h2><div class="report-stats">' +
      '<div class="report-stat"><strong>'+total+'</strong><span>TOTAL RECORDS</span></div>' +
      '<div class="report-stat"><strong>'+male+'</strong><span>MALE</span></div>' +
      '<div class="report-stat"><strong>'+female+'</strong><span>FEMALE</span></div>' +
      '<div class="report-stat"><strong>'+regularNpa+'</strong><span>REGULAR NPA</span></div>' +
      '<div class="report-stat"><strong>'+milisyang+'</strong><span>MILISYANG BAYAN</span></div>' +
    '</div></div>' +
    '<div class="report-section"><h2>ASSISTANCE PROVIDED</h2>' + buildReportTable(['TYPE OF ASSISTANCE','COUNT','% OF TOTAL'], asstRows) + '</div>' +
    '<div class="report-section"><h2>SURRENDER BY YEAR ('+START_YEAR+'–'+curYear+')</h2>' + buildReportTable(['YEAR','COUNT','% OF TOTAL'], yrRows) + '</div>' +
    '<div class="report-section"><h2>MEMBERSHIP TYPE</h2>' + buildReportTable(['TYPE','COUNT','% OF TOTAL'], memRows) + '</div>' +
    '<div class="report-section"><h2>TRIBAL GROUP</h2>' + buildReportTable(['TRIBAL GROUP','COUNT','% OF TOTAL'], tribalRows) + '</div>' +
    '<div class="report-section"><h2>AGE BRACKET</h2>' + buildReportTable(['AGE BRACKET','COUNT','% OF TOTAL'], ageRows) + '</div>' +
    '<div class="report-section"><h2>MUNICIPALITY BREAKDOWN</h2>' + buildReportTable(['MUNICIPALITY','COUNT','% OF TOTAL'], munRows) + '</div>' +
    '<div class="report-section"><h2>4Ps BENEFICIARIES</h2>' + buildReportTable(['STATUS','COUNT','% OF TOTAL'], fourPsRows) + '</div>' +
    '<div class="report-section"><h2>SECTOR BREAKDOWN</h2>' + buildReportTable(['SECTOR','COUNT','% OF TOTAL'], secRows) + '</div>' +
    '<div class="report-section"><h2>REFERRING UNIT</h2>' + buildReportTable(['REFERRING UNIT','COUNT','% OF TOTAL'], unitRows) + '</div>'
  );
}

// -- ASSISTANCE REPORT ----------------------------------------
function renderAssistanceReport(records) {
  var ASST_TYPES = ['E-CLIP','FEA REMUNERATION','LIVELIHOOD','MEDICAL','EDUCATIONAL','ISSUANCE OF CREDENTIALS','PHILHEALTH','ISSUANCE OF SAFE CONDUCT PASS','APPLIED FOR AMNESTY','OTHERS'];
  var SHORT = {'E-CLIP':'E-CLIP','FEA REMUNERATION':'FEA','LIVELIHOOD':'LIVELIHOOD','MEDICAL':'MEDICAL','EDUCATIONAL':'EDUCATIONAL','ISSUANCE OF CREDENTIALS':'CREDENTIALS','PHILHEALTH':'PHILHEALTH','ISSUANCE OF SAFE CONDUCT PASS':'SAFE CONDUCT','APPLIED FOR AMNESTY':'AMNESTY','OTHERS':'OTHERS'};
  var counts = {}; ASST_TYPES.forEach(function(t){counts[t]=0;});
  records.forEach(function(r){(r.assistance||[]).forEach(function(a){var k=a.indexOf('OTHERS')===0?'OTHERS':a;if(counts[k]!==undefined)counts[k]++;});});
  var total = records.length, maxCount = Math.max.apply(null, ASST_TYPES.map(function(t){return counts[t];}).concat([1]));
  var beneficiaries = records.filter(function(r){return r.assistance&&r.assistance.length>0;}).length;
  document.getElementById('asstTotalBadge').textContent = beneficiaries + ' TOTAL BENEFICIARIES';
  document.getElementById('asstBars').innerHTML = ASST_TYPES.map(function(type){
    var count=counts[type], pct=Math.round((count/maxCount)*100), barPx=Math.max(Math.round((pct/100)*110),count>0?4:0);
    return '<div class="asst-bar-group"><div class="asst-bar-wrap"><div class="asst-bar-count">'+count+'</div><div class="asst-bar" style="height:'+barPx+'px" title="'+type+': '+count+'"></div></div><div class="asst-bar-label">'+SHORT[type]+'</div></div>';
  }).join('');
  document.getElementById('asstTableBody').innerHTML = ASST_TYPES.map(function(type){
    var count=counts[type], pct=total>0?((count/total)*100).toFixed(1):'0.0', barW=total>0?Math.round((count/total)*100):0;
    return '<tr class="'+(count===0?'asst-zero':'')+'"><td>'+type+'</td><td style="text-align:center;font-weight:'+(count>0?'700':'400')+';color:'+(count>0?'var(--accent2)':'var(--text3)')+'">'+count+'</td><td style="text-align:center">'+pct+'%</td><td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:'+barW+'%"></div></div></td></tr>';
  }).join('');
  var totalAsst=ASST_TYPES.reduce(function(a,t){return a+counts[t];},0);
  document.getElementById('asstTableFoot').innerHTML='<tr class="asst-tfoot-row"><td>TOTAL ASSISTANCE RENDERED</td><td style="text-align:center">'+totalAsst+'</td><td style="text-align:center">-</td><td></td></tr>';
}

// -- MEMBERSHIP REPORT ----------------------------------------
function renderMembershipReport(records) {
  var TYPES=['REGULAR NPA','MILISYANG BAYAN'], COLORS={'REGULAR NPA':'#f85149','MILISYANG BAYAN':'#d29922'};
  var counts={}; TYPES.forEach(function(t){counts[t]=0;});
  records.forEach(function(r){if(r.membershipType&&counts[r.membershipType]!==undefined)counts[r.membershipType]++;});
  var total=records.length, withType=TYPES.reduce(function(s,t){return s+counts[t];},0);
  document.getElementById('membershipTotalBadge').textContent=withType+' WITH MEMBERSHIP TYPE';
  var canvas=document.getElementById('membershipDonut'),ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,160,160);
  var cx=80,cy=80,r=60,inner=36,total2=withType||1,startAngle=-Math.PI/2;
  TYPES.forEach(function(type){var slice=(counts[type]/total2)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,startAngle,startAngle+slice);ctx.closePath();ctx.fillStyle=COLORS[type];ctx.fill();startAngle+=slice;});
  ctx.beginPath();ctx.arc(cx,cy,inner,0,2*Math.PI);ctx.fillStyle='#161b22';ctx.fill();
  ctx.fillStyle='#e6edf3';ctx.font='bold 18px Segoe UI,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(withType,cx,cy);
  document.getElementById('donutLegend').innerHTML=TYPES.map(function(t){return '<div class="donut-legend-item"><span class="donut-dot" style="background:'+COLORS[t]+'"></span><span>'+t+'</span><strong>'+counts[t]+'</strong></div>';}).join('');
  document.getElementById('membershipTableBody').innerHTML=TYPES.map(function(type){
    var count=counts[type],pct=total>0?((count/total)*100).toFixed(1):'0.0',barW=total>0?Math.round((count/total)*100):0;
    return '<tr><td><span class="donut-dot" style="background:'+COLORS[type]+';display:inline-block;margin-right:6px"></span>'+type+'</td><td style="text-align:center;font-weight:700;color:'+COLORS[type]+'">'+count+'</td><td style="text-align:center">'+pct+'%</td><td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:'+barW+'%;background:'+COLORS[type]+'"></div></div></td></tr>';
  }).join('')+'<tr style="border-top:2px solid var(--border);background:var(--bg3)"><td style="font-weight:700">NOT SPECIFIED</td><td style="text-align:center;font-weight:700;color:var(--text2)">'+(total-withType)+'</td><td style="text-align:center">'+(total>0?(((total-withType)/total)*100).toFixed(1):'0.0')+'%</td><td></td></tr>';
}

// -- TRIBAL REPORT --------------------------------------------
function renderTribalReport(records) {
  var TYPES=TRIBAL_GROUP_TYPES.slice();
  var COLORS={'IRAYA':'#3fb950','ALANGAN':'#2ea043','TADYAWAN':'#56d364','TAU-BUID':'#26a641','BANGON':'#388bfd','BUHID':'#1f6feb','HANUNUO':'#58a6ff','RATAGNON':'#79c0ff','OTHERS':'#d29922','NO TRIBAL GROUP':'#6e7681'};
  var counts={}; TYPES.forEach(function(t){counts[t]=0;});
  records.forEach(function(r){var k=normalizeTribalGroup(r.tribalGroup);if(k&&counts[k]!==undefined)counts[k]++;});
  var total=records.length, withType=TYPES.reduce(function(s,t){return s+counts[t];},0);
  document.getElementById('tribalTotalBadge').textContent=withType+' WITH TRIBAL GROUP';
  var canvas=document.getElementById('tribalDonut'),ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,160,160);
  var cx=80,cy=80,r=60,inner=36,total2=withType||1,startAngle=-Math.PI/2;
  TYPES.forEach(function(type){var slice=(counts[type]/total2)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,startAngle,startAngle+slice);ctx.closePath();ctx.fillStyle=COLORS[type];ctx.fill();startAngle+=slice;});
  ctx.beginPath();ctx.arc(cx,cy,inner,0,2*Math.PI);ctx.fillStyle='#161b22';ctx.fill();
  ctx.fillStyle='#e6edf3';ctx.font='bold 18px Segoe UI,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(withType,cx,cy);
  document.getElementById('tribalLegend').innerHTML=TYPES.map(function(t){return '<div class="donut-legend-item"><span class="donut-dot" style="background:'+COLORS[t]+'"></span><span>'+t+'</span><strong>'+counts[t]+'</strong></div>';}).join('');
  document.getElementById('tribalTableBody').innerHTML=TYPES.map(function(type){
    var count=counts[type],pct=total>0?((count/total)*100).toFixed(1):'0.0',barW=total>0?Math.round((count/total)*100):0;
    return '<tr><td><span class="donut-dot" style="background:'+COLORS[type]+';display:inline-block;margin-right:6px"></span>'+type+'</td><td style="text-align:center;font-weight:700;color:'+COLORS[type]+'">'+count+'</td><td style="text-align:center">'+pct+'%</td><td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:'+barW+'%;background:'+COLORS[type]+'"></div></div></td></tr>';
  }).join('')+'<tr style="border-top:2px solid var(--border);background:var(--bg3)"><td style="font-weight:700">NOT SPECIFIED</td><td style="text-align:center;font-weight:700;color:var(--text2)">'+(total-withType)+'</td><td style="text-align:center">'+(total>0?(((total-withType)/total)*100).toFixed(1):'0.0')+'%</td><td></td></tr>';
}

// -- AGE REPORT -----------------------------------------------
function renderAgeReport(records) {
  var BRACKETS=[{label:'18 & BELOW',min:0,max:18},{label:'19 - 24',min:19,max:24},{label:'25 - 30',min:25,max:30},{label:'31 - 40',min:31,max:40},{label:'41 - 59',min:41,max:59},{label:'60 & ABOVE',min:60,max:999}];
  var COLORS=['#388bfd','#3fb950','#d29922','#f85149','#a371f7','#39d353'];
  var counts=BRACKETS.map(function(){return 0;}), withAge=0;
  records.forEach(function(r){var age=parseInt(calcAgeFromDob(r.dob));if(isNaN(age))return;withAge++;for(var i=0;i<BRACKETS.length;i++){if(age>=BRACKETS[i].min&&age<=BRACKETS[i].max){counts[i]++;break;}}});
  var total=records.length;
  document.getElementById('ageTotalBadge').textContent=withAge+' WITH AGE DATA';
  var canvas=document.getElementById('agePieChart'),ctx=canvas.getContext('2d'),W=canvas.width,H=canvas.height;
  ctx.clearRect(0,0,W,H);
  var cx=W/2,cy=H/2,r=Math.min(W,H)/2-8,pieTotal=withAge||1,startAngle=-Math.PI/2;
  if(withAge===0){ctx.beginPath();ctx.arc(cx,cy,r,0,2*Math.PI);ctx.strokeStyle='rgba(255,255,255,0.1)';ctx.lineWidth=2;ctx.stroke();ctx.fillStyle='rgba(255,255,255,0.2)';ctx.font='11px Segoe UI,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('NO DATA',cx,cy);}
  else{BRACKETS.forEach(function(b,i){if(counts[i]===0)return;var slice=(counts[i]/pieTotal)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,startAngle,startAngle+slice);ctx.closePath();ctx.fillStyle=COLORS[i];ctx.fill();ctx.strokeStyle='#161b22';ctx.lineWidth=1.5;ctx.stroke();var pct=(counts[i]/pieTotal)*100;if(pct>=7){var midAngle=startAngle+slice/2;var lx=cx+(r*0.62)*Math.cos(midAngle),ly=cy+(r*0.62)*Math.sin(midAngle);ctx.fillStyle='#fff';ctx.font='bold 10px Segoe UI,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(pct.toFixed(0)+'%',lx,ly);}startAngle+=slice;});}
  document.getElementById('agePieLegend').innerHTML=BRACKETS.map(function(b,i){var count=counts[i],pct=withAge>0?((count/withAge)*100).toFixed(1):'0.0';return '<div class="donut-legend-item"><span class="donut-dot" style="background:'+COLORS[i]+'"></span><span>'+b.label+'</span><strong>'+count+' <span style="font-weight:400;color:var(--text3);font-size:0.7rem">('+pct+'%)</span></strong></div>';}).join('');
  document.getElementById('ageTableBody').innerHTML=BRACKETS.map(function(b,i){var count=counts[i],pct=total>0?((count/total)*100).toFixed(1):'0.0',barW=total>0?Math.round((count/total)*100):0;return '<tr class="'+(count===0?'asst-zero':'')+'"><td><span class="donut-dot" style="background:'+COLORS[i]+';display:inline-block;margin-right:6px"></span>'+b.label+'</td><td style="text-align:center;font-weight:'+(count>0?'700':'400')+';color:'+(count>0?COLORS[i]:'var(--text3)')+'">'+count+'</td><td style="text-align:center">'+pct+'%</td><td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:'+barW+'%;background:'+COLORS[i]+'"></div></div></td></tr>';}).join('');
  document.getElementById('ageTableFoot').innerHTML='<tr class="asst-tfoot-row"><td>TOTAL WITH AGE DATA</td><td style="text-align:center">'+withAge+'</td><td style="text-align:center">-</td><td></td></tr>';
}

// -- MUNICIPALITY / 4Ps / SECTOR / REFERRING UNIT REPORTS ----
var MUNICIPALITIES_BY_PROVINCE = {
  'OCCIDENTAL MINDORO':['SAN JOSE','MAGSAYSAY','RIZAL','CALINTAAN','SABLAYAN','STA. CRUZ','MAMBURAO','PALUAN','ABRA DE ILOG','LOOC','LUBANG'],
  'ORIENTAL MINDORO':['BACO','BULALACAO','BANSUD','BONGABONG','GLORIA','MANSALAY','NAUJAN','PINAMALAYAN','POLA','PUERTO GALERA','ROXAS','SAN TEODORO','SOCORRO','VICTORIA','CALAPAN']
};

function renderMunicipalityReport(records) {
  var ALL_MUN=['SAN JOSE','MAGSAYSAY','RIZAL','CALINTAAN','SABLAYAN','STA. CRUZ','MAMBURAO','PALUAN','ABRA DE ILOG','LOOC','LUBANG','BACO','BULALACAO','BANSUD','BONGABONG','GLORIA','MANSALAY','NAUJAN','PINAMALAYAN','POLA','PUERTO GALERA','ROXAS','SAN TEODORO','SOCORRO','VICTORIA','CALAPAN'];
  var COLORS=['#388bfd','#3fb950','#d29922','#f85149','#a371f7','#39d353','#58a6ff','#79c0ff','#ffa657','#ff7b72','#56d364','#e3b341','#2ea043','#1f6feb','#bc8cff','#f0883e','#3dc9b0','#d2a8ff','#7ee787','#ffa198','#79c0ff','#cae8ff','#ffdf5d','#b1f0fb','#dbb8ff','#ffdcd7'];
  var counts={}; ALL_MUN.forEach(function(m){counts[m]=0;}); var noMun=0, outsideCount=0;
  records.forEach(function(r){if(r.addressProvince==='OUTSIDE MINDORO'){outsideCount++;return;}var m=r.addressMunicipality||'';if(m&&counts[m]!==undefined)counts[m]++;else if(m)counts[m]=1;else noMun++;});
  var total=records.length, OCC=MUNICIPALITIES_BY_PROVINCE['OCCIDENTAL MINDORO'], ORI=MUNICIPALITIES_BY_PROVINCE['ORIENTAL MINDORO'];
  var withMun=total-noMun-outsideCount;
  var maxCount=Math.max.apply(null,ALL_MUN.map(function(m){return counts[m];}).concat([outsideCount,1]));
  document.getElementById('municipalityTotalBadge').textContent=withMun+' WITH MUNICIPALITY';
  function buildRows(list,colorOffset){return list.map(function(m,i){var count=counts[m]||0,barPx=Math.max(Math.round((count/maxCount)*110),count>0?4:0),color=COLORS[(colorOffset+i)%COLORS.length];return{m:m,count:count,barPx:barPx,color:color};});}
  var occRows=buildRows(OCC,0), oriRows=buildRows(ORI,11), outsideRow={m:'OUTSIDE MINDORO',count:outsideCount,barPx:Math.max(Math.round((outsideCount/maxCount)*110),outsideCount>0?4:0),color:'#6e7681'};
  var allBarRows=occRows.concat(oriRows).concat(outsideCount>0?[outsideRow]:[]).filter(function(r){return r.count>0;});
  document.getElementById('municipalityBars').innerHTML=allBarRows.map(function(r){return '<div class="asst-bar-group"><div class="asst-bar-wrap"><div class="asst-bar-count">'+r.count+'</div><div class="asst-bar" style="height:'+r.barPx+'px;background:linear-gradient(180deg,'+r.color+' 0%,'+r.color+'99 100%)" title="'+r.m+': '+r.count+'"></div></div><div class="asst-bar-label" style="font-size:0.6rem">'+r.m+'</div></div>';}).join('')||'<div style="color:var(--text3);font-size:0.8rem;padding:12px">NO DATA YET</div>';
  function buildTableRows(rows,label){var html='<tr style="background:var(--bg2)"><td colspan="4" style="font-size:0.7rem;letter-spacing:1px;color:var(--text3);padding:6px 8px">'+label+'</td></tr>';html+=rows.map(function(r){var pct=total>0?((r.count/total)*100).toFixed(1):'0.0',barW=total>0?Math.round((r.count/total)*100):0;return '<tr class="'+(r.count===0?'asst-zero':'')+'"><td><span class="donut-dot" style="background:'+r.color+';display:inline-block;margin-right:6px"></span>'+r.m+'</td><td style="text-align:center;font-weight:'+(r.count>0?'700':'400')+';color:'+(r.count>0?r.color:'var(--text3)')+'">'+r.count+'</td><td style="text-align:center">'+pct+'%</td><td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:'+barW+'%;background:'+r.color+'"></div></div></td></tr>';}).join('');return html;}
  var outsidePct=total>0?((outsideCount/total)*100).toFixed(1):'0.0', outsideBarW=total>0?Math.round((outsideCount/total)*100):0;
  document.getElementById('municipalityTableBody').innerHTML=buildTableRows(occRows,'OCCIDENTAL MINDORO')+buildTableRows(oriRows,'ORIENTAL MINDORO')+'<tr style="background:var(--bg2)"><td colspan="4" style="font-size:0.7rem;letter-spacing:1px;color:var(--text3);padding:6px 8px">OUTSIDE MINDORO</td></tr><tr class="'+(outsideCount===0?'asst-zero':'')+'"><td><span class="donut-dot" style="background:#6e7681;display:inline-block;margin-right:6px"></span>OUTSIDE MINDORO</td><td style="text-align:center;font-weight:'+(outsideCount>0?'700':'400')+';color:'+(outsideCount>0?'#6e7681':'var(--text3)')+'">'+outsideCount+'</td><td style="text-align:center">'+outsidePct+'%</td><td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:'+outsideBarW+'%;background:#6e7681"></div></div></td></tr>';
  document.getElementById('municipalityTableFoot').innerHTML='<tr class="asst-tfoot-row"><td>NOT SPECIFIED</td><td style="text-align:center">'+noMun+'</td><td style="text-align:center">'+(total>0?((noMun/total)*100).toFixed(1):'0.0')+'%</td><td></td></tr>';
}

function render4PsReport(records) {
  var total=records.length, yes=records.filter(function(r){return r.fourPs==='YES';}).length, no=records.filter(function(r){return r.fourPs==='NO';}).length, noData=total-yes-no;
  document.getElementById('fourPsTotalBadge').textContent=yes+' 4Ps BENEFICIARIES';
  var rows=[{label:'YES',count:yes,color:'#3fb950'},{label:'NO',count:no,color:'#f85149'},{label:'NOT SPECIFIED',count:noData,color:'#6e7681'}];
  var maxCount=Math.max.apply(null,rows.map(function(r){return r.count;}).concat([1]));
  document.getElementById('fourPsBars').innerHTML=rows.map(function(r){var barPx=Math.max(Math.round((r.count/maxCount)*110),r.count>0?4:0);return '<div class="asst-bar-group"><div class="asst-bar-wrap"><div class="asst-bar-count">'+r.count+'</div><div class="asst-bar" style="height:'+barPx+'px;background:linear-gradient(180deg,'+r.color+' 0%,'+r.color+'99 100%)" title="'+r.label+': '+r.count+'"></div></div><div class="asst-bar-label">'+r.label+'</div></div>';}).join('');
  document.getElementById('fourPsTableBody').innerHTML=rows.map(function(r){var pct=total>0?((r.count/total)*100).toFixed(1):'0.0',barW=total>0?Math.round((r.count/total)*100):0;return '<tr class="'+(r.count===0?'asst-zero':'')+'"><td><span class="donut-dot" style="background:'+r.color+';display:inline-block;margin-right:6px"></span>'+r.label+'</td><td style="text-align:center;font-weight:'+(r.count>0?'700':'400')+';color:'+(r.count>0?r.color:'var(--text3)')+'">'+r.count+'</td><td style="text-align:center">'+pct+'%</td><td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:'+barW+'%;background:'+r.color+'"></div></div></td></tr>';}).join('');
}

function renderSectorReport(records) {
  var SECTORS=['FARMER/FISHERFOLK','WOMEN','PWD','CHILDREN AND YOUTH','SENIOR CITIZEN','SOLO PARENT','INDIGENOUS PEOPLE','URBAN POOR','OTHERS'];
  var COLORS=['#3fb950','#a371f7','#f85149','#388bfd','#d29922','#58a6ff','#39d353','#ffa657','#6e7681'];
  var total=records.length, counts={}; SECTORS.forEach(function(s){counts[s]=0;});
  records.forEach(function(r){(r.sector||[]).forEach(function(s){var key=s.indexOf('OTHERS')===0?'OTHERS':s;if(counts[key]!==undefined)counts[key]++;});});
  var withSector=records.filter(function(r){return r.sector&&r.sector.length>0;}).length;
  var maxCount=Math.max.apply(null,SECTORS.map(function(s){return counts[s];}).concat([1]));
  document.getElementById('sectorTotalBadge').textContent=withSector+' WITH SECTOR';
  document.getElementById('sectorBars').innerHTML=SECTORS.map(function(s,i){var count=counts[s],barPx=Math.max(Math.round((count/maxCount)*110),count>0?4:0);return '<div class="asst-bar-group"><div class="asst-bar-wrap"><div class="asst-bar-count">'+count+'</div><div class="asst-bar" style="height:'+barPx+'px;background:linear-gradient(180deg,'+COLORS[i]+' 0%,'+COLORS[i]+'99 100%)" title="'+s+': '+count+'"></div></div><div class="asst-bar-label" style="font-size:0.6rem">'+s+'</div></div>';}).join('');
  document.getElementById('sectorTableBody').innerHTML=SECTORS.map(function(s,i){var count=counts[s],pct=total>0?((count/total)*100).toFixed(1):'0.0',barW=total>0?Math.round((count/total)*100):0;return '<tr class="'+(count===0?'asst-zero':'')+'"><td><span class="donut-dot" style="background:'+COLORS[i]+';display:inline-block;margin-right:6px"></span>'+s+'</td><td style="text-align:center;font-weight:'+(count>0?'700':'400')+';color:'+(count>0?COLORS[i]:'var(--text3)')+'">'+count+'</td><td style="text-align:center">'+pct+'%</td><td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:'+barW+'%;background:'+COLORS[i]+'"></div></div></td></tr>';}).join('');
  document.getElementById('sectorTableFoot').innerHTML='<tr class="asst-tfoot-row"><td>RECORDS WITH NO SECTOR</td><td style="text-align:center">'+(total-withSector)+'</td><td style="text-align:center">'+(total>0?(((total-withSector)/total)*100).toFixed(1):'0.0')+'%</td><td></td></tr>';
}

function renderReferringUnitReport(records) {
  var UNITS=['102nd SAC','1st Infantry "Always First" Battalion','1st OMPMFC','203rd Infantry "Bantay Kapayapaan" Brigade','23MICO','2CMO Battalion','2nd OMPMFC','402nd B MC RMFB 4B','405th B MC RMFB 4B','4th Infantry "Scorpion" Battalion','68th Infantry "Kaagapay" Battalion','76th Infantry "Victrix" Battalion','ISAFP','PIT Occidental Mindoro RIU 4B','OTHERS'];
  var COLORS=['#388bfd','#3fb950','#d29922','#f85149','#a371f7','#39d353','#58a6ff','#79c0ff','#ffa657','#ff7b72','#56d364','#e3b341','#2ea043','#1f6feb','#6e7681'];
  var total=records.length, counts={}; UNITS.forEach(function(u){counts[u]=0;}); var noUnit=0;
  records.forEach(function(r){var u=r.referringUnit||'';if(!u){noUnit++;return;}var key=u.indexOf('OTHERS')===0?'OTHERS':u;if(counts[key]!==undefined)counts[key]++;else noUnit++;});
  var withUnit=total-noUnit, maxCount=Math.max.apply(null,UNITS.map(function(u){return counts[u];}).concat([1]));
  document.getElementById('referringUnitTotalBadge').textContent=withUnit+' WITH REFERRING UNIT';
  var barRows=UNITS.map(function(u,i){return{u:u,count:counts[u],color:COLORS[i]};}).filter(function(r){return r.count>0;});
  document.getElementById('referringUnitBars').innerHTML=barRows.length?barRows.map(function(r){var barPx=Math.max(Math.round((r.count/maxCount)*110),4);return '<div class="asst-bar-group"><div class="asst-bar-wrap"><div class="asst-bar-count">'+r.count+'</div><div class="asst-bar" style="height:'+barPx+'px;background:linear-gradient(180deg,'+r.color+' 0%,'+r.color+'99 100%)" title="'+r.u+': '+r.count+'"></div></div><div class="asst-bar-label" style="font-size:0.55rem;max-width:52px;word-break:break-word;text-align:center">'+r.u+'</div></div>';}).join(''):'<div style="color:var(--text3);font-size:0.8rem;padding:12px">NO DATA YET</div>';
  document.getElementById('referringUnitTableBody').innerHTML=UNITS.map(function(u,i){var count=counts[u],pct=total>0?((count/total)*100).toFixed(1):'0.0',barW=total>0?Math.round((count/total)*100):0;return '<tr class="'+(count===0?'asst-zero':'')+'"><td><span class="donut-dot" style="background:'+COLORS[i]+';display:inline-block;margin-right:6px"></span>'+u+'</td><td style="text-align:center;font-weight:'+(count>0?'700':'400')+';color:'+(count>0?COLORS[i]:'var(--text3)')+'">'+count+'</td><td style="text-align:center">'+pct+'%</td><td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:'+barW+'%;background:'+COLORS[i]+'"></div></div></td></tr>';}).join('');
  document.getElementById('referringUnitTableFoot').innerHTML='<tr class="asst-tfoot-row"><td>NOT SPECIFIED</td><td style="text-align:center">'+noUnit+'</td><td style="text-align:center">'+(total>0?((noUnit/total)*100).toFixed(1):'0.0')+'%</td><td></td></tr>';
}

// -- RECORDS LIST ---------------------------------------------
function renderRecords(records, filter) {
  filter = filter || '';
  var list = records;
  if (filter) {
    var q = filter.toLowerCase();
    list = records.filter(function(r) {
      return (r.lastName+' '+r.firstName+' '+(r.middleName||'')).toLowerCase().indexOf(q)!==-1 ||
        (r.alias||'').toLowerCase().indexOf(q)!==-1 ||
        (r.unit||'').toLowerCase().indexOf(q)!==-1 ||
        (r.referringUnit||'').toLowerCase().indexOf(q)!==-1;
    });
  }
  // Sort alphabetically by Last Name then First Name
  list = list.slice().sort(function(a, b) {
    var la = (a.lastName  || '').toUpperCase();
    var lb = (b.lastName  || '').toUpperCase();
    var fa = (a.firstName || '').toUpperCase();
    var fb = (b.firstName || '').toUpperCase();
    if (la < lb) return -1;
    if (la > lb) return  1;
    if (fa < fb) return -1;
    if (fa > fb) return  1;
    return 0;
  });
  var tbody = document.getElementById('recordsTableBody');
  if (!list.length) { tbody.innerHTML='<tr><td colspan="10"><div class="empty-state"><div class="empty-icon">&#128269;</div><p>NO RECORDS FOUND</p></div></td></tr>'; return; }
  tbody.innerHTML = list.map(function(r, i) {
    var photoCell = r.idPhoto
      ? '<img src="'+r.idPhoto+'" class="record-thumb" alt="ID"/>'
      : '<img src="BHB.png" class="record-thumb" alt="ID"/>';
    var name = '<strong>'+r.lastName+', '+r.firstName+'</strong>'+(r.middleName?' '+r.middleName:'');
    return '<tr><td>'+(i+1)+'</td><td>'+photoCell+'</td><td>'+name+'</td><td>'+(r.alias||'-')+'</td><td>'+(r.sex||'-')+'</td><td>'+(calcAgeFromDob(r.dob)||'-')+'</td><td>'+(r.unit||'-')+'</td><td>'+formatDate(r.dateSurrendered)+'</td><td>'+(r.areaOfOperation||'-')+'</td><td><div class="action-btns"><button class="btn-view" onclick="viewRecord(\''+r.id+'\')">&#128065; VIEW</button><button class="btn-edit" onclick="editRecord(\''+r.id+'\')">&#9998; EDIT</button><button class="btn-del" onclick="promptDelete(\''+r.id+'\')">&#128465; DEL</button></div></td></tr>';
  }).join('');
}

function filterRecords() { renderRecords(allRecordsCache, document.getElementById('searchInput').value); }

// -- ID PHOTO -------------------------------------------------
function previewIdPhoto(event) {
  var file = event.target.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    idPhotoData = e.target.result;
    var img = document.getElementById('idPhotoPreview');
    img.src = idPhotoData;
    img.style.display = 'block';
    document.getElementById('idPhotoPlaceholder').style.display = 'none';
    document.getElementById('removePhotoBtn').style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function removeIdPhoto() {
  idPhotoData = null;
  var img = document.getElementById('idPhotoPreview');
  img.src = 'BHB.png';
  img.style.display = 'block';
  document.getElementById('idPhotoPlaceholder').style.display = 'none';
  document.getElementById('removePhotoBtn').style.display = 'none';
  document.getElementById('idPhotoInput').value = '';
}

// -- CAMERA ---------------------------------------------------
var cameraStream = null;
function openCamera() {
  var modal = document.getElementById('cameraModal'), video = document.getElementById('cameraStream');
  modal.classList.remove('hidden');
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
    .then(function(stream) { cameraStream = stream; video.srcObject = stream; })
    .catch(function(err) {
      closeCamera();
      if (err.name==='NotAllowedError'||err.name==='PermissionDeniedError') showToast('CAMERA PERMISSION DENIED.','error');
      else if (err.name==='NotFoundError') showToast('NO CAMERA FOUND.','error');
      else showToast('CAMERA ERROR: '+err.message,'error');
    });
}
function capturePhoto() {
  var video=document.getElementById('cameraStream'), canvas=document.getElementById('cameraCanvas');
  var size=Math.min(video.videoWidth,video.videoHeight), ox=(video.videoWidth-size)/2, oy=(video.videoHeight-size)/2;
  canvas.width=size; canvas.height=size;
  canvas.getContext('2d').drawImage(video,ox,oy,size,size,0,0,size,size);
  idPhotoData = canvas.toDataURL('image/jpeg',0.85);
  var img = document.getElementById('idPhotoPreview');
  img.src=idPhotoData; img.style.display='block';
  document.getElementById('idPhotoPlaceholder').style.display='none';
  document.getElementById('removePhotoBtn').style.display='block';
  closeCamera(); showToast('PHOTO CAPTURED','success');
}
function closeCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(function(t){t.stop();}); cameraStream=null; }
  document.getElementById('cameraStream').srcObject=null;
  document.getElementById('cameraModal').classList.add('hidden');
}

// -- VALID ID SLOTS -------------------------------------------
function addValidIdSlot() { validIdSlots.push({id:genId(),dataUrl:null,fileName:''}); renderValidIdSlots(); }
function renderValidIdSlots() {
  var container = document.getElementById('validIdContainer');
  if (!validIdSlots.length) { container.innerHTML=''; return; }
  container.innerHTML = validIdSlots.map(function(slot,idx) {
    var preview = slot.dataUrl ? '<img src="'+slot.dataUrl+'" class="upload-slot-preview" alt="ID"/>' : '<span style="font-size:24px">&#128282;</span>';
    return '<div class="upload-slot" id="slot-'+slot.id+'"><span class="upload-slot-label">VALID ID '+(idx+1)+'</span>'+preview+'<span class="upload-slot-name">'+(slot.fileName||'NO FILE SELECTED')+'</span><button type="button" class="upload-slot-btn" onclick="triggerSlotUpload(\''+slot.id+'\')">&#128269; BROWSE</button><input type="file" id="slotInput-'+slot.id+'" accept=".jpg,.jpeg" style="display:none" onchange="handleSlotUpload(event,\''+slot.id+'\')" /><button type="button" class="btn-del" onclick="removeValidIdSlot(\''+slot.id+'\')" style="padding:5px 8px;font-size:0.7rem">X</button></div>';
  }).join('');
}
function triggerSlotUpload(slotId) { document.getElementById('slotInput-'+slotId).click(); }
function handleSlotUpload(event, slotId) {
  var file=event.target.files[0]; if(!file) return;
  var reader=new FileReader();
  reader.onload=function(e){
    for(var i=0;i<validIdSlots.length;i++){if(validIdSlots[i].id===slotId){validIdSlots[i].dataUrl=e.target.result;validIdSlots[i].fileName=file.name.toUpperCase();break;}}
    renderValidIdSlots();
  };
  reader.readAsDataURL(file);
}
function removeValidIdSlot(slotId) { validIdSlots=validIdSlots.filter(function(s){return s.id!==slotId;}); renderValidIdSlots(); }

// -- JAPIC ----------------------------------------------------
function previewJapic(event) {
  var file=event.target.files[0]; if(!file) return;
  var isPdf=file.type==='application/pdf';
  var reader=new FileReader();
  reader.onload=function(e){
    japicData={dataUrl:e.target.result,fileName:file.name.toUpperCase(),type:isPdf?'pdf':'image'};
    var preview=document.getElementById('japicPreview');
    document.getElementById('japicPlaceholder').style.display='none'; preview.style.display='block';
    preview.innerHTML=isPdf?'<div class="japic-file-info"><span style="font-size:36px">&#128196;</span><span class="file-name">'+file.name.toUpperCase()+'</span></div>':'<div class="japic-file-info"><img src="'+e.target.result+'" alt="JAPIC"/><span class="file-name">'+file.name.toUpperCase()+'</span></div>';
    document.getElementById('removeJapicBtn').style.display='inline-block';
  };
  reader.readAsDataURL(file);
}
function removeJapic() {
  japicData=null; document.getElementById('japicPreview').style.display='none'; document.getElementById('japicPreview').innerHTML='';
  document.getElementById('japicPlaceholder').style.display='block'; document.getElementById('removeJapicBtn').style.display='none'; document.getElementById('japicInput').value='';
}

// -- SOCIAL CASE REPORT ---------------------------------------
function previewSocialCase(event) {
  var file=event.target.files[0]; if(!file) return;
  var ext=file.name.split('.').pop().toLowerCase(), isPdf=ext==='pdf', isImg=ext==='jpg'||ext==='jpeg';
  var reader=new FileReader();
  reader.onload=function(e){
    socialCaseData={dataUrl:e.target.result,fileName:file.name.toUpperCase(),type:isPdf?'pdf':isImg?'image':'doc'};
    var preview=document.getElementById('socialCasePreview');
    document.getElementById('socialCasePlaceholder').style.display='none'; preview.style.display='block';
    if(isImg){preview.innerHTML='<div class="japic-file-info"><img src="'+e.target.result+'" alt="Report"/><span class="file-name">'+file.name.toUpperCase()+'</span></div>';}
    else{preview.innerHTML='<div class="japic-file-info"><span style="font-size:36px">&#128196;</span><span class="file-name">'+file.name.toUpperCase()+'</span></div>';}
    document.getElementById('removeSocialCaseBtn').style.display='inline-block';
  };
  reader.readAsDataURL(file);
}
function removeSocialCase() {
  socialCaseData=null; document.getElementById('socialCasePreview').style.display='none'; document.getElementById('socialCasePreview').innerHTML='';
  document.getElementById('socialCasePlaceholder').style.display='block'; document.getElementById('removeSocialCaseBtn').style.display='none'; document.getElementById('socialCaseInput').value='';
}

// -- ADDRESS HELPERS ------------------------------------------
function buildFullAddress(barangay, municipality, province) {
  var parts=[]; if(barangay)parts.push(barangay); if(municipality)parts.push(municipality); if(province)parts.push(province); return parts.join(', ');
}
function onProvinceChange() {
  var province=document.getElementById('addressProvince').value;
  var select=document.getElementById('addressMunicipality'), textInput=document.getElementById('addressMunicipalityText');
  if(province==='OUTSIDE MINDORO'){select.style.display='none';textInput.style.display='block';textInput.value='';}
  else{
    select.style.display='block';textInput.style.display='none';
    var list=MUNICIPALITIES_BY_PROVINCE[province]||[];
    select.innerHTML='<option value="">-- SELECT --</option>'+list.map(function(m){return '<option value="'+m+'">'+m+'</option>';}).join('');
  }
}
function onReferringUnitChange() { var val=document.getElementById('referringUnit').value,group=document.getElementById('referringUnitOthersGroup'),inp=document.getElementById('referringUnitOthers');group.style.display=val==='OTHERS'?'block':'none';if(val!=='OTHERS')inp.value=''; }
function toggleOthersSpec() { var cb=document.getElementById('asst_others'),spec=document.getElementById('asst_others_spec');spec.style.display=cb.checked?'inline-block':'none';if(!cb.checked)spec.value=''; }
function toggleSectorOthersSpec() { var cb=document.getElementById('sec_others'),spec=document.getElementById('sec_others_spec');spec.style.display=cb.checked?'inline-block':'none';if(!cb.checked)spec.value=''; }
function onReligionChange() { var val=document.getElementById('religion').value,group=document.getElementById('religionOthersGroup'),inp=document.getElementById('religionOthers');group.style.display=val==='OTHERS'?'block':'none';if(val!=='OTHERS')inp.value=''; }
function togglePwdSpec() { var cb=document.getElementById('sec_pwd'),row=document.getElementById('pwdDisabilityRow'),inp=document.getElementById('pwdDisability');row.style.display=cb.checked?'block':'none';if(!cb.checked)inp.value=''; }
function onMedicalConditionChange() { var val=document.getElementById('medicalCondition').value,group=document.getElementById('medicalConditionSpecGroup'),spec=document.getElementById('medicalConditionSpec');group.style.display=val==='YES'?'block':'none';if(val!=='YES')spec.value=''; }
function onTribalGroupChange() { var val=document.getElementById('tribalGroup').value,ipCb=document.getElementById('sec_ip');if(val&&val!=='NO TRIBAL GROUP')ipCb.checked=true;else if(val==='NO TRIBAL GROUP')ipCb.checked=false; }

// -- SAVE RECORD (with Firebase Storage upload) ---------------
var isSaving = false; // guard against double-submit

function saveRecord(event) {
  event.preventDefault();
  if (isSaving) return; // already saving — ignore extra clicks
  isSaving = true; // lock immediately — before any async work

  var saveBtn = document.querySelector('#recordForm button[type="submit"]');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ SAVING...'; }

  function unlockSave() {
    isSaving = false;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '💾 SAVE RECORD'; }
  }
  var sectorChecked = SECTOR_IDS.some(function(id){return document.getElementById(id).checked;});
  var sectorErr = document.getElementById('sectorError');
  if(!sectorChecked){sectorErr.style.display='block';document.getElementById('sec_farmer').scrollIntoView({behavior:'smooth',block:'center'});unlockSave();return;}
  sectorErr.style.display='none';
  if(document.getElementById('religion').value==='OTHERS'&&!document.getElementById('religionOthers').value.trim()){document.getElementById('religionOthers').focus();showToast('PLEASE SPECIFY RELIGION','error');unlockSave();return;}

  var asstIds=['asst_eclip','asst_fea','asst_livelihood','asst_medical','asst_educational','asst_credentials','asst_philhealth','asst_safeconduct','asst_amnesty'];
  var asstVals={asst_eclip:'E-CLIP',asst_fea:'FEA REMUNERATION',asst_livelihood:'LIVELIHOOD',asst_medical:'MEDICAL',asst_educational:'EDUCATIONAL',asst_credentials:'ISSUANCE OF CREDENTIALS',asst_philhealth:'PHILHEALTH',asst_safeconduct:'ISSUANCE OF SAFE CONDUCT PASS',asst_amnesty:'APPLIED FOR AMNESTY'};
  var assistance=[];
  asstIds.forEach(function(id){if(document.getElementById(id).checked)assistance.push(asstVals[id]);});
  if(document.getElementById('asst_others').checked){var spec=document.getElementById('asst_others_spec').value.trim();assistance.push('OTHERS'+(spec?': '+spec.toUpperCase():''));}

  var religionVal=document.getElementById('religion').value;
  if(religionVal==='OTHERS')religionVal='OTHERS: '+document.getElementById('religionOthers').value.trim().toUpperCase();

  var secMap={sec_farmer:'FARMER/FISHERFOLK',sec_women:'WOMEN',sec_pwd:'PWD',sec_youth:'CHILDREN AND YOUTH',sec_senior:'SENIOR CITIZEN',sec_solo_parent:'SOLO PARENT',sec_ip:'INDIGENOUS PEOPLE',sec_urban_poor:'URBAN POOR'};
  var sectorList=[];
  Object.keys(secMap).forEach(function(id){if(document.getElementById(id).checked)sectorList.push(secMap[id]);});
  if(document.getElementById('sec_others').checked){var secSpec=document.getElementById('sec_others_spec').value.trim();sectorList.push('OTHERS'+(secSpec?': '+secSpec.toUpperCase():''));}

  var referringUnitVal=(function(){var val=document.getElementById('referringUnit').value;if(val==='OTHERS'){var spec=document.getElementById('referringUnitOthers').value.trim().toUpperCase();return spec?'OTHERS: '+spec:'OTHERS';}return val;})();

  var recordId = editingRecordId || genId();
  var record = {
    id: recordId,
    lastName:            document.getElementById('lastName').value.trim().toUpperCase(),
    firstName:           document.getElementById('firstName').value.trim().toUpperCase(),
    middleName:          document.getElementById('middleName').value.trim().toUpperCase(),
    alias:               document.getElementById('alias').value.trim().toUpperCase(),
    dob:                 document.getElementById('dob').value,
    sex:                 document.getElementById('sex').value,
    civilStatus:         document.getElementById('civilStatus').value,
    tribalGroup:         document.getElementById('tribalGroup').value,
    religion:            religionVal,
    contactNumber:       document.getElementById('contactNumber').value.trim(),
    medicalCondition:    document.getElementById('medicalCondition').value,
    medicalConditionSpec:document.getElementById('medicalCondition').value==='YES'?document.getElementById('medicalConditionSpec').value.trim().toUpperCase():'',
    fourPs:              document.getElementById('fourPs').value,
    pwdDisability:       document.getElementById('sec_pwd').checked?document.getElementById('pwdDisability').value.trim().toUpperCase():'',
    address:             document.getElementById('addressBarangay').value.trim().toUpperCase(),
    addressBarangay:     document.getElementById('addressBarangay').value.trim().toUpperCase(),
    addressMunicipality: document.getElementById('addressProvince').value==='OUTSIDE MINDORO'?document.getElementById('addressMunicipalityText').value.trim().toUpperCase():document.getElementById('addressMunicipality').value,
    addressProvince:     document.getElementById('addressProvince').value,
    sector:              sectorList,
    idPhoto:             idPhotoData,
    unit:                document.getElementById('unit').value.trim().toUpperCase(),
    position:            document.getElementById('position').value.trim().toUpperCase(),
    membershipType:      document.getElementById('membershipType').value,
    areaOfOperation:     document.getElementById('areaOfOperation').value,
    yearsInMovement:     document.getElementById('yearsInMovement').value,
    dateSurrendered:     document.getElementById('dateSurrendered').value,
    pendingCase:         document.getElementById('pendingCase').value,
    referringUnit:       referringUnitVal,
    remarks:             document.getElementById('remarks').value.trim().toUpperCase(),
    assistance:          assistance,
    validIds:            validIdSlots.filter(function(s){return s.dataUrl;}).map(function(s){return{dataUrl:s.dataUrl,fileName:s.fileName};}),
    japic:               japicData,
    socialCaseReport:    socialCaseData,
    createdBy:           currentUser.username,
    updatedAt:           new Date().toISOString()
  };

  if(editingRecordId){
    var existing=null;
    for(var i=0;i<allRecordsCache.length;i++){if(allRecordsCache[i].id===editingRecordId){existing=allRecordsCache[i];break;}}
    record.createdAt=existing?existing.createdAt:new Date().toISOString();
  } else {
    record.createdAt=new Date().toISOString();
  }

  var isEdit = !!editingRecordId;

  // -- DUPLICATE CHECK -----------------------------------------
  // Block if another record already has same Last Name + First Name + DOB
  showToast('CHECKING FOR DUPLICATES...', 'info');
  db.collection('records')
    .where('lastName',    '==', record.lastName)
    .where('firstName',   '==', record.firstName)
    .where('dob',         '==', record.dob)
    .get({ source: 'server' })
    .then(function(snap) {
      var duplicate = null;
      snap.docs.forEach(function(d) {
        // Ignore the record being edited
        if (d.id !== record.id) duplicate = d.data();
      });
      if (duplicate) {
        showToast(
          'DUPLICATE ENTRY — ' + duplicate.lastName + ', ' + duplicate.firstName +
          ' (DOB: ' + formatDate(duplicate.dob) + ') ALREADY EXISTS.',
          'error'
        );
        unlockSave();
        return;
      }
      // No duplicate — proceed with save
      showToast('SAVING RECORD...', 'info');
      uploadRecordFiles(record).then(function(r) {
        return dbPut(r);
      }).then(function() {
        unlockSave();
        playChime();
        showToast(isEdit ? 'RECORD UPDATED SUCCESSFULLY' : 'RECORD SAVED SUCCESSFULLY', 'success');
        editingRecordId = null;
        allRecordsCache = [];
        dbGetAll().then(function(records) {
          allRecordsCache = records;
          showPage('records');
        }).catch(function() {
          showPage('records');
        });
      }).catch(function(err) {
        unlockSave();
        showToast('ERROR SAVING RECORD: ' + err.message, 'error');
      });
    })
    .catch(function(err) {
      console.warn('[FRDB] Duplicate check failed:', err.message);
      showToast('SAVING RECORD...', 'info');
      uploadRecordFiles(record).then(function(r) {
        return dbPut(r);
      }).then(function() {
        unlockSave();
        playChime();
        showToast(isEdit ? 'RECORD UPDATED SUCCESSFULLY' : 'RECORD SAVED SUCCESSFULLY', 'success');
        editingRecordId = null;
        allRecordsCache = [];
        dbGetAll().then(function(records) {
          allRecordsCache = records;
          showPage('records');
        }).catch(function() { showPage('records'); });
      }).catch(function(err) {
        unlockSave();
        showToast('ERROR SAVING RECORD: ' + err.message, 'error');
      });
    });
}

// -- RESET FORM -----------------------------------------------
function resetForm() {
  editingRecordId=null;
  document.getElementById('recordForm').reset();
  document.getElementById('recordId').value='';
  document.getElementById('age').value='';
  removeIdPhoto(); validIdSlots=[]; renderValidIdSlots(); removeJapic(); removeSocialCase();
  ['asst_eclip','asst_fea','asst_livelihood','asst_medical','asst_educational','asst_credentials','asst_philhealth','asst_safeconduct','asst_amnesty','asst_others'].forEach(function(id){document.getElementById(id).checked=false;});
  document.getElementById('asst_others_spec').style.display='none'; document.getElementById('asst_others_spec').value='';
  SECTOR_IDS.forEach(function(id){document.getElementById(id).checked=false;});
  document.getElementById('sec_others_spec').style.display='none'; document.getElementById('sec_others_spec').value='';
  document.getElementById('sectorError').style.display='none';
  document.getElementById('religion').value=''; document.getElementById('religionOthers').value=''; document.getElementById('religionOthersGroup').style.display='none';
  document.getElementById('contactNumber').value=''; document.getElementById('medicalCondition').value=''; document.getElementById('medicalConditionSpec').value='';
  document.getElementById('fourPs').value=''; document.getElementById('pendingCase').value=''; document.getElementById('referringUnit').value='';
  document.getElementById('referringUnitOthers').value=''; document.getElementById('referringUnitOthersGroup').style.display='none';
  document.getElementById('remarks').value='';
  document.getElementById('pwdDisability').value=''; document.getElementById('addressBarangay').value='';
  document.getElementById('addressMunicipality').value=''; document.getElementById('addressMunicipalityText').value='';
  document.getElementById('addressProvince').value='OCCIDENTAL MINDORO';
  onProvinceChange(); onMedicalConditionChange(); togglePwdSpec();
}

// -- EDIT RECORD ----------------------------------------------
function editRecord(id) {
  var r=null;
  for(var i=0;i<allRecordsCache.length;i++){if(allRecordsCache[i].id===id){r=allRecordsCache[i];break;}}
  if(!r) return;
  editingRecordId=id;
  document.getElementById('lastName').value=r.lastName||''; document.getElementById('firstName').value=r.firstName||''; document.getElementById('middleName').value=r.middleName||'';
  document.getElementById('alias').value=r.alias||''; document.getElementById('dob').value=r.dob||''; document.getElementById('sex').value=r.sex||'';
  syncWomenSector();
  document.getElementById('civilStatus').value=r.civilStatus||''; document.getElementById('tribalGroup').value=normalizeTribalGroup(r.tribalGroup)||r.tribalGroup||'';
  document.getElementById('addressBarangay').value=r.addressBarangay||r.address||'';
  document.getElementById('addressProvince').value=r.addressProvince||'OCCIDENTAL MINDORO';
  onProvinceChange();
  if(r.addressProvince==='OUTSIDE MINDORO')document.getElementById('addressMunicipalityText').value=r.addressMunicipality||'';
  else document.getElementById('addressMunicipality').value=r.addressMunicipality||'';
  var savedReligion=r.religion||'', knownReligions=['CATHOLIC','SEVENTH DAY ADVENTIST','CHRISTIAN','IGLESIA NI CRISTO'];
  if(knownReligions.indexOf(savedReligion)!==-1){document.getElementById('religion').value=savedReligion;document.getElementById('religionOthersGroup').style.display='none';document.getElementById('religionOthers').value='';}
  else if(savedReligion){document.getElementById('religion').value='OTHERS';document.getElementById('religionOthersGroup').style.display='block';document.getElementById('religionOthers').value=savedReligion.replace('OTHERS: ','').replace('OTHERS','');}
  else{document.getElementById('religion').value='';document.getElementById('religionOthersGroup').style.display='none';}
  document.getElementById('contactNumber').value=r.contactNumber||''; document.getElementById('medicalCondition').value=r.medicalCondition||''; document.getElementById('fourPs').value=r.fourPs||''; document.getElementById('pwdDisability').value=r.pwdDisability||'';
  onMedicalConditionChange();
  if(r.medicalCondition==='YES'&&r.medicalConditionSpec)document.getElementById('medicalConditionSpec').value=r.medicalConditionSpec;
  var secMap={'FARMER/FISHERFOLK':'sec_farmer','WOMEN':'sec_women','PWD':'sec_pwd','CHILDREN AND YOUTH':'sec_youth','SENIOR CITIZEN':'sec_senior','SOLO PARENT':'sec_solo_parent','INDIGENOUS PEOPLE':'sec_ip','URBAN POOR':'sec_urban_poor'};
  Object.values(secMap).forEach(function(id){document.getElementById(id).checked=false;});
  document.getElementById('sec_others').checked=false; document.getElementById('sec_others_spec').style.display='none'; document.getElementById('sec_others_spec').value=''; document.getElementById('sectorError').style.display='none';
  (r.sector||[]).forEach(function(s){if(secMap[s])document.getElementById(secMap[s]).checked=true;else if(s.indexOf('OTHERS')===0){document.getElementById('sec_others').checked=true;document.getElementById('sec_others_spec').style.display='inline-block';document.getElementById('sec_others_spec').value=s.replace('OTHERS: ','').replace('OTHERS','');}});
  togglePwdSpec(); calcAge();
  if(r.idPhoto){idPhotoData=r.idPhoto;var img=document.getElementById('idPhotoPreview');img.src=r.idPhoto;img.style.display='block';document.getElementById('idPhotoPlaceholder').style.display='none';document.getElementById('removePhotoBtn').style.display='block';}
  else{removeIdPhoto();}
  document.getElementById('unit').value=r.unit||''; document.getElementById('position').value=r.position||''; document.getElementById('membershipType').value=r.membershipType||'';
  document.getElementById('areaOfOperation').value=r.areaOfOperation||''; document.getElementById('yearsInMovement').value=r.yearsInMovement||'';
  document.getElementById('dateSurrendered').value=r.dateSurrendered||''; document.getElementById('pendingCase').value=r.pendingCase||'';
  document.getElementById('remarks').value=r.remarks||'';
  var KNOWN_UNITS=['102nd SAC','1st Infantry "Always First" Battalion','1st OMPMFC','203rd Infantry "Bantay Kapayapaan" Brigade','23MICO','2CMO Battalion','2nd OMPMFC','402nd B MC RMFB 4B','405th B MC RMFB 4B','4th Infantry "Scorpion" Battalion','68th Infantry "Kaagapay" Battalion','76th Infantry "Victrix" Battalion','ISAFP','PIT Occidental Mindoro RIU 4B','OTHERS'];
  var savedUnit=r.referringUnit||'';
  if(!savedUnit){document.getElementById('referringUnit').value='';document.getElementById('referringUnitOthersGroup').style.display='none';}
  else if(KNOWN_UNITS.indexOf(savedUnit)!==-1){document.getElementById('referringUnit').value=savedUnit;document.getElementById('referringUnitOthersGroup').style.display='none';}
  else if(savedUnit.indexOf('OTHERS')===0){document.getElementById('referringUnit').value='OTHERS';document.getElementById('referringUnitOthersGroup').style.display='block';document.getElementById('referringUnitOthers').value=savedUnit.replace('OTHERS: ','').replace('OTHERS','');}
  else{document.getElementById('referringUnit').value='OTHERS';document.getElementById('referringUnitOthersGroup').style.display='block';document.getElementById('referringUnitOthers').value=savedUnit;}
  var asstMap={'E-CLIP':'asst_eclip','FEA REMUNERATION':'asst_fea','LIVELIHOOD':'asst_livelihood','MEDICAL':'asst_medical','EDUCATIONAL':'asst_educational','ISSUANCE OF CREDENTIALS':'asst_credentials','PHILHEALTH':'asst_philhealth','ISSUANCE OF SAFE CONDUCT PASS':'asst_safeconduct','APPLIED FOR AMNESTY':'asst_amnesty'};
  Object.values(asstMap).forEach(function(id){document.getElementById(id).checked=false;});
  document.getElementById('asst_others').checked=false; document.getElementById('asst_others_spec').style.display='none'; document.getElementById('asst_others_spec').value='';
  (r.assistance||[]).forEach(function(a){if(asstMap[a])document.getElementById(asstMap[a]).checked=true;else if(a.indexOf('OTHERS')===0){document.getElementById('asst_others').checked=true;document.getElementById('asst_others_spec').style.display='inline-block';document.getElementById('asst_others_spec').value=a.replace('OTHERS: ','').replace('OTHERS','');}});
  validIdSlots=(r.validIds||[]).map(function(v){return{id:genId(),dataUrl:v.url||v.dataUrl,fileName:v.fileName};});
  renderValidIdSlots();
  if(r.japic){japicData=r.japic;var jp=document.getElementById('japicPreview');document.getElementById('japicPlaceholder').style.display='none';jp.style.display='block';jp.innerHTML=r.japic.type==='pdf'?'<div class="japic-file-info"><span style="font-size:36px">&#128196;</span><span class="file-name">'+r.japic.fileName+'</span></div>':'<div class="japic-file-info"><img src="'+(r.japic.url||r.japic.dataUrl)+'" alt="JAPIC"/><span class="file-name">'+r.japic.fileName+'</span></div>';document.getElementById('removeJapicBtn').style.display='inline-block';}else{removeJapic();}
  if(r.socialCaseReport&&typeof r.socialCaseReport==='object'){socialCaseData=r.socialCaseReport;var sc=document.getElementById('socialCasePreview');document.getElementById('socialCasePlaceholder').style.display='none';sc.style.display='block';sc.innerHTML=r.socialCaseReport.type==='image'?'<div class="japic-file-info"><img src="'+(r.socialCaseReport.url||r.socialCaseReport.dataUrl)+'" alt="Report"/><span class="file-name">'+r.socialCaseReport.fileName+'</span></div>':'<div class="japic-file-info"><span style="font-size:36px">&#128196;</span><span class="file-name">'+r.socialCaseReport.fileName+'</span></div>';document.getElementById('removeSocialCaseBtn').style.display='inline-block';}else{removeSocialCase();}
  showPage('addRecord'); document.getElementById('formTitle').textContent='EDIT RECORD';
}

// -- VIEW RECORD MODAL ----------------------------------------
function getRecordById(id) { for(var i=0;i<allRecordsCache.length;i++){if(allRecordsCache[i].id===id)return allRecordsCache[i];}return null; }

function buildRecordDetailHtml(r, forPrint) {
  forPrint=!!forPrint;
  var age=calcAgeFromDob(r.dob);
  var photoSrc=r.idPhoto||(r.idPhotoUrl)||null;
  var photoHtml=photoSrc
    ?'<img src="'+photoSrc+'" class="modal-id-photo" alt="ID Photo"/>'
    :'<img src="BHB.png" class="modal-id-photo" alt="ID Photo"/>';
  var tagsSex=r.sex?'<span class="tag tag-blue">'+r.sex+'</span>':'';
  var tagsCivil=r.civilStatus?'<span class="tag tag-blue">'+r.civilStatus+'</span>':'';
  var tribalDisplay=normalizeTribalGroup(r.tribalGroup)||r.tribalGroup;
  var tagsTribal=tribalDisplay?'<span class="tag tag-blue">'+tribalDisplay+'</span>':'';
  var asstHtml=(r.assistance&&r.assistance.length)?r.assistance.map(function(a){return'<span class="tag tag-green">'+a+'</span>';}).join(''):'-';
  var sectorHtml=(r.sector&&r.sector.length)?r.sector.map(function(s){return'<span class="tag tag-blue">'+s+'</span>';}).join(''):'-';
  if(r.sector&&r.sector.indexOf('PWD')!==-1&&r.pwdDisability)sectorHtml+='<div class="pwd-disability-note">DISABILITY: '+r.pwdDisability+'</div>';

  function attachCard(src, fileName, type) {
    if (forPrint) {
      // For print: show ON-FILE status, not the actual image
      return '<span class="on-file-badge">&#10003; ON-FILE — ' + (fileName || 'FILE') + '</span>';
    }
    return '<div class="attach-card attach-card--wide">'+(type==='image'?'<img src="'+src+'" class="attach-preview-img" style="max-height:90px;border-radius:4px;border:1px solid var(--border)" onclick="openAttachment(\''+src+'\',\''+fileName+'\')" alt="'+fileName+'"/>':'<div class="attach-file-icon">&#128196;</div>')+'<div class="attach-name">'+fileName+'</div><div class="attach-actions">'+(type==='image'?'<button class="btn-attach-view" onclick="openAttachment(\''+src+'\',\''+fileName+'\')">&#128065; VIEW</button>':'')+'<button class="btn-attach-dl" onclick="downloadAttachment(\''+src+'\',\''+fileName+'\')">&#11015; DOWNLOAD</button></div></div>';
  }

  var validIdHtml = (r.validIds && r.validIds.length)
    ? (forPrint
        ? r.validIds.map(function(v, i) {
            return '<span class="on-file-badge">&#10003; ON-FILE — ' + (v.fileName || ('VALID ID ' + (i+1))) + '</span>';
          }).join(' ')
        : r.validIds.map(function(v) {
            var src = v.url || v.dataUrl;
            return '<div class="attach-card"><img src="'+src+'" class="valid-id-thumb attach-preview-img" onclick="openAttachment(\''+src+'\',\''+v.fileName+'\')" alt="'+v.fileName+'"/><div class="attach-name">'+v.fileName+'</div><div class="attach-actions"><button class="btn-attach-view" onclick="openAttachment(\''+src+'\',\''+v.fileName+'\')">&#128065; VIEW</button><button class="btn-attach-dl" onclick="downloadAttachment(\''+src+'\',\''+v.fileName+'\')">&#11015; DOWNLOAD</button></div></div>';
          }).join('')
      )
    : '<span class="empty-upload">NONE UPLOADED</span>';
  var japicHtml = r.japic
    ? attachCard(r.japic.url||r.japic.dataUrl, r.japic.fileName, r.japic.type)
    : '<span class="empty-upload">NONE UPLOADED</span>';
  var sc = r.socialCaseReport;
  var scHtml = sc
    ? (typeof sc === 'string' ? (forPrint ? '<span class="on-file-badge">&#10003; ON-FILE</span>' : '<span>'+sc+'</span>') : attachCard(sc.url||sc.dataUrl, sc.fileName, sc.type))
    : '<span class="empty-upload">NONE UPLOADED</span>';
  var createdStr=r.createdAt?new Date(r.createdAt).toLocaleString('en-PH'):'-';
  var metaStyle=forPrint?'class="record-meta"':'style="font-size:0.65rem;color:var(--text3);margin-top:16px;border-top:1px solid var(--border);padding-top:10px"';

  return '<div class="modal-top-row"><div>'+photoHtml+'</div><div class="modal-top-info"><div class="modal-full-name">'+r.lastName+', '+r.firstName+' '+(r.middleName||'')+'</div><div class="modal-alias">'+(r.alias?'ALIAS: '+r.alias:'')+'</div><div style="margin-top:8px">'+tagsSex+tagsCivil+tagsTribal+'</div></div></div>' +
    '<div class="modal-section"><div class="modal-section-title">PART I - PERSONAL DETAILS</div><div class="modal-record-grid">' +
    '<div class="modal-field"><div class="modal-field-label">DATE OF BIRTH</div><div class="modal-field-value">'+formatDate(r.dob)+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">AGE</div><div class="modal-field-value">'+(age||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">SEX</div><div class="modal-field-value">'+(r.sex||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">CIVIL STATUS</div><div class="modal-field-value">'+(r.civilStatus||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">TRIBAL GROUP</div><div class="modal-field-value">'+(tribalDisplay||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">RELIGION</div><div class="modal-field-value">'+(r.religion||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">CONTACT</div><div class="modal-field-value">'+(r.contactNumber||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">MEDICAL</div><div class="modal-field-value">'+(r.medicalCondition||'-')+(r.medicalCondition==='YES'&&r.medicalConditionSpec?' — '+r.medicalConditionSpec:'')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">4Ps</div><div class="modal-field-value">'+(r.fourPs||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">ADDRESS</div><div class="modal-field-value">'+(buildFullAddress(r.addressBarangay||r.address,r.addressMunicipality,r.addressProvince)||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">SECTOR</div><div class="modal-field-value">'+sectorHtml+'</div></div>' +
    '</div></div>' +
    '<div class="modal-section"><div class="modal-section-title">PART II - HISTORY IN THE MOVEMENT</div><div class="modal-record-grid">' +
    '<div class="modal-field"><div class="modal-field-label">UNIT</div><div class="modal-field-value">'+(r.unit||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">POSITION</div><div class="modal-field-value">'+(r.position||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">MEMBERSHIP TYPE</div><div class="modal-field-value">'+(r.membershipType||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">AREA OF OPERATION</div><div class="modal-field-value">'+(r.areaOfOperation||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">YEARS IN MOVEMENT</div><div class="modal-field-value">'+(r.yearsInMovement||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">DATE SURRENDERED</div><div class="modal-field-value">'+formatDate(r.dateSurrendered)+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">PENDING CASE</div><div class="modal-field-value">'+(r.pendingCase||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">REFERRING UNIT</div><div class="modal-field-value">'+(r.referringUnit||'-')+'</div></div>' +
    '<div class="modal-field" style="grid-column:1/-1"><div class="modal-field-label">REMARKS</div><div class="modal-field-value">'+(r.remarks||'-')+'</div></div>' +
    '</div></div>' +
    '<div class="modal-section"><div class="modal-section-title">PART III - REINTEGRATION</div><div class="modal-field"><div class="modal-field-label">ASSISTANCE PROVIDED</div><div class="modal-field-value" style="margin-top:6px">'+asstHtml+'</div></div><div class="modal-field" style="margin-top:12px"><div class="modal-field-label">VALID IDs</div><div class="valid-id-thumbs">'+validIdHtml+'</div></div></div>' +
    '<div class="modal-section"><div class="modal-section-title">PART IV - SOCIAL CASE PROFILE</div><div class="modal-field"><div class="modal-field-label">JAPIC CERTIFICATE</div><div class="modal-field-value" style="margin-top:6px">'+japicHtml+'</div></div><div class="modal-field" style="margin-top:12px"><div class="modal-field-label">SOCIAL CASE STUDY REPORT</div><div class="modal-field-value" style="margin-top:6px">'+scHtml+'</div></div></div>' +
    '<div '+metaStyle+'>RECORD ID: '+r.id+' &nbsp;|&nbsp; CREATED BY: '+(r.createdBy||'-')+' &nbsp;|&nbsp; CREATED: '+createdStr+'</div>';
}

function viewRecord(id) {
  var r=getRecordById(id); if(!r) return;
  viewingRecordId=id;
  document.getElementById('modalContent').innerHTML=buildRecordDetailHtml(r,false);
  document.getElementById('viewModal').classList.remove('hidden');
}
function closeModal() { document.getElementById('viewModal').classList.add('hidden'); }
function editFromModal() { closeModal(); editRecord(viewingRecordId); }

function printRecord(id) {
  id=id||viewingRecordId; var r=getRecordById(id); if(!r){showToast('RECORD NOT FOUND','error');return;}
  var name=r.lastName+', '+r.firstName, printed=new Date().toLocaleString('en-PH');
  var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';
  var html='<!DOCTYPE html><html><head><meta charset="UTF-8"><title></title><style>'+PRINT_RECORD_STYLES+CONFIDENTIAL_WATERMARK_STYLE+'</style></head><body><div class="confidential-watermark">CONFIDENTIAL</div><div class="print-header"><h1>FORMER REBELS DATABASE MANAGEMENT SYSTEM</h1><p>RECORD PRINTOUT</p><p>Printed: '+printed+'</p><p>Printed by: '+printedBy+'</p></div>'+buildRecordDetailHtml(r,true)+'</body></html>';
  var w=window.open('','_blank');if(!w){showToast('ALLOW POPUPS TO PRINT','error');return;}
  w.document.open();w.document.write(html);w.document.close();w.focus();setTimeout(function(){w.print();},350);
}

// -- ATTACHMENT HELPERS ---------------------------------------
function openAttachment(src, fileName) {
  var w=window.open('','_blank'); if(!w){showToast('ALLOW POPUPS TO VIEW','error');return;}
  var ext=fileName.split('.').pop().toLowerCase();
  if(ext==='pdf'){w.document.write('<html><body style="margin:0"><embed src="'+src+'" type="application/pdf" width="100%" height="100%"/></body></html>');}
  else{w.document.write('<html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh"><img src="'+src+'" style="max-width:100%;max-height:100vh;object-fit:contain" alt="'+fileName+'"/></body></html>');}
  w.document.close();
}
function downloadAttachment(src, fileName) {
  // For Firebase Storage URLs, open in new tab (direct download may be blocked)
  if(src.startsWith('https://firebasestorage')) { window.open(src,'_blank'); return; }
  var a=document.createElement('a'); a.href=src; a.download=fileName; a.click();
}

// -- DELETE ---------------------------------------------------
function promptDelete(id) { deleteTargetId=id; document.getElementById('deleteModal').classList.remove('hidden'); }
function closeDeleteModal() { deleteTargetId=null; document.getElementById('deleteModal').classList.add('hidden'); }
function confirmDelete() {
  if(!deleteTargetId) return;
  dbDelete(deleteTargetId).then(function() {
    closeDeleteModal(); showToast('RECORD DELETED','error');
    dbGetAll().then(function(records){allRecordsCache=records;renderRecords(records,document.getElementById('searchInput').value);});
  }).catch(function(err){showToast('DELETE FAILED: '+err.message,'error');});
}

// -- IMPORT CSV -----------------------------------------------
function parseCSVLine(line) {
  var result=[],cur='',inQuote=false;
  for(var i=0;i<line.length;i++){var ch=line[i];if(inQuote){if(ch==='"'&&line[i+1]==='"'){cur+='"';i++;}else if(ch==='"'){inQuote=false;}else{cur+=ch;}}else{if(ch==='"'){inQuote=true;}else if(ch===','){result.push(cur);cur='';}else{cur+=ch;}}}
  result.push(cur); return result;
}

function importCSVFile(event) {
  var file=event.target.files[0]; if(!file) return;
  var reader=new FileReader();
  reader.onload=function(e){
    var text=e.target.result, lines=text.split(/\r?\n/).filter(function(l){return l.trim();});
    if(lines.length<2){showToast('CSV IS EMPTY OR INVALID','error');return;}
    var headers=parseCSVLine(lines[0]), idx={};
    headers.forEach(function(h,i){idx[h.trim()]=i;});
    var parsed=[];
    for(var r=1;r<lines.length;r++){
      var cols=parseCSVLine(lines[r]);
      var col=function(name){return(cols[idx[name]]||'').trim();};
      var sectorList=col('SECTOR')?col('SECTOR').split(';').map(function(s){return s.trim();}).filter(Boolean):[];
      var asstList=col('ASSISTANCE PROVIDED')?col('ASSISTANCE PROVIDED').split(';').map(function(s){return s.trim();}).filter(Boolean):[];
      parsed.push({id:col('ID')||genId(),lastName:col('LAST NAME'),firstName:col('FIRST NAME'),middleName:col('MIDDLE NAME'),alias:col('ALIAS'),dob:col('DATE OF BIRTH'),sex:col('SEX'),civilStatus:col('CIVIL STATUS'),tribalGroup:col('TRIBAL GROUP'),religion:col('RELIGION'),contactNumber:col('CONTACT NUMBER'),medicalCondition:col('MEDICAL CONDITION'),medicalConditionSpec:col('MEDICAL CONDITION SPECIFY'),fourPs:col('4Ps'),pwdDisability:col('PWD DISABILITY'),addressBarangay:col('BARANGAY'),address:col('BARANGAY'),addressMunicipality:col('MUNICIPALITY'),addressProvince:col('PROVINCE')||'OCCIDENTAL MINDORO',sector:sectorList,unit:col('UNIT'),position:col('POSITION'),membershipType:col('MEMBERSHIP TYPE'),areaOfOperation:col('AREA OF OPERATION'),yearsInMovement:col('YEARS IN MOVEMENT'),dateSurrendered:col('DATE SURRENDERED'),pendingCase:col('PENDING CASE'),referringUnit:col('REFERRING UNIT'),assistance:asstList,validIds:[],idPhoto:null,japic:null,socialCaseReport:col('SOCIAL CASE REPORT FILE')?{fileName:col('SOCIAL CASE REPORT FILE'),url:null,type:'doc'}:null,createdBy:col('CREATED BY')||'ADMIN',createdAt:col('CREATED AT')||new Date().toISOString(),updatedAt:new Date().toISOString()});
    }
    if(!parsed.length){showToast('NO RECORDS FOUND IN CSV','error');return;}
    showToast('IMPORTING '+parsed.length+' RECORDS...','info');
    dbGetAll().then(function(existing){
      var existingIds={};existing.forEach(function(r){existingIds[r.id]=true;});
      var toImport=parsed.filter(function(r){return!existingIds[r.id];}), skipped=parsed.length-toImport.length;
      if(!toImport.length){showToast('ALL RECORDS ALREADY EXIST — NOTHING IMPORTED','info');return;}
      Promise.all(toImport.map(function(r){return dbPut(r);})).then(function(){
        allRecordsCache=[];
        var msg=toImport.length+' RECORDS IMPORTED SUCCESSFULLY';
        if(skipped>0)msg+=' ('+skipped+' SKIPPED)';
        showToast(msg,'success'); showPage('records');
      }).catch(function(err){showToast('IMPORT ERROR: '+err.message,'error');});
    });
  };
  reader.readAsText(file); event.target.value='';
}

// -- EXPORT CSV -----------------------------------------------
function exportCSV() {
  dbGetAll().then(function(records){
    if(!records.length){showToast('NO RECORDS TO EXPORT','info');return;}
    var headers=['ID','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS','DATE OF BIRTH','AGE','SEX','CIVIL STATUS','TRIBAL GROUP','RELIGION','CONTACT NUMBER','MEDICAL CONDITION','MEDICAL CONDITION SPECIFY','4Ps','PWD DISABILITY','BARANGAY','MUNICIPALITY','PROVINCE','SECTOR','UNIT','POSITION','MEMBERSHIP TYPE','AREA OF OPERATION','YEARS IN MOVEMENT','DATE SURRENDERED','PENDING CASE','REFERRING UNIT','REMARKS','ASSISTANCE PROVIDED','SOCIAL CASE REPORT FILE','CREATED BY','CREATED AT'];
    var rows=records.map(function(r){return[r.id,r.lastName,r.firstName,r.middleName,r.alias,r.dob,calcAgeFromDob(r.dob),r.sex,r.civilStatus,normalizeTribalGroup(r.tribalGroup)||r.tribalGroup,r.religion,r.contactNumber,r.medicalCondition,r.medicalConditionSpec,r.fourPs,r.pwdDisability,r.addressBarangay||r.address,r.addressMunicipality||'',r.addressProvince||'OCCIDENTAL MINDORO',(r.sector||[]).join('; '),r.unit,r.position,r.membershipType,r.areaOfOperation,r.yearsInMovement,r.dateSurrendered,r.pendingCase,r.referringUnit,r.remarks||'',(r.assistance||[]).join('; '),r.socialCaseReport?(typeof r.socialCaseReport==='object'?r.socialCaseReport.fileName:r.socialCaseReport):'',r.createdBy,r.createdAt?new Date(r.createdAt).toLocaleString('en-PH'):''].map(function(v){return'"'+String(v||'').replace(/"/g,'""')+'"';});});
    var csv=[headers.join(',')].concat(rows.map(function(r){return r.join(',');})).join('\n');
    var blob=new Blob([csv],{type:'text/csv'}), url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url; a.download='FR_DATABASE_'+new Date().toISOString().slice(0,10)+'.csv'; a.click(); URL.revokeObjectURL(url);
    showToast('CSV EXPORTED SUCCESSFULLY','success');
  });
}

// -- USER MANAGEMENT (Firebase Auth + Firestore) --------------
var editingUserId = null;

function renderUsers() {
  db.collection('users').get().then(function(snap) {
    var users = snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
    var operators = users.filter(function(u) { return u.role === 'OPERATOR'; });
    document.getElementById('operatorCount').textContent = operators.length;
    document.getElementById('usersList').innerHTML = users.map(function(u) {
      var isMe = currentUser && u.id === currentUser.uid;
      var isAdmin = u.role === 'ADMIN';
      var actions = !isAdmin
        ? '<button class="btn-edit" onclick="startEditUser(\'' + u.id + '\')" title="Edit">&#9998;</button>' +
          '<button class="btn-secondary" style="padding:4px 8px;font-size:0.68rem" onclick="sendPasswordReset(\'' + (u.email||'') + '\')" title="Send Password Reset Email">&#128274; RESET PW</button>' +
          '<button class="btn-del" onclick="deleteUser(\'' + u.id + '\')" title="Delete">&#128465;</button>'
        : '<span style="font-size:0.65rem;color:var(--text3)">PROTECTED</span>';
      return '<div class="user-card"><div class="user-card-info">' +
        '<div class="user-card-name">' + u.username +
          (isMe ? ' <span style="color:var(--accent);font-size:0.65rem">(YOU)</span>' : '') + '</div>' +
        '<div class="user-card-role ' + (isAdmin ? 'role-admin' : 'role-operator') + '">' + u.role + '</div>' +
        '<div style="font-size:0.62rem;color:var(--text3);margin-top:2px">&#128231; ' + (u.email || '—') + '</div>' +
        '</div><div class="user-card-actions" style="display:flex;gap:4px;flex-wrap:wrap">' + actions + '</div></div>';
    }).join('');
    var addBtn = document.querySelector('.users-form-panel .btn-primary');
    if (addBtn && !editingUserId) addBtn.disabled = operators.length >= 5;
  }).catch(function(err) { showToast('ERROR LOADING USERS: ' + err.message, 'error'); });
}

function sendPasswordReset(email) {
  if (!email) { showToast('NO EMAIL ASSOCIATED WITH THIS ACCOUNT', 'error'); return; }
  auth.sendPasswordResetEmail(email).then(function() {
    showToast('PASSWORD RESET EMAIL SENT TO: ' + email, 'success');
  }).catch(function(err) {
    showToast('RESET FAILED: ' + err.message, 'error');
  });
}

function startEditUser(id) {
  db.collection('users').doc(id).get().then(function(doc) {
    if (!doc.exists) return;
    var u = doc.data();
    editingUserId = id;
    document.getElementById('userFormTitle').textContent = 'EDIT OPERATOR';
    document.getElementById('newUsername').value = u.username || '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    document.getElementById('userFormError').textContent = '';
  });
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
  if (!currentUser || currentUser.role !== 'ADMIN') { showToast('ACCESS DENIED', 'error'); return; }
  var username = document.getElementById('newUsername').value.trim().toUpperCase();
  var password = document.getElementById('newPassword').value;
  var confirm  = document.getElementById('confirmPassword').value;
  var errEl    = document.getElementById('userFormError');
  if (!username) { errEl.textContent = 'USERNAME IS REQUIRED.'; return; }
  if (!editingUserId && !password) { errEl.textContent = 'PASSWORD IS REQUIRED.'; return; }
  if (password && password !== confirm) { errEl.textContent = 'PASSWORDS DO NOT MATCH.'; return; }
  if (password && password.length < 6) { errEl.textContent = 'PASSWORD MUST BE AT LEAST 6 CHARACTERS.'; return; }

  if (editingUserId) {
    db.collection('users').doc(editingUserId).update({ username: username }).then(function() {
      showToast('OPERATOR UPDATED', 'success');
      cancelUserEdit(); renderUsers();
    }).catch(function(err) { errEl.textContent = 'ERROR: ' + err.message; });
    return;
  }

  var email = username.toLowerCase() + '@frdb.local';
  db.collection('users').where('role', '==', 'OPERATOR').get().then(function(snap) {
    if (snap.size >= 5) { errEl.textContent = 'MAXIMUM 5 OPERATORS ALLOWED.'; return; }
    errEl.textContent = 'CREATING ACCOUNT IN FIREBASE...';
    // Use secondary app instance so admin session is not interrupted
    var secondaryApp;
    try { secondaryApp = firebase.app('secondary'); }
    catch(e) { secondaryApp = firebase.initializeApp(firebaseConfig, 'secondary'); }
    var secondaryAuth = secondaryApp.auth();
    secondaryAuth.createUserWithEmailAndPassword(email, password).then(function(cred) {
      var newUid = cred.user.uid;
      secondaryAuth.signOut();
      return db.collection('users').doc(newUid).set({
        username: username,
        role:     'OPERATOR',
        email:    email,
        uid:      newUid,
        createdAt: new Date().toISOString()
      });
    }).then(function() {
      errEl.textContent = '';
      showToast('OPERATOR ' + username + ' ADDED — LOGIN: ' + email, 'success');
      cancelUserEdit(); renderUsers();
    }).catch(function(err) {
      if (err.code === 'auth/email-already-in-use') errEl.textContent = 'USERNAME ALREADY EXISTS IN FIREBASE AUTH.';
      else errEl.textContent = 'ERROR: ' + err.message;
    });
  }).catch(function(err) { errEl.textContent = 'ERROR: ' + err.message; });
}

function deleteUser(id) {
  if (!currentUser || currentUser.role !== 'ADMIN') { showToast('ACCESS DENIED', 'error'); return; }
  if (!confirm('DELETE THIS OPERATOR?\n\nThis removes their access from the system.\nTHIS CANNOT BE UNDONE.')) return;
  db.collection('users').doc(id).delete().then(function() {
    showToast('OPERATOR REMOVED', 'error'); renderUsers();
  }).catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- CHANGE ADMIN PASSWORD ------------------------------------
function changeAdminPassword() {
  if (!currentUser || currentUser.role !== 'ADMIN') { showToast('ACCESS DENIED', 'error'); return; }
  var currentPw=document.getElementById('adminCurrentPw').value;
  var newPw=document.getElementById('adminNewPw').value;
  var confirmPw=document.getElementById('adminConfirmPw').value;
  var errEl=document.getElementById('adminPwError');
  errEl.textContent='';
  if(!currentPw||!newPw||!confirmPw){errEl.textContent='ALL FIELDS ARE REQUIRED.';return;}
  if(newPw.length<6){errEl.textContent='NEW PASSWORD MUST BE AT LEAST 6 CHARACTERS.';return;}
  if(newPw!==confirmPw){errEl.textContent='NEW PASSWORDS DO NOT MATCH.';return;}
  var user=auth.currentUser;
  var credential=firebase.auth.EmailAuthProvider.credential(user.email,currentPw);
  user.reauthenticateWithCredential(credential).then(function(){
    return user.updatePassword(newPw);
  }).then(function(){
    document.getElementById('adminCurrentPw').value=''; document.getElementById('adminNewPw').value=''; document.getElementById('adminConfirmPw').value='';
    showToast('ADMIN PASSWORD UPDATED SUCCESSFULLY','success');
  }).catch(function(err){
    if(err.code==='auth/wrong-password')errEl.textContent='CURRENT PASSWORD IS INCORRECT.';
    else errEl.textContent='ERROR: '+err.message;
  });
}

// -- MODAL OVERLAY CLOSE --------------------------------------
document.getElementById('viewModal').addEventListener('click',function(e){if(e.target===this)closeModal();});
document.getElementById('deleteModal').addEventListener('click',function(e){if(e.target===this)closeDeleteModal();});
document.getElementById('cameraModal').addEventListener('click',function(e){if(e.target===this)closeCamera();});

// -- IDLE LOGOUT (3 minutes) ----------------------------------
var IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
var idleTimer = null;

function resetIdleTimer() {
  if (!currentUser) return; // only track when logged in
  clearTimeout(idleTimer);
  idleTimer = setTimeout(function() {
    if (!currentUser) return;
    showToast('SESSION EXPIRED — LOGGED OUT DUE TO INACTIVITY', 'error');
    setTimeout(function() { doLogout(); }, 1500);
  }, IDLE_TIMEOUT_MS);
}

// Listen to all user activity events
['mousemove','mousedown','keydown','touchstart','scroll','click'].forEach(function(evt) {
  document.addEventListener(evt, resetIdleTimer, { passive: true });
});

// -- BOOT (Firebase Auth state) -------------------------------
auth.onAuthStateChanged(function(user) {
  if (user) {
    if (!currentUser) {
      // Determine role by email — only admin@frdb.local is ADMIN
      var defaultRole = user.email === 'admin@frdb.local' ? 'ADMIN' : 'OPERATOR';
      currentUser = {
        uid:      user.uid,
        email:    user.email,
        username: user.email.split('@')[0].toUpperCase(),
        role:     defaultRole
      };
      // Try to enrich with Firestore profile
      db.collection('users').doc(user.uid).get()
        .then(function(doc) {
          if (doc.exists) {
            var p = doc.data();
            currentUser.username = p.username || currentUser.username;
            // Only trust Firestore role if it matches the email-based rule
            var firestoreRole = p.role || defaultRole;
            currentUser.role = (user.email === 'admin@frdb.local') ? 'ADMIN' : firestoreRole === 'ADMIN' ? 'OPERATOR' : firestoreRole;
            document.getElementById('sidebarUsername').textContent = currentUser.username;
            document.getElementById('sidebarRole').textContent     = currentUser.role;
            document.getElementById('topbarUser').textContent      = currentUser.username + ' (' + currentUser.role + ')';
            // Update admin-only nav visibility based on confirmed role
            document.querySelectorAll('.admin-only').forEach(function(el) {
              el.style.display = currentUser.role === 'ADMIN' ? 'flex' : 'none';
            });
          }
        })
        .catch(function(err) {
          console.warn('[FRDB] Could not load user profile:', err.code);
        });
      onLoginSuccess();
    }
  }
});
