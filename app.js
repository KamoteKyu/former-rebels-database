/* ============================================================
   FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM - app.js
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

// Convert a Firestore REST API field value to a plain JS value
function fsValueToJs(val) {
  if (!val) return null;
  if (val.stringValue  !== undefined) return val.stringValue;
  if (val.integerValue !== undefined) return parseInt(val.integerValue, 10);
  if (val.doubleValue  !== undefined) return parseFloat(val.doubleValue);
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.nullValue    !== undefined) return null;
  if (val.timestampValue !== undefined) return val.timestampValue;
  if (val.arrayValue   !== undefined) {
    return (val.arrayValue.values || []).map(fsValueToJs);
  }
  if (val.mapValue !== undefined) {
    var obj = {};
    var fields = val.mapValue.fields || {};
    Object.keys(fields).forEach(function(k) { obj[k] = fsValueToJs(fields[k]); });
    return obj;
  }
  return null;
}

function sortDocs(docs) {
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
}

// Use Firestore REST API instead of the JS SDK WebChannel
// (WebChannel is broken in Electron 31 / Chromium 126+)
// Serves from allRecordsCache when available to avoid redundant reads.
function dbGetAll(forceRefresh) {
  if (!forceRefresh && allRecordsCache && allRecordsCache.length > 0) {
    return Promise.resolve(allRecordsCache.slice());
  }
  return waitForAuth().then(function() {
    return firebase.auth().currentUser.getIdToken().then(function(token) {
      var base = 'https://firestore.googleapis.com/v1/projects/' +
                 firebaseConfig.projectId + '/databases/(default)/documents/records';

      function fetchPage(url, collected) {
        return fetch(url, { headers: { 'Authorization': 'Bearer ' + token } })
          .then(function(r) {
            if (!r.ok) return r.text().then(function(t) { throw new Error('HTTP ' + r.status + ': ' + t); });
            return r.json();
          })
          .then(function(data) {
            var docs = (data.documents || []).map(function(d) {
              var id = d.name.split('/').pop();
              var rec = { id: id };
              Object.keys(d.fields || {}).forEach(function(k) {
                rec[k] = fsValueToJs(d.fields[k]);
              });
              return rec;
            });
            collected = collected.concat(docs);
            if (data.nextPageToken) {
              return fetchPage(base + '?pageSize=300&pageToken=' + encodeURIComponent(data.nextPageToken), collected);
            }
            var sorted = sortDocs(collected);
            allRecordsCache = sorted;
            return sorted.slice();
          });
      }
      return fetchPage(base + '?pageSize=300', []);
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
    showToast('ID PHOTO TOO LARGE - ENABLE FIREBASE STORAGE', 'error');
  }
  // Sanitize nested objects - Firestore rejects undefined values
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
  // Already a cloud URL - skip upload
  if (dataUrl.startsWith('https://')) return Promise.resolve(dataUrl);

  // Compress image first - reduces a 3MB photo to ~50-80KB
  return compressImage(dataUrl, maxSize || 800).then(function(compressed) {
    // Try Firebase Storage upload (fast if Storage is enabled)
    return new Promise(function(resolve) {
      var settled = false;
      var timer = setTimeout(function() {
        if (!settled) {
          settled = true;
          // Storage not available - use compressed base64 as fallback
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

  // ID Photo - compress harder (2x2 only needs 300px)
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
      // Already a clean object with cloud URL - ensure no dataUrl field
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
var SECTOR_IDS = ['sec_farmer','sec_fisherfolk','sec_women','sec_pwd','sec_youth','sec_senior','sec_solo_parent','sec_ip','sec_urban_poor','sec_others'];

// Returns the default civil status based on age
// 30+ ? COMMON-LAW, under 30 ? SINGLE
function defaultCivilStatus(dob) {
  if (!dob) return 'SINGLE'; // no DOB - default to SINGLE
  var age = parseInt(calcAgeFromDob(dob), 10);
  if (isNaN(age)) return 'SINGLE';
  return age >= 30 ? 'COMMON-LAW' : 'SINGLE';
}

function normalizeTribalGroup(val) {
  if (!val) return '';
  var v = val.toString().trim().toUpperCase();
  // Exact known aliases
  if (v === 'MANGYAN') return 'OTHERS';
  if (v === 'TAU-BUHID') return 'TAU-BUID';
  // Strip trailing " MANGYAN" suffix - e.g. "HANUNUO MANGYAN" ? "HANUNUO"
  // This covers IRAYA MANGYAN, ALANGAN MANGYAN, TADYAWAN MANGYAN, etc.
  var withoutMangyan = v.replace(/\s+MANGYAN$/, '').trim();
  if (withoutMangyan !== v && TRIBAL_GROUP_TYPES.indexOf(withoutMangyan) !== -1) {
    return withoutMangyan;
  }
  // Direct match
  return TRIBAL_GROUP_TYPES.indexOf(v) !== -1 ? v : '';
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
    // Three ascending notes: C5 ? E5 ? G5
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
    // Audio not available - silent fail
  }
}

function calcAge() {
  var dob = document.getElementById('dob').value;
  if (!dob) { document.getElementById('age').value = 'UNKNOWN'; syncSeniorCitizenSector(); return; }
  var today = new Date(), birth = new Date(dob);
  var age = today.getFullYear() - birth.getFullYear();
  var m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  document.getElementById('age').value = age >= 0 ? age : 'UNKNOWN';
  syncSeniorCitizenSector();
}

function calcAgeFromDob(dob) {
  if (!dob) return 'UNKNOWN';
  var today = new Date(), birth = new Date(dob);
  var age = today.getFullYear() - birth.getFullYear();
  var m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age >= 0 ? age : 'UNKNOWN';
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

  // Connection pre-check
  fetch('https://identitytoolkit.googleapis.com/', { method: 'HEAD', mode: 'no-cors' })
    .catch(function() {
      err.textContent = 'NO INTERNET CONNECTION - CANNOT REACH FIREBASE.';
    });

  auth.signInWithEmailAndPassword(email, p)
    .then(function(cred) {
      err.textContent = '';
      // Determine role by email - only admin@frdb.local is ADMIN
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
      } else if (e.code === 'auth/network-request-failed') {
        err.textContent = 'NETWORK ERROR - CHECK INTERNET CONNECTION. (' + e.code + ')';
      } else {
        err.textContent = 'LOGIN ERROR: ' + e.code + ' - ' + e.message;
      }
    });
}

function onLoginSuccess() {
  document.getElementById('loginScreen').classList.add('hidden');
  // Play maniacal laugh during Halloween season
  if (getCurrentHoliday() === 'halloween') playManiacalLaugh();
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
  clearTimeout(_undoExpireTimer);
  try { localStorage.removeItem('frdb-lastImportSnapshot'); } catch(e) {}
  auth.signOut().then(function() {
    currentUser = null;
    allRecordsCache = [];
    document.getElementById('mainApp').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
    applyHolidayTheme();
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
        var isQuota = err.message && err.message.indexOf('429') !== -1;
        if (isQuota) {
          showToast('FIREBASE DAILY QUOTA EXCEEDED - TRY AGAIN AFTER MIDNIGHT (PACIFIC TIME)', 'error');
        } else if (err.code === 'permission-denied') {
          showToast('FIRESTORE RULES BLOCKING READ', 'error');
        } else if (err.message === 'Not authenticated') {
          showToast('NOT LOGGED IN', 'error');
        } else if (err.code === 'unavailable' || (err.message && err.message.indexOf('10 seconds') !== -1)) {
          showToast('NO INTERNET CONNECTION - CHECK YOUR NETWORK AND RETRY', 'error');
        } else {
          showToast('ERROR LOADING DATA: ' + err.message, 'error');
        }
      });
  }
  if (page === 'records') {
    document.getElementById('recordsTableBody').innerHTML =
      '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--text3)">LOADING...</td></tr>';
    updateUndoImportBtn();
    dbGetAll().then(function(records) { allRecordsCache = records; renderRecords(records); })
      .catch(function(err) {
        console.error('[FRDB] dbGetAll error:', err.code, err.message);
        var isQuota   = err.message && err.message.indexOf('429') !== -1;
        var isOffline = err.code === 'unavailable' || (err.message && err.message.indexOf('10 seconds') !== -1);
        var msg, detail, retryCooldown;
        if (isQuota) {
          msg = 'FIREBASE DAILY QUOTA EXCEEDED';
          detail = 'The free daily read limit has been reached. The app will recover automatically after midnight Pacific Time (UTC-8). Do not keep retrying � each attempt uses more quota.';
          retryCooldown = 60;
        } else if (isOffline) {
          msg = 'NO INTERNET CONNECTION';
          detail = 'Check your network connection, then retry.';
          retryCooldown = 0;
        } else if (err.code === 'permission-denied') {
          msg = 'ACCESS DENIED - FIRESTORE RULES BLOCKING READ';
          detail = '';
          retryCooldown = 0;
        } else {
          msg = 'ERROR LOADING RECORDS';
          detail = err.message;
          retryCooldown = 0;
        }
        document.getElementById('recordsTableBody').innerHTML =
          '<tr><td colspan="10" style="text-align:center;padding:32px">' +
            '<div style="color:#f85149;font-weight:700;margin-bottom:10px;font-size:1rem">' + msg + '</div>' +
            (detail ? '<div style="color:var(--text3);font-size:0.78rem;margin-bottom:16px;max-width:480px;margin-left:auto;margin-right:auto;line-height:1.5">' + detail + '</div>' : '') +
            '<button id="recordsRetryBtn" class="btn-primary" onclick="recordsRetryClick()">' + (retryCooldown > 0 ? 'RETRY (WAIT ' + retryCooldown + 's)' : 'RETRY') + '</button>' +
          '</td></tr>';
        var retryBtn = document.getElementById('recordsRetryBtn');
        if (retryCooldown > 0 && retryBtn) {
          retryBtn.disabled = true; retryBtn.style.opacity = '0.5'; retryBtn.style.cursor = 'not-allowed';
          var _cd = retryCooldown;
          var _iv = setInterval(function() {
            _cd--;
            var b = document.getElementById('recordsRetryBtn');
            if (!b) { clearInterval(_iv); return; }
            if (_cd > 0) { b.textContent = 'RETRY (WAIT ' + _cd + 's)'; }
            else { clearInterval(_iv); b.disabled = false; b.style.opacity = ''; b.style.cursor = ''; b.textContent = 'RETRY'; }
          }, 1000);
        }
        if (isQuota) showToast('QUOTA EXCEEDED - WAIT UNTIL MIDNIGHT PACIFIC TIME', 'error');
        else if (isOffline) showToast('NO INTERNET - CHECK YOUR NETWORK AND RETRY', 'error');
        else showToast(msg, 'error');
      });
  }
  if (page === 'addRecord' && !editingRecordId) { resetForm(); document.getElementById('formTitle').textContent = 'ADD NEW RECORD'; }
  if (page === 'users') {
    if (!currentUser || currentUser.role !== 'ADMIN') {
      showToast('ACCESS DENIED - ADMIN ONLY', 'error');
      showPage('dashboard');
      return;
    }
    renderUsers();
  }
  if (window.innerWidth <= 900) document.getElementById('sidebar').classList.remove('open');
}

function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }

// Retry for records page - only allowed if button is not in cooldown
function recordsRetryClick() {
  var btn = document.getElementById('recordsRetryBtn');
  if (btn && btn.disabled) return;
  showPage('records');
}

// -- REPORT DROPDOWN ------------------------------------------
function toggleReportDropdown() {
  document.getElementById('reportDropdown').classList.toggle('open');
}
function closeReportDropdown() {
  document.getElementById('reportDropdown').classList.remove('open');
}

// -- CARD REPORT DROPDOWNS (generic) -------------------------
// All per-card dropdowns share these two helpers.
function toggleCardDropdown(id) {
  var el = document.getElementById(id);
  if (!el) return;
  var isOpen = el.classList.contains('open');
  // Close every open card dropdown first
  document.querySelectorAll('.report-dropdown.open').forEach(function(d) { d.classList.remove('open'); });
  if (!isOpen) el.classList.add('open');
}
function closeCardDropdown(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('open');
}
// Legacy aliases kept for the municipality dropdown already wired up
function toggleAddrReportDropdown() { toggleCardDropdown('addrReportDropdown'); }
function closeAddrReportDropdown()   { closeCardDropdown('addrReportDropdown'); }
// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  // Close all open report dropdowns when clicking outside any of them
  document.querySelectorAll('.report-dropdown.open').forEach(function(d) {
    if (!d.contains(e.target)) d.classList.remove('open');
  });
});

// -- NO E-CLIP WIDGET -----------------------------------------
function toggleNoEclipList(listId, badgeId) {
  var list  = document.getElementById(listId);
  var badge = document.getElementById(badgeId);
  var open  = list.style.display !== 'none';
  list.style.display  = open ? 'none' : 'flex';
  badge.style.borderRadius = open ? '20px' : '20px 20px 0 0';
  // Toggle chevron arrow on the parent header
  var header = list.previousElementSibling;
  if (header) {
    var arrow = header.querySelector('.no-eclip-arrow');
    if (arrow) arrow.style.transform = open ? 'rotate(0deg)' : 'rotate(180deg)';
  }
}

// Called when a status stat card is clicked - scrolls to widget and opens the list
function toggleStatusWidget(listId, badgeId) {
  // Close all status lists first, open the target one
  ['cannotLocateList','deceasedList','incarceratedList'].forEach(function(id) {
    var l = document.getElementById(id);
    var b = document.getElementById(id.replace('List','Badge'));
    if (l && id !== listId) { l.style.display = 'none'; if(b) b.style.borderRadius = '20px'; }
  });
  toggleNoEclipList(listId, badgeId);
  // Scroll the widget into view
  var widget = document.querySelector('.no-eclip-widget');
  if (widget) widget.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// -- MISSING FIELDS CHECK (global, reused by widget + print) -
function getMissingFieldsGlobal(r) {
  var missing = [];
  // Part I - Personal Details
  if (!r.lastName)                                         missing.push('LAST NAME');
  if (!r.firstName)                                        missing.push('FIRST NAME');
  if (!r.middleName)                                       missing.push('MIDDLE NAME');
  if (!r.sex)                                              missing.push('SEX');
  if (!r.civilStatus)                                      missing.push('CIVIL STATUS');
  if (!r.religion)                                         missing.push('RELIGION');
  if (!r.medicalCondition)                                 missing.push('MEDICAL CONDITION');
  if (!r.fourPs)                                           missing.push('4Ps');
  if (!r.addressBarangay && !r.address && !r.addressMunicipality && !r.addressProvince)
                                                           missing.push('ADDRESS');
  if (r.addressProvince !== 'OUTSIDE MINDORO') {
    if (r.addressProvince !== 'ORIENTAL MINDORO') {
      if (!r.addressBarangay && !r.address)                missing.push('BARANGAY');
    }
    if (!r.addressMunicipality)                            missing.push('MUNICIPALITY');
  }
  if (!r.addressProvince)                                  missing.push('PROVINCE');
  if (!r.tribalGroup)                                      missing.push('TRIBAL GROUP');
  if (!r.sector || r.sector.length === 0)                  missing.push('SECTOR');
  // Part II - Movement History
  if (!r.unit)                                             missing.push('UNIT');
  if (!r.position)                                         missing.push('POSITION');
  if (!r.membershipType)                                   missing.push('MEMBERSHIP TYPE');
  if (!r.areaOfOperation)                                  missing.push('AREA OF OPERATION');
  if (!r.yearsInMovement && r.yearsInMovement !== 0)       missing.push('YEARS IN MOVEMENT');
  if (!r.dateSurrendered)                                  missing.push('DATE SURRENDERED');
  if (!r.pendingCase)                                      missing.push('PENDING CASE');
  if (!r.referringUnit)                                    missing.push('REFERRING UNIT');
  return missing;
}

function renderNoEclipWidget(records) {
  // Group 1 - no e-clip at all (neither E-CLIP nor NOT QUALIFIED)
  var noEclip = records.filter(function(r) {
    var asst = r.assistance || [];
    return asst.indexOf('E-CLIP') === -1 && asst.indexOf('NOT QUALIFIED FOR E-CLIP') === -1;
  }).slice().sort(function(a, b) { return (a.lastName || '').localeCompare(b.lastName || ''); });

  // Group 2 - explicitly marked NOT QUALIFIED FOR E-CLIP
  var notQual = records.filter(function(r) {
    var asst = r.assistance || [];
    return asst.indexOf('NOT QUALIFIED FOR E-CLIP') !== -1;
  }).slice().sort(function(a, b) { return (a.lastName || '').localeCompare(b.lastName || ''); });

  // Group 3 - no JAPIC certificate on file
  var noJapic = records.filter(function(r) {
    return !r.japic || !(r.japic.url || r.japic.dataUrl || r.japic.fileName);
  }).slice().sort(function(a, b) { return (a.lastName || '').localeCompare(b.lastName || ''); });

  // Group 4 - incomplete required data - reuse global function
  function getMissingFields(r) { return getMissingFieldsGlobal(r); }
  var incomplete = records.filter(function(r) {
    return getMissingFields(r).length > 0;
  }).slice().sort(function(a, b) { return (a.lastName || '').localeCompare(b.lastName || ''); });

  // Badge counts
  document.getElementById('noEclipBadge').textContent    = noEclip.length    + ' PROFILE' + (noEclip.length    !== 1 ? 'S' : '');
  document.getElementById('notQualBadge').textContent    = notQual.length    + ' PROFILE' + (notQual.length    !== 1 ? 'S' : '');
  document.getElementById('noJapicBadge').textContent    = noJapic.length    + ' PROFILE' + (noJapic.length    !== 1 ? 'S' : '');
  document.getElementById('incompleteBadge').textContent = incomplete.length + ' PROFILE' + (incomplete.length !== 1 ? 'S' : '');

  // Status groups
  var cannotLocate = records.filter(function(r) { return r.recordStatus === 'CANNOT BE LOCATED'; })
    .slice().sort(function(a,b){return(a.lastName||'').localeCompare(b.lastName||'');});
  var deceased = records.filter(function(r) { return r.recordStatus === 'DECEASED'; })
    .slice().sort(function(a,b){return(a.lastName||'').localeCompare(b.lastName||'');});
  var incarcerated = records.filter(function(r) { return r.recordStatus === 'INCARCERATED'; })
    .slice().sort(function(a,b){return(a.lastName||'').localeCompare(b.lastName||'');});

  document.getElementById('cannotLocateBadge').textContent  = cannotLocate.length  + ' PROFILE' + (cannotLocate.length  !== 1 ? 'S' : '');
  document.getElementById('deceasedBadge').textContent      = deceased.length      + ' PROFILE' + (deceased.length      !== 1 ? 'S' : '');
  document.getElementById('incarceratedBadge').textContent  = incarcerated.length  + ' PROFILE' + (incarcerated.length  !== 1 ? 'S' : '');

  // Group 5 - no assistance at all
  var noAssistance = records.filter(function(r) {
    return !r.assistance || r.assistance.length === 0;
  }).slice().sort(function(a, b) { return (a.lastName || '').localeCompare(b.lastName || ''); });

  document.getElementById('noAssistanceBadge').textContent = noAssistance.length + ' PROFILE' + (noAssistance.length !== 1 ? 'S' : '');

  function buildItems(list, emptyMsg) {
    if (!list.length) return '<div class="no-eclip-empty">' + emptyMsg + '</div>';
    return list.map(function(r) {
      var photo = r.idPhoto ? r.idPhoto : 'BHB.png';
      var name  = r.lastName + ', ' + r.firstName + ' ' + (r.middleName || 'UNKNOWN');
      var unit  = r.unit || r.referringUnit || 'NO UNIT';
      return '<div class="no-eclip-item" onclick="viewRecord(\'' + r.id + '\')" title="CLICK TO VIEW PROFILE">' +
        '<img src="' + photo + '" alt=""/>' +
        '<div><div class="no-eclip-item-name">' + name + '</div>' +
        '<div class="no-eclip-item-unit">' + unit + '</div></div>' +
        '</div>';
    }).join('');
  }

  function buildIncompleteItems(list) {
    if (!list.length) return '<div class="no-eclip-empty">&#10003; ALL PROFILES HAVE COMPLETE REQUIRED DATA</div>';
    return list.map(function(r) {
      var photo   = r.idPhoto ? r.idPhoto : 'BHB.png';
      var name    = r.lastName + ', ' + r.firstName + ' ' + (r.middleName || 'UNKNOWN');
      var missing = getMissingFields(r);
      return '<div class="no-eclip-item no-eclip-item--incomplete" onclick="editRecord(\'' + r.id + '\')" title="CLICK TO EDIT AND COMPLETE PROFILE">' +
        '<img src="' + photo + '" alt=""/>' +
        '<div>' +
          '<div class="no-eclip-item-name">' + name + '</div>' +
          '<div class="no-eclip-item-missing">MISSING: ' + missing.join(', ') + '</div>' +
        '</div>' +
        '</div>';
    }).join('');
  }

  document.getElementById('noEclipList').innerHTML    = buildItems(noEclip,  '&#10003; ALL PROFILES HAVE E-CLIP OR NOT QUALIFIED STATUS');
  document.getElementById('notQualList').innerHTML    = buildItems(notQual,  'NO PROFILES MARKED AS NOT QUALIFIED FOR E-CLIP');
  document.getElementById('noJapicList').innerHTML    = buildItems(noJapic,  '&#10003; ALL PROFILES HAVE A JAPIC CERTIFICATE ON FILE');
  document.getElementById('incompleteList').innerHTML = buildIncompleteItems(incomplete);
  document.getElementById('cannotLocateList').innerHTML  = buildItems(cannotLocate,  '&#10003; NO PROFILES MARKED AS CANNOT BE LOCATED');
  document.getElementById('deceasedList').innerHTML      = buildItems(deceased,      '&#10003; NO PROFILES MARKED AS DECEASED');
  document.getElementById('incarceratedList').innerHTML  = buildItems(incarcerated,  '&#10003; NO PROFILES MARKED AS INCARCERATED');
  document.getElementById('noAssistanceList').innerHTML  = buildItems(noAssistance,  '&#10003; ALL PROFILES HAVE AT LEAST ONE ASSISTANCE RECORDED');
}

// -- RECENTLY IMPORTED/UPDATED WIDGET -------------------------
function renderRecentImportsWidget() {
  var el = document.getElementById('recentImportsList');
  var badge = document.getElementById('recentImportsBadge');
  if (!el || !badge) return;

  var entries = [];
  try { entries = JSON.parse(localStorage.getItem('frdb-recentImports') || '[]'); } catch(e) { entries = []; }

  // Most recent first
  entries = entries.slice().reverse();

  badge.textContent = entries.length + ' PROFILE' + (entries.length !== 1 ? 'S' : '');

  if (!entries.length) {
    el.innerHTML = '<div class="no-eclip-empty">NO RECENT IMPORTS</div>';
    return;
  }

  el.innerHTML = entries.map(function(e) {
    var r = null;
    for (var i = 0; i < allRecordsCache.length; i++) {
      if (allRecordsCache[i].id === e.id) { r = allRecordsCache[i]; break; }
    }
    var photo = r && r.idPhoto ? r.idPhoto : 'BHB.png';
    // Always use live record name if available ? never trust the stored string
    var displayName = r
      ? (r.lastName || '') + ', ' + (r.firstName || '') + (r.middleName ? ' ' + r.middleName : '')
      : e.name;
    var typeColor = e.type === 'NEW' ? '#3fb950' : '#d29922';
    var typeLabel = e.type === 'NEW' ? 'NEW' : 'UPDATED';
    var ts = e.timestamp ? new Date(e.timestamp).toLocaleString('en-PH', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
    return '<div class="no-eclip-item" onclick="viewRecord(\'' + e.id + '\')" title="CLICK TO VIEW PROFILE">' +
      '<img src="' + photo + '" alt=""/>' +
      '<div style="flex:1">' +
        '<div class="no-eclip-item-name">' + displayName + '</div>' +
        '<div class="no-eclip-item-unit">' +
          '<span style="color:' + typeColor + ';font-weight:700;margin-right:6px">' + typeLabel + '</span>' + ts +
        '</div>' +
      '</div>' +
      '<button onclick="event.stopPropagation();dismissRecentImport(\'' + e.id + '\')" ' +
        'style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:1rem;padding:4px 6px" title="DISMISS">&#10005;</button>' +
    '</div>';
  }).join('');
}

function dismissRecentImport(id) {
  try {
    var entries = JSON.parse(localStorage.getItem('frdb-recentImports') || '[]');
    entries = entries.filter(function(e) { return e.id !== id; });
    localStorage.setItem('frdb-recentImports', JSON.stringify(entries));
  } catch(ex) {}
  renderRecentImportsWidget();
}

function dismissAllRecentImports() {
  try { localStorage.setItem('frdb-recentImports', '[]'); } catch(ex) {}
  renderRecentImportsWidget();
}

// -- DASHBOARD ------------------------------------------------
function renderDashboard(records) {
  var banner = document.getElementById('recoveryBanner');
  if (banner) banner.style.display = 'none';
  document.getElementById('statTotal').textContent      = records.length;
  document.getElementById('statMale').textContent       = records.filter(function(r) { return r.sex === 'MALE'; }).length;
  document.getElementById('statFemale').textContent     = records.filter(function(r) { return r.sex === 'FEMALE'; }).length;
  document.getElementById('statRegularNPA').textContent = records.filter(function(r) { return r.membershipType === 'REGULAR NPA'; }).length;
  document.getElementById('statMilisyang').textContent  = records.filter(function(r) { return r.membershipType === 'MILISYANG BAYAN'; }).length;
  document.getElementById('statCannotLocate').textContent  = records.filter(function(r) { return r.recordStatus === 'CANNOT BE LOCATED'; }).length;
  document.getElementById('statDeceased').textContent      = records.filter(function(r) { return r.recordStatus === 'DECEASED'; }).length;
  document.getElementById('statIncarcerated').textContent  = records.filter(function(r) { return r.recordStatus === 'INCARCERATED'; }).length;
  renderNoEclipWidget(records);
  renderRecentImportsWidget();
  renderAssistanceReport(records);
  renderMembershipReport(records);
  renderTribalReport(records);
  renderAgeReport(records);
  renderMunicipalityReport(records);
  render4PsReport(records);
  renderPhilhealthReport(records);
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
  // Firebase Storage - show record count as proxy, no quota API
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
  '.report-stat--warning{border-color:#9a6700;background:#fffbeb}' +
  '.report-stat--warning strong{color:#9a6700}' +
  '.report-stat--danger{border-color:#cf222e;background:#fff0f0}' +
  '.report-stat--danger strong{color:#cf222e}' +
  '.report-stat--purple{border-color:#7a43b6;background:#f8f0ff}' +
  '.report-stat--purple strong{color:#7a43b6}' +
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
    var body = '<div class="print-header"><h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1><p>DASHBOARD SUMMARY REPORT</p><p>Generated: ' + printed + '</p><p>Generated by: ' + generatedBy + '</p></div>' +
      buildDashboardReportHtml(records);
    openPrintDocument('FR Dashboard Report', body, REPORT_PRINT_STYLES);
    showToast('REPORT GENERATED', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT NO E-CLIP LIST -------------------------------------
function printNoEclipList() {
  function run(records) {
    var list = records.filter(function(r) {
      var asst = r.assistance || [];
      return asst.indexOf('E-CLIP') === -1 && asst.indexOf('NOT QUALIFIED FOR E-CLIP') === -1;
    }).sort(function(a, b) { return (a.lastName||'').localeCompare(b.lastName||''); });

    if (!list.length) { showToast('ALL PROFILES HAVE E-CLIP OR NOT QUALIFIED STATUS', 'success'); return; }

    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    var rows = list.map(function(r, i) {
      var age = calcAgeFromDob(r.dob);
      return '<tr>' +
        '<td style="text-align:center">' + (i + 1) + '</td>' +
        '<td><strong>' + (r.lastName||'') + ', ' + (r.firstName||'') + ' ' + (r.middleName || 'UNKNOWN') + '</strong></td>' +
        '<td>' + (r.alias||'-') + '</td>' +
        '<td style="text-align:center">' + (r.sex||'-') + '</td>' +
        '<td style="text-align:center">' + age + '</td>' +
        '<td>' + (r.referringUnit||'-') + '</td>' +
        '<td style="text-align:center">' + formatDate(r.dateSurrendered) + '</td>' +
        '<td>' + ((r.assistance||[]).join(', ')||'-') + '</td>' +
        '</tr>';
    }).join('');

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>PROFILES WITH NO E-CLIP</p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' +
      '<table class="report-table" style="width:100%;font-size:10px">' +
        '<thead><tr>' +
          '<th style="text-align:center;width:28px">#</th>' +
          '<th>FULL NAME</th><th>ALIAS</th>' +
          '<th style="text-align:center">SEX</th>' +
          '<th style="text-align:center">AGE</th>' +
          '<th>REFERRING UNIT</th>' +
          '<th style="text-align:center">DATE SURRENDERED</th>' +
          '<th>CURRENT ASSISTANCE</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td colspan="8" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
          'TOTAL: ' + list.length + ' PROFILE' + (list.length !== 1 ? 'S' : '') + ' WITHOUT E-CLIP' +
        '</td></tr></tfoot>' +
      '</table>';

    openPrintDocument('No E-CLIP List', body, REPORT_PRINT_STYLES);
    showToast('NO E-CLIP LIST GENERATED - ' + list.length + ' PROFILE(S)', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT NO JAPIC LIST --------------------------------------
function printNoJapicList() {
  function run(records) {
    var list = records.filter(function(r) {
      return !r.japic || !(r.japic.url || r.japic.dataUrl || r.japic.fileName);
    }).sort(function(a, b) { return (a.lastName||'').localeCompare(b.lastName||''); });

    if (!list.length) { showToast('ALL PROFILES HAVE JAPIC ON FILE', 'success'); return; }

    var printed    = new Date().toLocaleString('en-PH');
    var printedBy  = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    var rows = list.map(function(r, i) {
      var age = calcAgeFromDob(r.dob);
      return '<tr>' +
        '<td style="text-align:center">' + (i + 1) + '</td>' +
        '<td><strong>' + (r.lastName||'') + ', ' + (r.firstName||'') + '</strong>' + (r.middleName ? ' ' + r.middleName : '') + '</td>' +
        '<td>' + (r.alias||'-') + '</td>' +
        '<td style="text-align:center">' + (r.sex||'-') + '</td>' +
        '<td style="text-align:center">' + age + '</td>' +
        '<td>' + (r.referringUnit||'-') + '</td>' +
        '<td style="text-align:center">' + formatDate(r.dateSurrendered) + '</td>' +
        '</tr>';
    }).join('');

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>PROFILES WITH NO JAPIC CERTIFICATE ON FILE</p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' +
      '<table class="report-table" style="width:100%;font-size:10px">' +
        '<thead><tr>' +
          '<th style="text-align:center;width:28px">#</th>' +
          '<th>FULL NAME</th><th>ALIAS</th>' +
          '<th style="text-align:center">SEX</th>' +
          '<th style="text-align:center">AGE</th>' +
          '<th>REFERRING UNIT</th>' +
          '<th style="text-align:center">DATE SURRENDERED</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td colspan="7" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
          'TOTAL: ' + list.length + ' PROFILE' + (list.length !== 1 ? 'S' : '') + ' WITHOUT JAPIC' +
        '</td></tr></tfoot>' +
      '</table>';

    openPrintDocument('No JAPIC List', body, REPORT_PRINT_STYLES);
    showToast('NO JAPIC LIST GENERATED - ' + list.length + ' PROFILE(S)', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT WITH JAPIC LIST ------------------------------------
function printWithJapicList() {
  function run(records) {
    var list = records.filter(function(r) {
      return r.japic && (r.japic.url || r.japic.dataUrl || r.japic.fileName);
    }).sort(function(a, b) { return (a.lastName||'').localeCompare(b.lastName||''); });

    if (!list.length) { showToast('NO PROFILES WITH JAPIC ON FILE', 'info'); return; }

    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    var rows = list.map(function(r, i) {
      var age = calcAgeFromDob(r.dob);
      var japicFile = r.japic.fileName || 'ON FILE';
      return '<tr>' +
        '<td style="text-align:center">' + (i + 1) + '</td>' +
        '<td><strong>' + (r.lastName||'') + ', ' + (r.firstName||'') + '</strong>' + (r.middleName ? ' ' + r.middleName : '') + '</td>' +
        '<td>' + (r.alias||'-') + '</td>' +
        '<td style="text-align:center">' + (r.sex||'-') + '</td>' +
        '<td style="text-align:center">' + age + '</td>' +
        '<td>' + (r.referringUnit||'-') + '</td>' +
        '<td style="text-align:center">' + formatDate(r.dateSurrendered) + '</td>' +
        '<td style="text-align:center;color:#3fb950;font-weight:700">' + japicFile + '</td>' +
        '</tr>';
    }).join('');

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>PROFILES WITH JAPIC CERTIFICATE ON FILE</p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' +
      '<table class="report-table" style="width:100%;font-size:10px">' +
        '<thead><tr>' +
          '<th style="text-align:center;width:28px">#</th>' +
          '<th>FULL NAME</th><th>ALIAS</th>' +
          '<th style="text-align:center">SEX</th>' +
          '<th style="text-align:center">AGE</th>' +
          '<th>REFERRING UNIT</th>' +
          '<th style="text-align:center">DATE SURRENDERED</th>' +
          '<th style="text-align:center">JAPIC FILE</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td colspan="8" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
          'TOTAL: ' + list.length + ' PROFILE' + (list.length !== 1 ? 'S' : '') + ' WITH JAPIC ON FILE' +
        '</td></tr></tfoot>' +
      '</table>';

    openPrintDocument('With JAPIC List', body, REPORT_PRINT_STYLES);
    showToast('WITH JAPIC LIST GENERATED - ' + list.length + ' PROFILE(S)', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT INCOMPLETE DATA LIST --------------------------------
function printIncompleteList() {
  function run(records) {
    var list = records.filter(function(r) {
      return getMissingFieldsGlobal(r).length > 0;
    }).sort(function(a, b) { return (a.lastName||'').localeCompare(b.lastName||''); });

    if (!list.length) { showToast('ALL PROFILES HAVE COMPLETE DATA', 'success'); return; }

    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    var rows = list.map(function(r, i) {
      var missing = getMissingFieldsGlobal(r);
      return '<tr>' +
        '<td style="text-align:center">' + (i + 1) + '</td>' +
        '<td><strong>' + (r.lastName||'') + ', ' + (r.firstName||'') + '</strong>' + (r.middleName ? ' ' + r.middleName : '') + '</td>' +
        '<td>' + (r.referringUnit||'-') + '</td>' +
        '<td style="color:#cf222e;font-size:9px">' + missing.join(', ') + '</td>' +
        '</tr>';
    }).join('');

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>PROFILES WITH INCOMPLETE DATA</p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' +
      '<table class="report-table" style="width:100%;font-size:10px">' +
        '<thead><tr>' +
          '<th style="text-align:center;width:28px">#</th>' +
          '<th>FULL NAME</th>' +
          '<th>REFERRING UNIT</th>' +
          '<th style="color:#cf222e">MISSING FIELDS</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td colspan="4" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
          'TOTAL: ' + list.length + ' PROFILE' + (list.length !== 1 ? 'S' : '') + ' WITH INCOMPLETE DATA' +
        '</td></tr></tfoot>' +
      '</table>';

    openPrintDocument('Incomplete Data List', body, REPORT_PRINT_STYLES);
    showToast('INCOMPLETE DATA LIST GENERATED - ' + list.length + ' PROFILE(S)', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT NO ASSISTANCE LIST ---------------------------------
function printNoAssistanceList() {
  function run(records) {
    var list = records.filter(function(r) {
      return !r.assistance || r.assistance.length === 0;
    }).sort(function(a, b) { return (a.lastName||'').localeCompare(b.lastName||''); });

    if (!list.length) { showToast('ALL PROFILES HAVE AT LEAST ONE ASSISTANCE RECORDED', 'success'); return; }

    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    var rows = list.map(function(r, i) {
      var age = calcAgeFromDob(r.dob);
      var statusStyle = '';
      if (r.recordStatus === 'DECEASED')          statusStyle = 'color:#cf222e;font-weight:700';
      if (r.recordStatus === 'CANNOT BE LOCATED') statusStyle = 'color:#9a6700;font-weight:700';
      if (r.recordStatus === 'INCARCERATED')      statusStyle = 'color:#7a43b6;font-weight:700';
      return '<tr>' +
        '<td style="text-align:center">' + (i + 1) + '</td>' +
        '<td><strong>' + (r.lastName||'') + ', ' + (r.firstName||'') + '</strong>' + (r.middleName ? ' ' + r.middleName : '') + '</td>' +
        '<td>' + (r.alias||'-') + '</td>' +
        '<td style="text-align:center">' + (r.sex||'-') + '</td>' +
        '<td style="text-align:center">' + age + '</td>' +
        '<td>' + (r.referringUnit||'-') + '</td>' +
        '<td style="text-align:center">' + formatDate(r.dateSurrendered) + '</td>' +
        '<td style="' + statusStyle + '">' + (r.recordStatus||'ACTIVE') + '</td>' +
        '</tr>';
    }).join('');

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>PROFILES WITH NO ASSISTANCE RECORDED</p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' +
      '<table class="report-table" style="width:100%;font-size:10px">' +
        '<thead><tr>' +
          '<th style="text-align:center;width:28px">#</th>' +
          '<th>FULL NAME</th><th>ALIAS</th>' +
          '<th style="text-align:center">SEX</th>' +
          '<th style="text-align:center">AGE</th>' +
          '<th>REFERRING UNIT</th>' +
          '<th style="text-align:center">DATE SURRENDERED</th>' +
          '<th>STATUS</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td colspan="8" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
          'TOTAL: ' + list.length + ' PROFILE' + (list.length !== 1 ? 'S' : '') + ' WITH NO ASSISTANCE' +
        '</td></tr></tfoot>' +
      '</table>';

    openPrintDocument('No Assistance List', body, REPORT_PRINT_STYLES);
    showToast('NO ASSISTANCE LIST GENERATED - ' + list.length + ' PROFILE(S)', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT FULL LIST ------------------------------------------
function printFullList() {
  function run(records) {
    if (!records.length) { showToast('NO RECORDS TO PRINT', 'info'); return; }

    // Sort alphabetically by last name then first name
    var list = records.slice().sort(function(a, b) {
      var la = (a.lastName  || '').toUpperCase();
      var lb = (b.lastName  || '').toUpperCase();
      var fa = (a.firstName || '').toUpperCase();
      var fb = (b.firstName || '').toUpperCase();
      if (la < lb) return -1; if (la > lb) return 1;
      if (fa < fb) return -1; if (fa > fb) return 1;
      return 0;
    });

    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    var rows = list.map(function(r, i) {
      var age = calcAgeFromDob(r.dob);
      var statusStyle = '';
      if (r.recordStatus === 'DECEASED')          statusStyle = 'color:#cf222e;font-weight:700';
      if (r.recordStatus === 'CANNOT BE LOCATED') statusStyle = 'color:#9a6700;font-weight:700';
      if (r.recordStatus === 'INCARCERATED')      statusStyle = 'color:#7a43b6;font-weight:700';
      var asstText = (r.assistance && r.assistance.length) ? r.assistance.join(', ') : '-';
      return '<tr>' +
        '<td style="text-align:center">' + (i + 1) + '</td>' +
        '<td><strong>' + (r.lastName  || '') + '</strong></td>' +
        '<td>'          + (r.firstName || '') + '</td>' +
        '<td>'          + (r.middleName || '-') + '</td>' +
        '<td>'          + (r.alias || '-') + '</td>' +
        '<td style="font-size:9px">' + (r.referringUnit || '-') + '</td>' +
        '<td style="text-align:center">' + (r.sex || '-') + '</td>' +
        '<td style="text-align:center">' + age + '</td>' +
        '<td style="text-align:center">' + formatDate(r.dob) + '</td>' +
        '<td style="font-size:9px;' + statusStyle + '">' + asstText + '</td>' +
        '</tr>';
    }).join('');

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>FULL LIST OF FORMER REBELS</p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' +
      '<table class="report-table" style="width:100%;font-size:10px">' +
        '<thead><tr>' +
          '<th style="text-align:center;width:26px">#</th>' +
          '<th>LAST NAME</th>' +
          '<th>FIRST NAME</th>' +
          '<th>MIDDLE NAME</th>' +
          '<th>ALIAS</th>' +
          '<th>REFERRING UNIT</th>' +
          '<th style="text-align:center">SEX</th>' +
          '<th style="text-align:center">AGE</th>' +
          '<th style="text-align:center">DATE OF BIRTH</th>' +
          '<th>CURRENT ASSISTANCE</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td colspan="10" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
          'TOTAL: ' + list.length + ' RECORD' + (list.length !== 1 ? 'S' : '') +
        '</td></tr></tfoot>' +
      '</table>';

    openPrintDocument('FR Full List', body, REPORT_PRINT_STYLES);
    showToast('FULL LIST GENERATED - ' + list.length + ' RECORD(S)', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT UNIT SUMMARY REPORT --------------------------------
function printUnitSummaryReport() {
  function run(records) {
    if (!records.length) { showToast('NO RECORDS TO PRINT', 'info'); return; }

    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    // Build unit map: { unitName: { total, regularNpa, milisyang, noType, noJapic } }
    var unitMap = {};
    records.forEach(function(r) {
      var unit = (r.referringUnit || 'NOT SPECIFIED').trim().toUpperCase();
      if (!unitMap[unit]) unitMap[unit] = { total: 0, regularNpa: 0, milisyang: 0, noType: 0, noJapic: 0 };
      unitMap[unit].total++;
      if (r.membershipType === 'REGULAR NPA')          unitMap[unit].regularNpa++;
      else if (r.membershipType === 'MILISYANG BAYAN') unitMap[unit].milisyang++;
      else                                             unitMap[unit].noType++;
      if (!r.japic || !(r.japic.url || r.japic.dataUrl || r.japic.fileName)) unitMap[unit].noJapic++;
    });

    // Sort units alphabetically, but keep NOT SPECIFIED last
    var units = Object.keys(unitMap).sort(function(a, b) {
      if (a === 'NOT SPECIFIED') return 1;
      if (b === 'NOT SPECIFIED') return -1;
      return a.localeCompare(b);
    });

    var grandTotal = records.length;
    var grandNpa = 0, grandMb = 0, grandNo = 0, grandNoJapic = 0;

    var rows = units.map(function(unit, i) {
      var d = unitMap[unit];
      grandNpa     += d.regularNpa;
      grandMb      += d.milisyang;
      grandNo      += d.noType;
      grandNoJapic += d.noJapic;
      var npaCell = d.regularNpa > 0
        ? '<span style="color:#c42b1c;font-weight:700">' + d.regularNpa + '</span>'
        : '<span style="color:#aaa">0</span>';
      var mbCell = d.milisyang > 0
        ? '<span style="color:#9a6700;font-weight:700">' + d.milisyang + '</span>'
        : '<span style="color:#aaa">0</span>';
      var noCell = d.noType > 0
        ? '<span style="color:#888">' + d.noType + '</span>'
        : '<span style="color:#aaa">0</span>';
      var japicCell = d.noJapic > 0
        ? '<span style="color:#c42b1c;font-weight:700">' + d.noJapic + '</span>'
        : '<span style="color:#3a7d44;font-weight:700">0</span>';
      return '<tr>' +
        '<td style="text-align:center">' + (i + 1) + '</td>' +
        '<td style="font-weight:600">' + unit + '</td>' +
        '<td style="text-align:center;font-size:13px;font-weight:700">' + d.total + '</td>' +
        '<td style="text-align:center">' + npaCell   + '</td>' +
        '<td style="text-align:center">' + mbCell    + '</td>' +
        '<td style="text-align:center">' + noCell    + '</td>' +
        '<td style="text-align:center">' + japicCell + '</td>' +
        '</tr>';
    }).join('');

    var tfoot =
      '<tr style="border-top:2px solid #333;font-weight:700;background:#f0f0f0">' +
        '<td colspan="2" style="text-align:right;font-size:10px;letter-spacing:1px">GRAND TOTAL</td>' +
        '<td style="text-align:center;font-size:13px">' + grandTotal + '</td>' +
        '<td style="text-align:center;color:#c42b1c">' + grandNpa + '</td>' +
        '<td style="text-align:center;color:#9a6700">' + grandMb  + '</td>' +
        '<td style="text-align:center;color:#888">'   + grandNo  + '</td>' +
        '<td style="text-align:center;color:#c42b1c">' + grandNoJapic + '</td>' +
      '</tr>';

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>NUMBER OF FRs PER REFERRING UNIT</p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' +
      '<table class="report-table" style="width:100%;font-size:11px">' +
        '<thead><tr>' +
          '<th style="text-align:center;width:28px">#</th>' +
          '<th>REFERRING UNIT</th>' +
          '<th style="text-align:center;width:60px">TOTAL FRs</th>' +
          '<th style="text-align:center;width:80px">REGULAR NPA</th>' +
          '<th style="text-align:center;width:80px">MILISYANG BAYAN</th>' +
          '<th style="text-align:center;width:80px">NOT SPECIFIED</th>' +
          '<th style="text-align:center;width:80px">NO JAPIC</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot>' + tfoot + '</tfoot>' +
      '</table>';

    openPrintDocument('FR Per Unit Summary', body, REPORT_PRINT_STYLES);
    showToast('UNIT SUMMARY REPORT GENERATED - ' + units.length + ' UNIT(S)', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT SUMMARY REPORTS ------------------------------------
// type: 'assistance' | 'membership' | 'tribal' | 'age' | '4ps' |
//       'sector' | 'municipality' | 'unit' | 'year'
function printSummaryReport(type) {
  function run(records) {
    if (!records.length) { showToast('NO RECORDS TO PRINT', 'info'); return; }
    var total     = records.length;
    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    var title, tableHtml;

    // ---- helper: build a standard 3-col summary table (category | count | %)
    function summaryTable(headers, rows, footerLabel, footerCount) {
      var thead = '<thead><tr>' + headers.map(function(h,i){
        return '<th' + (i>0?' style="text-align:center"':'') + '>' + h + '</th>';
      }).join('') + '</tr></thead>';
      var tbody = '<tbody>' + rows.map(function(r){
        return '<tr>' + r.map(function(c,i){
          return '<td' + (i>0?' style="text-align:center"':'') + '>' + c + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';
      var tfoot = footerLabel !== undefined
        ? '<tfoot><tr>' +
            '<td style="font-weight:700;font-size:10px;border-top:2px solid #333">' + footerLabel + '</td>' +
            '<td style="text-align:center;font-weight:700;border-top:2px solid #333">' + footerCount + '</td>' +
            '<td style="text-align:center;border-top:2px solid #333">' + (total>0?((footerCount/total)*100).toFixed(1):'0.0') + '%</td>' +
          '</tr></tfoot>'
        : '';
      return '<table class="report-table" style="width:60%;font-size:11px">' + thead + tbody + tfoot + '</table>';
    }

    if (type === 'assistance') {
      title = 'ASSISTANCE PROVIDED — SUMMARY';
      var ASST_TYPES = ['E-CLIP','NOT QUALIFIED FOR E-CLIP','FEA REMUNERATION','LIVELIHOOD','MEDICAL','EDUCATIONAL','ISSUANCE OF CREDENTIALS','PHILHEALTH','ISSUANCE OF SAFE CONDUCT PASS','APPLIED FOR AMNESTY','OTHERS'];
      var counts = {}; ASST_TYPES.forEach(function(t){counts[t]=0;});
      records.forEach(function(r){(r.assistance||[]).forEach(function(a){var k=a.indexOf('OTHERS')===0?'OTHERS':a;if(counts[k]!==undefined)counts[k]++;});});
      var beneficiaries = records.filter(function(r){return r.assistance&&r.assistance.length>0;}).length;
      var rows = ASST_TYPES.map(function(t){
        var c=counts[t]; return [t, c, total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];
      });
      tableHtml = summaryTable(['TYPE OF ASSISTANCE','BENEFICIARIES','% OF TOTAL'],rows,'TOTAL WITH ANY ASSISTANCE',beneficiaries);
    }

    else if (type === 'membership' || type === 'membership-npa' || type === 'membership-mb') {
      var MCOLORS = {'REGULAR NPA':'#f85149','MILISYANG BAYAN':'#d29922'};
      var npaList = records.filter(function(r){return r.membershipType==='REGULAR NPA';}).slice().sort(function(a,b){return (a.lastName||'').localeCompare(b.lastName||'');});
      var mbList  = records.filter(function(r){return r.membershipType==='MILISYANG BAYAN';}).slice().sort(function(a,b){return (a.lastName||'').localeCompare(b.lastName||'');});
      var noType  = total - npaList.length - mbList.length;

      // Shared summary counts table
      var mSummaryRows = [
        ['REGULAR NPA',    npaList.length, total>0?((npaList.length/total)*100).toFixed(1)+'%':'0.0%'],
        ['MILISYANG BAYAN', mbList.length, total>0?((mbList.length/total)*100).toFixed(1)+'%':'0.0%'],
        ['NOT SPECIFIED',  noType,         total>0?((noType/total)*100).toFixed(1)+'%':'0.0%']
      ];
      var mSummaryHtml = summaryTable(['MEMBERSHIP TYPE','COUNT','% OF TOTAL'], mSummaryRows, 'TOTAL', total);

      function memberList(list) {
        if (!list.length) return '<p style="color:#888;font-size:11px;padding:4px 0">No records.</p>';
        return '<table class="report-table" style="width:100%;font-size:10px">' +
          '<thead><tr><th style="width:26px;text-align:center">#</th><th>FULL NAME</th><th>ALIAS</th><th style="text-align:center">SEX</th><th style="text-align:center">AGE</th><th>UNIT</th><th>REFERRING UNIT</th><th style="text-align:center">DATE SURRENDERED</th></tr></thead>' +
          '<tbody>' + list.map(function(r,i){
            var st=r.recordStatus==='DECEASED'?'color:#c42b1c;font-weight:700':r.recordStatus==='CANNOT BE LOCATED'?'color:#9a6700;font-weight:700':r.recordStatus==='INCARCERATED'?'color:#7a43b6;font-weight:700':'';
            return '<tr>' +
              '<td style="text-align:center">'+(i+1)+'</td>' +
              '<td style="'+st+'"><strong>'+(r.lastName||'')+', '+(r.firstName||'')+'</strong>'+(r.middleName?' '+r.middleName:'')+'</td>' +
              '<td>'+(r.alias||'-')+'</td>' +
              '<td style="text-align:center">'+(r.sex||'-')+'</td>' +
              '<td style="text-align:center">'+calcAgeFromDob(r.dob)+'</td>' +
              '<td style="font-size:9px">'+(r.unit||'-')+'</td>' +
              '<td style="font-size:9px">'+(r.referringUnit||'-')+'</td>' +
              '<td style="text-align:center">'+formatDate(r.dateSurrendered)+'</td>' +
            '</tr>';
          }).join('') + '</tbody>' +
          '<tfoot><tr><td colspan="8" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">SUBTOTAL: '+list.length+' RECORD'+(list.length!==1?'S':'')+'</td></tr></tfoot>' +
        '</table>';
      }

      function memberSection(label, list, color) {
        return '<div style="margin-top:20px;page-break-inside:avoid">' +
          '<h2 style="font-size:13px;letter-spacing:1.5px;margin:0 0 4px;border-bottom:2px solid '+color+';padding-bottom:4px;color:'+color+'">' +
            label+' <span style="float:right;font-size:10px;font-weight:400;color:#555">'+list.length+' RECORD'+(list.length!==1?'S':'')+'</span></h2>' +
          memberList(list) + '</div>';
      }

      if (type === 'membership') {
        title = 'MEMBERSHIP TYPE — SUMMARY';
        tableHtml = mSummaryHtml;
      } else if (type === 'membership-npa') {
        title = 'REGULAR NPA — LIST';
        tableHtml = mSummaryHtml + memberSection('REGULAR NPA', npaList, MCOLORS['REGULAR NPA']);
      } else {
        title = 'MILISYANG BAYAN — LIST';
        tableHtml = mSummaryHtml + memberSection('MILISYANG BAYAN', mbList, MCOLORS['MILISYANG BAYAN']);
      }
    }

    else if (type === 'tribal' || type === 'tribal-detail') {
      var TTYPES = TRIBAL_GROUP_TYPES.slice();
      var TCOLORS = {'IRAYA':'#3fb950','ALANGAN':'#2ea043','TADYAWAN':'#56d364','TAU-BUID':'#26a641','BANGON':'#388bfd','BUHID':'#1f6feb','HANUNUO':'#58a6ff','RATAGNON':'#79c0ff','OTHERS':'#d29922','NO TRIBAL GROUP':'#6e7681'};
      var tc = {}; TTYPES.forEach(function(t){tc[t]=0;});
      records.forEach(function(r){var k=normalizeTribalGroup(r.tribalGroup);if(k&&tc[k]!==undefined)tc[k]++;});
      var withTribal = TTYPES.reduce(function(s,t){return s+tc[t];},0);
      var ipCount = TTYPES.filter(function(t){return t!=='NO TRIBAL GROUP';}).reduce(function(s,t){return s+tc[t];},0);
      var tRows = TTYPES.map(function(t){return [t, tc[t], total>0?((tc[t]/total)*100).toFixed(1)+'%':'0.0%'];});
      var noData = total - withTribal;
      if (noData > 0) tRows.push(['NOT SPECIFIED / NO DATA', noData, total>0?((noData/total)*100).toFixed(1)+'%':'0.0%']);
      var ipSummary = '<p style="margin:0 0 8px;font-size:11px"><strong>INDIGENOUS PEOPLE (IP):</strong> ' + ipCount +
        ' &nbsp;|&nbsp; <strong>NON-IP (NO TRIBAL GROUP):</strong> ' + tc['NO TRIBAL GROUP'] +
        ' &nbsp;|&nbsp; <strong>NOT SPECIFIED:</strong> ' + noData + '</p>';
      var tSummaryHtml = ipSummary + summaryTable(['TRIBAL GROUP','COUNT','% OF TOTAL'], tRows, 'TOTAL', total);

      if (type === 'tribal') {
        title = 'TRIBAL GROUP — SUMMARY';
        tableHtml = tSummaryHtml;
      } else {
        // tribal-detail: one section per tribal group, FR list with Tribal Group column
        title = 'TRIBAL GROUP — DETAIL LIST';
        function tribalFrList(list) {
          if (!list.length) return '<p style="color:#888;font-size:11px;padding:4px 0">No records.</p>';
          return '<table class="report-table" style="width:100%;font-size:10px">' +
            '<thead><tr>' +
              '<th style="width:26px;text-align:center">#</th>' +
              '<th>FULL NAME</th>' +
              '<th>ALIAS</th>' +
              '<th style="text-align:center">SEX</th>' +
              '<th style="text-align:center">AGE</th>' +
              '<th>TRIBAL GROUP</th>' +
              '<th>REFERRING UNIT</th>' +
              '<th style="text-align:center">DATE SURRENDERED</th>' +
            '</tr></thead>' +
            '<tbody>' + list.map(function(r,i){
              var st = r.recordStatus==='DECEASED'?'color:#c42b1c;font-weight:700':r.recordStatus==='CANNOT BE LOCATED'?'color:#9a6700;font-weight:700':r.recordStatus==='INCARCERATED'?'color:#7a43b6;font-weight:700':'';
              var tg = r.tribalGroup || 'NO TRIBAL GROUP';
              return '<tr>' +
                '<td style="text-align:center">'+(i+1)+'</td>' +
                '<td style="'+st+'"><strong>'+(r.lastName||'')+', '+(r.firstName||'')+'</strong>'+(r.middleName?' '+r.middleName:'')+'</td>' +
                '<td>'+(r.alias||'-')+'</td>' +
                '<td style="text-align:center">'+(r.sex||'-')+'</td>' +
                '<td style="text-align:center">'+calcAgeFromDob(r.dob)+'</td>' +
                '<td style="font-weight:600">' + tg + '</td>' +
                '<td style="font-size:9px">'+(r.referringUnit||'-')+'</td>' +
                '<td style="text-align:center">'+formatDate(r.dateSurrendered)+'</td>' +
              '</tr>';
            }).join('') + '</tbody>' +
            '<tfoot><tr><td colspan="8" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">SUBTOTAL: '+list.length+' RECORD'+(list.length!==1?'S':'')+'</td></tr></tfoot>' +
          '</table>';
        }

        // Build one section per tribal type (skip empty groups)
        var sections = TTYPES.map(function(t){
          var list = records.filter(function(r){
            return (normalizeTribalGroup(r.tribalGroup) || 'NO TRIBAL GROUP') === t;
          }).slice().sort(function(a,b){return (a.lastName||'').localeCompare(b.lastName||'');});
          if (!list.length) return '';
          var color = TCOLORS[t] || '#888';
          return '<div style="margin-top:20px;page-break-inside:avoid">' +
            '<h2 style="font-size:13px;letter-spacing:1.5px;margin:0 0 4px;border-bottom:2px solid '+color+';padding-bottom:4px;color:'+color+'">' +
              t+' <span style="float:right;font-size:10px;font-weight:400;color:#555">'+list.length+' RECORD'+(list.length!==1?'S':'')+'</span></h2>' +
            tribalFrList(list) +
          '</div>';
        }).join('');

        // Unspecified tribal group
        var unspec = records.filter(function(r){ return !normalizeTribalGroup(r.tribalGroup); }).slice().sort(function(a,b){return (a.lastName||'').localeCompare(b.lastName||'');});
        if (unspec.length) {
          sections += '<div style="margin-top:20px;page-break-inside:avoid">' +
            '<h2 style="font-size:13px;letter-spacing:1.5px;margin:0 0 4px;border-bottom:2px solid #888;padding-bottom:4px;color:#888">' +
              'NOT SPECIFIED <span style="float:right;font-size:10px;font-weight:400;color:#555">'+unspec.length+' RECORD'+(unspec.length!==1?'S':'')+'</span></h2>' +
            tribalFrList(unspec) +
          '</div>';
        }

        tableHtml = tSummaryHtml + sections;
      }
    }

    else if (type === 'age') {
      title = 'AGE BRACKET DISTRIBUTION — SUMMARY';
      var BRACKETS=[{label:'18 & BELOW',min:0,max:18},{label:'19 - 24',min:19,max:24},{label:'25 - 30',min:25,max:30},{label:'31 - 40',min:31,max:40},{label:'41 - 59',min:41,max:59},{label:'60 & ABOVE',min:60,max:999}];
      var ac = BRACKETS.map(function(){return 0;}); var withAge=0;
      records.forEach(function(r){
        var age=parseInt(calcAgeFromDob(r.dob)); if(isNaN(age))return; withAge++;
        for(var i=0;i<BRACKETS.length;i++){
          if(age>=BRACKETS[i].min&&age<=BRACKETS[i].max){ ac[i]++; break; }
        }
      });
      var rows = BRACKETS.map(function(b,i){
        var c=ac[i]; return [b.label, c, total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];
      });
      tableHtml = summaryTable(['AGE BRACKET','COUNT','% OF TOTAL'],rows,'NO AGE DATA',total-withAge);
    }

    else if (type === '4ps' || type === '4ps-yes' || type === '4ps-no') {
      var yes4    = records.filter(function(r){return r.fourPs==='YES';}).slice().sort(function(a,b){return (a.lastName||'').localeCompare(b.lastName||'');});
      var no4     = records.filter(function(r){return r.fourPs==='NO';}).slice().sort(function(a,b){return (a.lastName||'').localeCompare(b.lastName||'');});
      var noData4 = records.filter(function(r){return r.fourPs!=='YES'&&r.fourPs!=='NO';}).slice().sort(function(a,b){return (a.lastName||'').localeCompare(b.lastName||'');});

      // Summary counts table (shared by all three)
      var summaryRows4 = [
        ['YES (4Ps BENEFICIARY)', yes4.length,    total>0?((yes4.length/total)*100).toFixed(1)+'%':'0.0%'],
        ['NO (NON-4Ps)',          no4.length,     total>0?((no4.length/total)*100).toFixed(1)+'%':'0.0%'],
        ['NOT SPECIFIED',         noData4.length, total>0?((noData4.length/total)*100).toFixed(1)+'%':'0.0%']
      ];
      var summaryHtml4 = summaryTable(['4Ps STATUS','COUNT','% OF TOTAL'], summaryRows4, 'TOTAL', total);

      function fourPsFrList(list) {
        if (!list.length) return '<p style="color:#888;font-size:11px;padding:4px 0">No records.</p>';
        return '<table class="report-table" style="width:100%;font-size:10px">' +
          '<thead><tr><th style="width:26px;text-align:center">#</th><th>FULL NAME</th><th>ALIAS</th><th style="text-align:center">SEX</th><th style="text-align:center">AGE</th><th>REFERRING UNIT</th><th style="text-align:center">DATE SURRENDERED</th></tr></thead>' +
          '<tbody>' + list.map(function(r,i){
            var st=r.recordStatus==='DECEASED'?'color:#c42b1c;font-weight:700':r.recordStatus==='CANNOT BE LOCATED'?'color:#9a6700;font-weight:700':r.recordStatus==='INCARCERATED'?'color:#7a43b6;font-weight:700':'';
            return '<tr>' +
              '<td style="text-align:center">'+(i+1)+'</td>' +
              '<td style="'+st+'"><strong>'+(r.lastName||'')+', '+(r.firstName||'')+'</strong>'+(r.middleName?' '+r.middleName:'')+'</td>' +
              '<td>'+(r.alias||'-')+'</td>' +
              '<td style="text-align:center">'+(r.sex||'-')+'</td>' +
              '<td style="text-align:center">'+calcAgeFromDob(r.dob)+'</td>' +
              '<td style="font-size:9px">'+(r.referringUnit||'-')+'</td>' +
              '<td style="text-align:center">'+formatDate(r.dateSurrendered)+'</td>' +
            '</tr>';
          }).join('') + '</tbody>' +
          '<tfoot><tr><td colspan="7" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">SUBTOTAL: '+list.length+' RECORD'+(list.length!==1?'S':'')+'</td></tr></tfoot>' +
        '</table>';
      }

      if (type === '4ps') {
        title = '4Ps BENEFICIARIES — SUMMARY';
        tableHtml = summaryHtml4;
      } else if (type === '4ps-yes') {
        title = '4Ps BENEFICIARIES — LIST';
        tableHtml = summaryHtml4 +
          '<div style="margin-top:20px;page-break-inside:avoid">' +
          '<h2 style="font-size:13px;letter-spacing:1.5px;margin:0 0 4px;border-bottom:2px solid #3fb950;padding-bottom:4px;color:#3fb950">' +
            '4Ps BENEFICIARIES <span style="float:right;font-size:10px;font-weight:400;color:#555">'+yes4.length+' RECORDS</span></h2>' +
          fourPsFrList(yes4) + '</div>';
      } else {
        title = 'NON-4Ps — LIST';
        tableHtml = summaryHtml4 +
          '<div style="margin-top:20px;page-break-inside:avoid">' +
          '<h2 style="font-size:13px;letter-spacing:1.5px;margin:0 0 4px;border-bottom:2px solid #f85149;padding-bottom:4px;color:#f85149">' +
            'NON-4Ps <span style="float:right;font-size:10px;font-weight:400;color:#555">'+no4.length+' RECORDS</span></h2>' +
          fourPsFrList(no4) + '</div>';
      }
    }

    else if (type === 'sector') {
      title = 'SECTOR — SUMMARY';
      var SECTORS=['FARMER','FISHERFOLK','WOMEN','PWD','CHILDREN AND YOUTH','SENIOR CITIZEN','SOLO PARENT','INDIGENOUS PEOPLE','URBAN POOR','OTHERS'];
      var sc = {}; SECTORS.forEach(function(s){sc[s]=0;});
      records.forEach(function(r){(r.sector||[]).forEach(function(s){if(s==='FARMER/FISHERFOLK'){sc['FARMER']++;sc['FISHERFOLK']++;return;}var k=s.indexOf('OTHERS')===0?'OTHERS':s;if(sc[k]!==undefined)sc[k]++;});});
      var withSector=records.filter(function(r){return r.sector&&r.sector.length>0;}).length;
      var rows = SECTORS.map(function(s){return [s, sc[s], total>0?((sc[s]/total)*100).toFixed(1)+'%':'0.0%'];});
      tableHtml = summaryTable(['SECTOR','COUNT','% OF TOTAL'],rows,'NO SECTOR RECORDED',total-withSector);
    }

    else if (type === 'municipality') {
      title = 'MUNICIPALITY — SUMMARY';
      var OCC=['SAN JOSE','MAGSAYSAY','RIZAL','CALINTAAN','SABLAYAN','STA. CRUZ','MAMBURAO','PALUAN','ABRA DE ILOG','LOOC','LUBANG'];
      var ORI=['BACO','BULALACAO','BANSUD','BONGABONG','GLORIA','MANSALAY','NAUJAN','PINAMALAYAN','POLA','PUERTO GALERA','ROXAS','SAN TEODORO','SOCORRO','VICTORIA','CALAPAN'];
      var ALL_MUN = OCC.concat(ORI);
      var munC = {}; ALL_MUN.forEach(function(m){munC[m]=0;}); var noMun=0, outsideC=0;
      records.forEach(function(r){if(r.addressProvince==='OUTSIDE MINDORO'){outsideC++;return;}var m=r.addressMunicipality||'';if(m&&munC[m]!==undefined)munC[m]++;else if(m)munC[m]=1;else noMun++;});
      function buildGroup(list, groupLabel) {
        var header = '<tr><td colspan="3" style="background:#f5f5f5;font-size:9px;font-weight:700;letter-spacing:1px;padding:4px 8px">' + groupLabel + '</td></tr>';
        return header + list.map(function(m){var c=munC[m]||0;return '<tr><td>'+m+'</td><td style="text-align:center;font-weight:'+(c>0?'700':'400')+'">'+ c+'</td><td style="text-align:center">'+(total>0?((c/total)*100).toFixed(1):'0.0')+'%</td></tr>';}).join('');
      }
      tableHtml = '<table class="report-table" style="width:65%;font-size:11px">' +
        '<thead><tr><th>MUNICIPALITY</th><th style="text-align:center">COUNT</th><th style="text-align:center">% OF TOTAL</th></tr></thead>' +
        '<tbody>' + buildGroup(OCC,'OCCIDENTAL MINDORO') + buildGroup(ORI,'ORIENTAL MINDORO') +
        '<tr><td colspan="3" style="background:#f5f5f5;font-size:9px;font-weight:700;letter-spacing:1px;padding:4px 8px">OUTSIDE MINDORO</td></tr>' +
        '<tr><td>OUTSIDE MINDORO</td><td style="text-align:center;font-weight:'+(outsideC>0?'700':'400')+'">'+ outsideC+'</td><td style="text-align:center">'+(total>0?((outsideC/total)*100).toFixed(1):'0.0')+'%</td></tr>' +
        '</tbody>' +
        '<tfoot><tr><td style="font-weight:700;font-size:10px;border-top:2px solid #333">NOT SPECIFIED</td><td style="text-align:center;border-top:2px solid #333;font-weight:700">'+noMun+'</td><td style="text-align:center;border-top:2px solid #333">'+(total>0?((noMun/total)*100).toFixed(1):'0.0')+'%</td></tr></tfoot>' +
      '</table>';
    }

    else if (type === 'unit') {
      title = 'REFERRING UNIT — SUMMARY';
      var unitMap = {};
      records.forEach(function(r){var u=(r.referringUnit||'NOT SPECIFIED').trim().toUpperCase();if(!unitMap[u])unitMap[u]={total:0,npa:0,mb:0};unitMap[u].total++;if(r.membershipType==='REGULAR NPA')unitMap[u].npa++;else if(r.membershipType==='MILISYANG BAYAN')unitMap[u].mb++;});
      var units = Object.keys(unitMap).sort(function(a,b){if(a==='NOT SPECIFIED')return 1;if(b==='NOT SPECIFIED')return -1;return a.localeCompare(b);});
      var gTotal=0,gNpa=0,gMb=0;
      var rows = units.map(function(u){var d=unitMap[u];gTotal+=d.total;gNpa+=d.npa;gMb+=d.mb;return [u,d.total,d.npa,d.mb,total>0?((d.total/total)*100).toFixed(1)+'%':'0.0%'];});
      var thead = '<thead><tr><th>REFERRING UNIT</th><th style="text-align:center">TOTAL</th><th style="text-align:center">REG. NPA</th><th style="text-align:center">MILISYANG</th><th style="text-align:center">% OF TOTAL</th></tr></thead>';
      var tbody = '<tbody>' + rows.map(function(r){return '<tr>'+r.map(function(c,i){return '<td'+(i>0?' style="text-align:center"':'')+'>'+c+'</td>';}).join('')+'</tr>';}).join('') + '</tbody>';
      var tfoot = '<tfoot><tr><td style="font-weight:700;font-size:10px;border-top:2px solid #333">GRAND TOTAL</td><td style="text-align:center;font-weight:700;border-top:2px solid #333">'+gTotal+'</td><td style="text-align:center;border-top:2px solid #333">'+gNpa+'</td><td style="text-align:center;border-top:2px solid #333">'+gMb+'</td><td style="text-align:center;border-top:2px solid #333">100%</td></tr></tfoot>';
      tableHtml = '<table class="report-table" style="width:80%;font-size:11px">' + thead + tbody + tfoot + '</table>';
    }

    else if (type === 'year') {
      title = 'SURRENDER BY YEAR — SUMMARY';
      var START_YEAR=2016, thisYear=new Date().getFullYear(), years=[];
      for(var y=START_YEAR;y<=thisYear;y++) years.push(y);
      var yc={}, noDate=0; years.forEach(function(y){yc[y]=0;});
      records.forEach(function(r){if(!r.dateSurrendered){noDate++;return;}var yr=new Date(r.dateSurrendered).getFullYear();if(yc[yr]!==undefined)yc[yr]++;else yc[yr]=1;});
      var rows = years.map(function(y){var c=yc[y];return [y,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];});
      tableHtml = summaryTable(['YEAR','COUNT','% OF TOTAL'],rows,'NO DATE RECORDED',noDate);
    }

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>' + title + '</p>' +
        '<p>Total Records: <strong>' + total + '</strong></p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' +
      tableHtml;

    openPrintDocument(title, body, REPORT_PRINT_STYLES);
    showToast(title + ' GENERATED', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT YEAR DETAIL REPORT ---------------------------------
// Generates one section per year listing every FR who surrendered that year
function printYearDetailReport() {
  function run(records) {
    if (!records.length) { showToast('NO RECORDS TO PRINT', 'info'); return; }
    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';
    var total     = records.length;

    var START_YEAR = 2016, thisYear = new Date().getFullYear(), years = [];
    for (var y = START_YEAR; y <= thisYear; y++) years.push(y);

    // Bucket records by year
    var byYear = {}; years.forEach(function(y){ byYear[y] = []; });
    var noDate = [];
    records.forEach(function(r) {
      if (!r.dateSurrendered) { noDate.push(r); return; }
      var yr = new Date(r.dateSurrendered).getFullYear();
      if (byYear[yr]) byYear[yr].push(r); else { byYear[yr] = [r]; years.indexOf(yr) === -1 && years.push(yr); }
    });
    years.sort(function(a,b){return a-b;});

    function frRow(r, i) {
      var statusStyle = r.recordStatus === 'DECEASED' ? 'color:#c42b1c;font-weight:700' : r.recordStatus === 'CANNOT BE LOCATED' ? 'color:#9a6700;font-weight:700' : r.recordStatus === 'INCARCERATED' ? 'color:#7a43b6;font-weight:700' : '';
      return '<tr>' +
        '<td style="text-align:center">' + (i+1) + '</td>' +
        '<td><strong>' + (r.lastName||'') + ', ' + (r.firstName||'') + '</strong>' + (r.middleName ? ' '+r.middleName : '') + '</td>' +
        '<td>' + (r.alias||'-') + '</td>' +
        '<td style="text-align:center">' + (r.sex||'-') + '</td>' +
        '<td style="text-align:center">' + calcAgeFromDob(r.dob) + '</td>' +
        '<td style="font-size:9px">' + (r.referringUnit||'-') + '</td>' +
        '<td style="text-align:center;font-size:9px;' + statusStyle + '">' + formatDate(r.dateSurrendered) + '</td>' +
      '</tr>';
    }
    function yearSection(yr, list) {
      if (!list.length) return '';
      var sorted = list.slice().sort(function(a,b){return (a.lastName||'').localeCompare(b.lastName||'');});
      return '<div style="margin-top:20px;page-break-inside:avoid">' +
        '<h2 style="font-size:13px;letter-spacing:2px;margin:0 0 4px;border-bottom:2px solid #333;padding-bottom:4px">' +
          yr + ' <span style="font-size:10px;font-weight:400;color:#555">— ' + list.length + ' FORMER REBEL' + (list.length!==1?'S':'') + '</span>' +
        '</h2>' +
        '<table class="report-table" style="width:100%;font-size:10px">' +
          '<thead><tr><th style="width:26px;text-align:center">#</th><th>FULL NAME</th><th>ALIAS</th><th style="text-align:center">SEX</th><th style="text-align:center">AGE</th><th>REFERRING UNIT</th><th style="text-align:center">DATE SURRENDERED</th></tr></thead>' +
          '<tbody>' + sorted.map(frRow).join('') + '</tbody>' +
        '</table>' +
      '</div>';
    }

    // Summary header table
    var summaryRows = years.map(function(y){ return '<tr><td>'+y+'</td><td style="text-align:center;font-weight:700">'+(byYear[y]?byYear[y].length:0)+'</td><td style="text-align:center">'+(total>0?(((byYear[y]?byYear[y].length:0)/total)*100).toFixed(1):'0.0')+'%</td></tr>'; }).join('');
    var summaryTable = '<table class="report-table" style="width:40%;font-size:10px;margin-bottom:20px">' +
      '<thead><tr><th>YEAR</th><th style="text-align:center">COUNT</th><th style="text-align:center">%</th></tr></thead>' +
      '<tbody>' + summaryRows + '</tbody>' +
      '<tfoot><tr><td style="font-weight:700;border-top:2px solid #333">NO DATE RECORDED</td><td style="text-align:center;border-top:2px solid #333;font-weight:700">'+noDate.length+'</td><td style="text-align:center;border-top:2px solid #333">'+(total>0?((noDate.length/total)*100).toFixed(1):'0.0')+'%</td></tr></tfoot>' +
    '</table>';

    var sections = years.map(function(y){ return yearSection(y, byYear[y]||[]); }).join('');
    if (noDate.length) sections += yearSection('NO DATE RECORDED', noDate);

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>FORMER REBELS BY YEAR SURRENDERED</p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' + summaryTable + sections;

    openPrintDocument('FR by Year Surrendered', body, REPORT_PRINT_STYLES);
    showToast('YEAR DETAIL REPORT GENERATED — ' + total + ' RECORDS', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records){ allRecordsCache = records; run(records); })
    .catch(function(err){ showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT UNIT DETAIL REPORT ---------------------------------
// Generates one section per referring unit listing every FR in that unit
function printUnitDetailReport() {
  function run(records) {
    if (!records.length) { showToast('NO RECORDS TO PRINT', 'info'); return; }
    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';
    var total     = records.length;

    // Bucket by unit
    var unitMap = {}, unitOrder = [];
    records.forEach(function(r) {
      var u = (r.referringUnit || 'NOT SPECIFIED').trim();
      if (!unitMap[u]) { unitMap[u] = []; unitOrder.push(u); }
      unitMap[u].push(r);
    });
    unitOrder.sort(function(a,b){
      if (a === 'NOT SPECIFIED') return 1;
      if (b === 'NOT SPECIFIED') return -1;
      return a.localeCompare(b);
    });

    function frRow(r, i) {
      var statusStyle = r.recordStatus === 'DECEASED' ? 'color:#c42b1c;font-weight:700' : r.recordStatus === 'CANNOT BE LOCATED' ? 'color:#9a6700;font-weight:700' : r.recordStatus === 'INCARCERATED' ? 'color:#7a43b6;font-weight:700' : '';
      return '<tr>' +
        '<td style="text-align:center">' + (i+1) + '</td>' +
        '<td><strong>' + (r.lastName||'') + ', ' + (r.firstName||'') + '</strong>' + (r.middleName ? ' '+r.middleName : '') + '</td>' +
        '<td>' + (r.alias||'-') + '</td>' +
        '<td style="text-align:center">' + (r.sex||'-') + '</td>' +
        '<td style="text-align:center">' + calcAgeFromDob(r.dob) + '</td>' +
        '<td style="text-align:center">' + (r.membershipType||'-') + '</td>' +
        '<td style="text-align:center;font-size:9px">' + formatDate(r.dateSurrendered) + '</td>' +
        '<td style="text-align:center;font-size:9px;' + statusStyle + '">' + (r.recordStatus||'ACTIVE') + '</td>' +
      '</tr>';
    }
    function unitSection(unit, list) {
      var sorted = list.slice().sort(function(a,b){return (a.lastName||'').localeCompare(b.lastName||'');});
      var npa = list.filter(function(r){return r.membershipType==='REGULAR NPA';}).length;
      var mb  = list.filter(function(r){return r.membershipType==='MILISYANG BAYAN';}).length;
      return '<div style="margin-top:24px;page-break-inside:avoid">' +
        '<h2 style="font-size:12px;letter-spacing:1.5px;margin:0 0 2px;border-bottom:2px solid #333;padding-bottom:4px">' +
          unit +
          '<span style="float:right;font-size:10px;font-weight:400;color:#555">' + list.length + ' FR' + (list.length!==1?'s':'') +
          ' &nbsp;|&nbsp; NPA: ' + npa + ' &nbsp;|&nbsp; MB: ' + mb + '</span>' +
        '</h2>' +
        '<table class="report-table" style="width:100%;font-size:10px">' +
          '<thead><tr><th style="width:26px;text-align:center">#</th><th>FULL NAME</th><th>ALIAS</th><th style="text-align:center">SEX</th><th style="text-align:center">AGE</th><th style="text-align:center">MEMBERSHIP</th><th style="text-align:center">DATE SURRENDERED</th><th style="text-align:center">STATUS</th></tr></thead>' +
          '<tbody>' + sorted.map(frRow).join('') + '</tbody>' +
        '</table>' +
      '</div>';
    }

    // Summary header
    var summaryRows = unitOrder.map(function(u){ var d=unitMap[u]; return '<tr><td>'+u+'</td><td style="text-align:center;font-weight:700">'+d.length+'</td><td style="text-align:center">'+(total>0?((d.length/total)*100).toFixed(1):'0.0')+'%</td></tr>'; }).join('');
    var summaryTable = '<table class="report-table" style="width:55%;font-size:10px;margin-bottom:20px">' +
      '<thead><tr><th>REFERRING UNIT</th><th style="text-align:center">COUNT</th><th style="text-align:center">%</th></tr></thead>' +
      '<tbody>' + summaryRows + '</tbody>' +
      '<tfoot><tr><td style="font-weight:700;border-top:2px solid #333">GRAND TOTAL</td><td style="text-align:center;border-top:2px solid #333;font-weight:700">'+total+'</td><td style="text-align:center;border-top:2px solid #333">100%</td></tr></tfoot>' +
    '</table>';

    var sections = unitOrder.map(function(u){ return unitSection(u, unitMap[u]); }).join('');

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>FORMER REBELS PER REFERRING UNIT</p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' + summaryTable + sections;

    openPrintDocument('FR per Referring Unit', body, REPORT_PRINT_STYLES);
    showToast('UNIT DETAIL REPORT GENERATED — ' + unitOrder.length + ' UNIT(S)', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records){ allRecordsCache = records; run(records); })
    .catch(function(err){ showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT ADDRESS REPORT -------------------------------------
// scope: 'MAPSA' | 'SAMARICA' | 'OUTSIDE' | 'NOADDRESS' | 'ALL'
var ADDRESS_AREAS = {
  MAPSA:     { label: 'MAPSA', subtitle: 'Mamburao, Abra de Ilog, Paluan, Sablayan, Sta. Cruz', municipalities: ['MAMBURAO','ABRA DE ILOG','PALUAN','SABLAYAN','STA. CRUZ','SANTA CRUZ'] },
  SAMARICA:  { label: 'SAMARICA', subtitle: 'San Jose, Magsaysay, Rizal, Calintaan', municipalities: ['SAN JOSE','MAGSAYSAY','RIZAL','CALINTAAN'] }
};

function classifyAddressArea(r) {
  var mun  = (r.addressMunicipality || '').trim().toUpperCase();
  var prov = (r.addressProvince     || '').trim().toUpperCase();
  var bar  = (r.addressBarangay     || r.address || '').trim();

  // No address at all
  var hasAny = mun || prov || bar;
  if (!hasAny) return 'NOADDRESS';

  // Outside Occidental Mindoro
  if (prov && prov !== 'OCCIDENTAL MINDORO') return 'OUTSIDE';

  // Check MAPSA municipalities
  if (ADDRESS_AREAS.MAPSA.municipalities.indexOf(mun) !== -1) return 'MAPSA';

  // Check SAMARICA municipalities
  if (ADDRESS_AREAS.SAMARICA.municipalities.indexOf(mun) !== -1) return 'SAMARICA';

  // In Occidental Mindoro but not in either cluster (e.g. LOOC, LUBANG, or no municipality set)
  if (prov === 'OCCIDENTAL MINDORO' && mun && ['LOOC','LUBANG'].indexOf(mun) !== -1) return 'OUTSIDE_CLUSTER';

  return 'OUTSIDE_CLUSTER'; // has address but doesn't fit known clusters
}

function buildAddressReportTable(list, startIdx) {
  if (!list.length) return '<p style="color:#888;font-size:11px;padding:8px 0">No records in this category.</p>';
  var rows = list.map(function(r, i) {
    var fullName = (r.lastName || '') + ', ' + (r.firstName || '') + (r.middleName ? ' ' + r.middleName : '');
    var addr = [
      r.addressBarangay || r.address || '',
      r.addressMunicipality || '',
      r.addressProvince || ''
    ].filter(Boolean).join(', ') || '-';
    var statusStyle = '';
    if (r.recordStatus === 'DECEASED')          statusStyle = 'color:#c42b1c;font-weight:700';
    if (r.recordStatus === 'CANNOT BE LOCATED') statusStyle = 'color:#9a6700;font-weight:700';
    if (r.recordStatus === 'INCARCERATED')      statusStyle = 'color:#7a43b6;font-weight:700';
    return '<tr>' +
      '<td style="text-align:center;width:26px">'  + ((startIdx || 0) + i + 1) + '</td>' +
      '<td><strong>' + fullName + '</strong></td>' +
      '<td style="font-size:10px">' + (r.alias || '-') + '</td>' +
      '<td style="text-align:center">' + (r.sex || '-') + '</td>' +
      '<td style="font-size:10px">' + addr + '</td>' +
      '<td style="font-size:10px;' + statusStyle + '">' + (r.recordStatus || 'ACTIVE') + '</td>' +
      '<td style="text-align:center;font-size:10px">' + formatDate(r.dateSurrendered) + '</td>' +
    '</tr>';
  }).join('');
  return '<table class="report-table" style="width:100%;font-size:10px">' +
    '<thead><tr>' +
      '<th style="text-align:center;width:26px">#</th>' +
      '<th>FULL NAME</th>' +
      '<th>ALIAS</th>' +
      '<th style="text-align:center">SEX</th>' +
      '<th>ADDRESS</th>' +
      '<th>STATUS</th>' +
      '<th style="text-align:center">DATE SURRENDERED</th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '<tfoot><tr><td colspan="7" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
      'SUBTOTAL: ' + list.length + ' RECORD' + (list.length !== 1 ? 'S' : '') +
    '</td></tr></tfoot>' +
  '</table>';
}

function printAddressReport(scope) {
  function run(records) {
    if (!records.length) { showToast('NO RECORDS TO PRINT', 'info'); return; }

    var sorted = records.slice().sort(function(a, b) {
      return (a.lastName || '').localeCompare(b.lastName || '');
    });

    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    // Classify all records
    var buckets = { MAPSA: [], SAMARICA: [], OUTSIDE: [], OUTSIDE_CLUSTER: [], NOADDRESS: [] };
    sorted.forEach(function(r) { buckets[classifyAddressArea(r)].push(r); });
    var outsideAll = buckets.OUTSIDE.concat(buckets.OUTSIDE_CLUSTER).sort(function(a,b){
      return (a.lastName||'').localeCompare(b.lastName||'');
    });

    // -- SUMMARY ONLY scope --
    if (scope === 'SUMMARY') {
      var rows = [
        ['MAPSA', 'Mamburao, Abra de Ilog, Paluan, Sablayan, Sta. Cruz', buckets.MAPSA.length,    '#1a7f37'],
        ['SAMARICA', 'San Jose, Magsaysay, Rizal, Calintaan',             buckets.SAMARICA.length, '#0969da'],
        ['OUTSIDE OF OCCIDENTAL MINDORO', 'Oriental Mindoro, other provinces, unknown municipality', outsideAll.length, '#9a6700'],
        ['NO ADDRESS ON RECORD', 'Address fields are blank',              buckets.NOADDRESS.length, '#cf222e']
      ];
      var total = records.length;
      var tableRows = rows.map(function(row) {
        return '<tr>' +
          '<td style="font-weight:600;color:' + row[3] + '">' + row[0] + '</td>' +
          '<td style="font-size:10px;color:#555">' + row[1] + '</td>' +
          '<td style="text-align:center;font-size:14px;font-weight:700;color:' + row[3] + '">' + row[2] + '</td>' +
          '<td style="text-align:center">' + (total > 0 ? ((row[2] / total) * 100).toFixed(1) : '0.0') + '%</td>' +
        '</tr>';
      }).join('');
      var body =
        '<div class="print-header">' +
          '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
          '<p>FR ADDRESS REPORT — SUMMARY BY AREA</p>' +
          '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
        '</div>' +
        '<table class="report-table" style="width:70%;font-size:11px">' +
          '<thead><tr>' +
            '<th>AREA</th>' +
            '<th>MUNICIPALITIES COVERED</th>' +
            '<th style="text-align:center">COUNT</th>' +
            '<th style="text-align:center">% OF TOTAL</th>' +
          '</tr></thead>' +
          '<tbody>' + tableRows + '</tbody>' +
          '<tfoot><tr>' +
            '<td colspan="2" style="text-align:right;font-weight:700;font-size:10px;border-top:2px solid #333">TOTAL</td>' +
            '<td style="text-align:center;font-size:14px;font-weight:700;border-top:2px solid #333">' + total + '</td>' +
            '<td style="text-align:center;border-top:2px solid #333">100%</td>' +
          '</tr></tfoot>' +
        '</table>';
      openPrintDocument('FR Address Summary', body, REPORT_PRINT_STYLES);
      showToast('ADDRESS SUMMARY GENERATED', 'success');
      return;
    }

    // Merge OUTSIDE + OUTSIDE_CLUSTER into one "Outside" bucket for display (detail scopes)
    var body = '<div class="print-header">' +
      '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>';

    var sections = '';
    var totalShown = 0;

    function makeSection(title, subtitle, list, color) {
      if (!list.length && scope !== 'ALL') return '';
      totalShown += list.length;
      return '<div style="margin-top:20px;page-break-inside:avoid">' +
        '<h2 style="font-size:12px;letter-spacing:1.5px;margin:0 0 2px;border-bottom:2px solid ' + color + ';padding-bottom:4px;color:' + color + '">' +
          title + ' <span style="font-size:9px;color:#555;font-weight:400;letter-spacing:0">— ' + subtitle + '</span>' +
          '<span style="float:right;font-size:10px;font-weight:700;color:#333">' + list.length + ' RECORD' + (list.length !== 1 ? 'S' : '') + '</span>' +
        '</h2>' +
        buildAddressReportTable(list, 0) +
      '</div>';
    }

    if (scope === 'MAPSA' || scope === 'ALL') {
      body += '<p>FR ADDRESS REPORT — MAPSA AREA</p>';
      sections += makeSection('MAPSA', 'Mamburao, Abra de Ilog, Paluan, Sablayan, Sta. Cruz', buckets.MAPSA, '#1a7f37');
    }
    if (scope === 'SAMARICA' || scope === 'ALL') {
      if (scope === 'SAMARICA') body += '<p>FR ADDRESS REPORT — SAMARICA AREA</p>';
      sections += makeSection('SAMARICA', 'San Jose, Magsaysay, Rizal, Calintaan', buckets.SAMARICA, '#0969da');
    }
    if (scope === 'OUTSIDE' || scope === 'ALL') {
      if (scope === 'OUTSIDE') body += '<p>FR ADDRESS REPORT — OUTSIDE OCCIDENTAL MINDORO</p>';
      sections += makeSection('OUTSIDE OF OCCIDENTAL MINDORO', 'Oriental Mindoro, Metro Manila, other provinces, unknown municipality', outsideAll, '#9a6700');
    }
    if (scope === 'NOADDRESS' || scope === 'ALL') {
      if (scope === 'NOADDRESS') body += '<p>FR ADDRESS REPORT — NO ADDRESS ON RECORD</p>';
      sections += makeSection('NO ADDRESS ON RECORD', 'Address fields are blank', buckets.NOADDRESS, '#cf222e');
    }
    if (scope === 'ALL') {
      body += '<p>FR ADDRESS REPORT — ALL AREAS</p>';
    }

    body += '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p></div>';

    // Summary box for ALL scope
    if (scope === 'ALL') {
      var summaryRows = [
        ['MAPSA (Mamburao, Abra de Ilog, Paluan, Sablayan, Sta. Cruz)', buckets.MAPSA.length],
        ['SAMARICA (San Jose, Magsaysay, Rizal, Calintaan)',             buckets.SAMARICA.length],
        ['OUTSIDE OF OCCIDENTAL MINDORO',                                outsideAll.length],
        ['NO ADDRESS ON RECORD',                                          buckets.NOADDRESS.length]
      ];
      body += '<div style="margin-bottom:16px;page-break-inside:avoid">' +
        '<h2 style="font-size:11px;letter-spacing:1.5px;margin:0 0 6px;border-bottom:1px solid #999;padding-bottom:4px">SUMMARY BY AREA</h2>' +
        '<table class="report-table" style="width:60%;font-size:10px">' +
          '<thead><tr><th>AREA</th><th style="text-align:center">COUNT</th></tr></thead>' +
          '<tbody>' + summaryRows.map(function(row) {
            return '<tr><td>' + row[0] + '</td><td style="text-align:center;font-weight:700">' + row[1] + '</td></tr>';
          }).join('') + '</tbody>' +
          '<tfoot><tr>' +
            '<td style="font-weight:700;text-align:right;font-size:9px;border-top:2px solid #333">TOTAL</td>' +
            '<td style="text-align:center;font-weight:700;border-top:2px solid #333">' + records.length + '</td>' +
          '</tr></tfoot>' +
        '</table>' +
      '</div>';
    }

    body += sections;

    var scopeLabels = {
      MAPSA: 'MAPSA', SAMARICA: 'SAMARICA', OUTSIDE: 'OUTSIDE OCC. MINDORO',
      NOADDRESS: 'NO ADDRESS', ALL: 'ALL AREAS'
    };
    openPrintDocument('FR Address Report', body, REPORT_PRINT_STYLES);
    showToast('ADDRESS REPORT GENERATED — ' + scopeLabels[scope] + ' (' + (scope === 'ALL' ? records.length : totalShown) + ' RECORD' + ((scope === 'ALL' ? records.length : totalShown) !== 1 ? 'S' : '') + ')', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- PRINT ASSISTANCE LIST ------------------------------------
function printAssistanceList() {
  function run(records) {
    if (!records.length) { showToast('NO RECORDS TO PRINT', 'info'); return; }

    var ASST_TYPES = [
      'E-CLIP','NOT QUALIFIED FOR E-CLIP','FEA REMUNERATION','LIVELIHOOD',
      'MEDICAL','EDUCATIONAL','ISSUANCE OF CREDENTIALS','PHILHEALTH',
      'ISSUANCE OF SAFE CONDUCT PASS','APPLIED FOR AMNESTY','OTHERS'
    ];

    var list = records.slice().sort(function(a, b) {
      var la = (a.lastName  || '').toUpperCase(), lb = (b.lastName  || '').toUpperCase();
      var fa = (a.firstName || '').toUpperCase(), fb = (b.firstName || '').toUpperCase();
      if (la < lb) return -1; if (la > lb) return 1;
      if (fa < fb) return -1; if (fa > fb) return 1;
      return 0;
    });

    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    // Summary counts per assistance type
    var counts = {};
    ASST_TYPES.forEach(function(t) { counts[t] = 0; });
    records.forEach(function(r) {
      (r.assistance || []).forEach(function(a) {
        var key = a.indexOf('OTHERS') === 0 ? 'OTHERS' : a;
        if (counts[key] !== undefined) counts[key]++;
      });
    });

    var summaryRows = ASST_TYPES.map(function(t) {
      return '<tr><td>' + t + '</td><td style="text-align:center;font-weight:700">' + counts[t] + '</td></tr>';
    }).join('');

    var summaryTable =
      '<div style="margin-bottom:16px;page-break-inside:avoid">' +
        '<h2 style="font-size:11px;letter-spacing:1.5px;margin:0 0 6px;border-bottom:1px solid #999;padding-bottom:4px">ASSISTANCE SUMMARY</h2>' +
        '<table class="report-table" style="width:40%;font-size:10px">' +
          '<thead><tr><th>ASSISTANCE TYPE</th><th style="text-align:center">COUNT</th></tr></thead>' +
          '<tbody>' + summaryRows + '</tbody>' +
        '</table>' +
      '</div>';

    var detailRows = list.map(function(r, i) {
      var asst = (r.assistance && r.assistance.length) ? r.assistance.join(', ') : '-';
      var statusStyle = '';
      if (r.recordStatus === 'DECEASED')          statusStyle = 'color:#cf222e;font-weight:700';
      if (r.recordStatus === 'CANNOT BE LOCATED') statusStyle = 'color:#9a6700;font-weight:700';
      if (r.recordStatus === 'INCARCERATED')      statusStyle = 'color:#7a43b6;font-weight:700';
      return '<tr>' +
        '<td style="text-align:center">' + (i + 1) + '</td>' +
        '<td><strong>' + (r.lastName || '') + ', ' + (r.firstName || '') + '</strong>' + (r.middleName ? ' ' + r.middleName : '') + '</td>' +
        '<td>' + (r.alias || '-') + '</td>' +
        '<td style="text-align:center">' + (r.sex || '-') + '</td>' +
        '<td style="text-align:center">' + calcAgeFromDob(r.dob) + '</td>' +
        '<td style="font-size:9px">' + (r.referringUnit || '-') + '</td>' +
        '<td style="font-size:9px;' + statusStyle + '">' + asst + '</td>' +
      '</tr>';
    }).join('');

    var detailTable =
      '<div style="page-break-inside:avoid">' +
        '<h2 style="font-size:11px;letter-spacing:1.5px;margin:0 0 6px;border-bottom:1px solid #999;padding-bottom:4px">ASSISTANCE PER FORMER REBEL</h2>' +
        '<table class="report-table" style="width:100%;font-size:10px">' +
          '<thead><tr>' +
            '<th style="text-align:center;width:26px">#</th>' +
            '<th>FULL NAME</th>' +
            '<th>ALIAS</th>' +
            '<th style="text-align:center">SEX</th>' +
            '<th style="text-align:center">AGE</th>' +
            '<th>REFERRING UNIT</th>' +
            '<th>ASSISTANCE PROVIDED</th>' +
          '</tr></thead>' +
          '<tbody>' + detailRows + '</tbody>' +
          '<tfoot><tr><td colspan="7" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
            'TOTAL: ' + list.length + ' RECORD' + (list.length !== 1 ? 'S' : '') +
          '</td></tr></tfoot>' +
        '</table>' +
      '</div>';

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>ASSISTANCE PROVIDED ? FORMER REBELS</p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' +
      summaryTable +
      detailTable;

    openPrintDocument('FR Assistance Report', body, REPORT_PRINT_STYLES);
    showToast('ASSISTANCE REPORT GENERATED - ' + list.length + ' RECORD(S)', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- POSSIBLE DUPLICATES MODAL --------------------------------
function closeDuplicatesModal() {
  document.getElementById('duplicatesModal').classList.add('hidden');
}

function deleteDuplicateRecord(id) {
  if (!confirm('DELETE THIS RECORD?\n\nThis cannot be undone.')) return;
  dbDelete(id).then(function() {
    showToast('RECORD DELETED', 'error');
    allRecordsCache = [];
    // Refresh the modal with updated data
    dbGetAll().then(function(records) {
      allRecordsCache = records;
      // Re-render records table in background
      if (currentPage === 'records') renderRecords(records, document.getElementById('searchInput').value, document.getElementById('unitFilterSelect').value, document.getElementById('membershipFilterSelect').value, document.getElementById('yearFilterSelect') ? document.getElementById('yearFilterSelect').value : '');
      // Refresh modal content
      showPossibleDuplicates();
    });
  }).catch(function(err) { showToast('DELETE FAILED: ' + err.message, 'error'); });
}

function showPossibleDuplicates() {
  var modal   = document.getElementById('duplicatesModal');
  var content = document.getElementById('duplicatesModalContent');
  content.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text3)">SCANNING RECORDS...</div>';
  modal.classList.remove('hidden');

  function run(records) {
    var groups = findDuplicateGroups(records);

    if (!groups.length) {
      content.innerHTML = '<div style="text-align:center;padding:32px;color:var(--accent2)">? NO POSSIBLE DUPLICATES FOUND IN ' + records.length + ' RECORDS</div>';
      return;
    }

    var totalRecords = groups.reduce(function(s, g) { return s + g.length; }, 0);
    var html = '<div style="font-size:0.75rem;color:var(--text3);margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid var(--border)">' +
      '<span style="color:#f85149;font-weight:700">' + groups.length + ' DUPLICATE GROUP' + (groups.length !== 1 ? 'S' : '') + '</span>' +
      ' &nbsp;-&nbsp; ' + totalRecords + ' RECORDS AFFECTED</div>';

    groups.forEach(function(grp, gi) {
      html += '<div style="margin-bottom:20px;background:var(--bg3);border:1px solid rgba(248,81,73,0.3);border-radius:var(--radius);overflow:hidden">' +
        '<div style="background:rgba(248,81,73,0.1);padding:8px 14px;font-size:0.7rem;font-weight:700;letter-spacing:1px;color:#f85149;display:flex;justify-content:space-between;align-items:center">' +
          '<span>DUPLICATE GROUP ' + (gi + 1) + ' - ' + grp.length + ' RECORDS</span>' +
          '<span style="color:var(--text3);font-weight:400">' + (grp[0].lastName||'') + ', ' + (grp[0].firstName||'') + '</span>' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:0.72rem">' +
          '<thead><tr style="background:var(--bg2)">' +
            '<th style="padding:6px 10px;text-align:left;color:var(--text3);font-weight:600;font-size:0.65rem">FULL NAME</th>' +
            '<th style="padding:6px 10px;text-align:left;color:var(--text3);font-weight:600;font-size:0.65rem">ALIAS</th>' +
            '<th style="padding:6px 10px;text-align:center;color:var(--text3);font-weight:600;font-size:0.65rem">SEX</th>' +
            '<th style="padding:6px 10px;text-align:center;color:var(--text3);font-weight:600;font-size:0.65rem">DOB</th>' +
            '<th style="padding:6px 10px;text-align:left;color:var(--text3);font-weight:600;font-size:0.65rem">REFERRING UNIT</th>' +
            '<th style="padding:6px 10px;text-align:center;color:var(--text3);font-weight:600;font-size:0.65rem">DATE SURRENDERED</th>' +
            '<th style="padding:6px 10px;text-align:center;color:var(--text3);font-weight:600;font-size:0.65rem">ACTIONS</th>' +
          '</tr></thead><tbody>';

      grp.forEach(function(r, ri) {
        var rowBg = ri % 2 === 0 ? 'var(--bg3)' : 'var(--bg2)';
        html += '<tr style="background:' + rowBg + ';border-top:1px solid var(--border)">' +
          '<td style="padding:8px 10px"><strong>' + (r.lastName||'') + ', ' + (r.firstName||'') + '</strong>' + (r.middleName ? ' ' + r.middleName : '') + '</td>' +
          '<td style="padding:8px 10px">' + (r.alias||'-') + '</td>' +
          '<td style="padding:8px 10px;text-align:center">' + (r.sex||'-') + '</td>' +
          '<td style="padding:8px 10px;text-align:center">' + (r.dob ? formatDate(r.dob) : '-') + '</td>' +
          '<td style="padding:8px 10px;font-size:0.68rem">' + (r.referringUnit||'-') + '</td>' +
          '<td style="padding:8px 10px;text-align:center">' + (r.dateSurrendered ? formatDate(r.dateSurrendered) : '-') + '</td>' +
          '<td style="padding:8px 10px;text-align:center">' +
            '<button class="btn-view" style="margin:2px" onclick="closeDuplicatesModal();viewRecord(\'' + r.id + '\')">\uD83D\uDC41 VIEW</button>' +
            '<button class="btn-edit" style="margin:2px" onclick="closeDuplicatesModal();editRecord(\'' + r.id + '\')">\u270F EDIT</button>' +
            '<button class="btn-del" style="margin:2px" onclick="deleteDuplicateRecord(\'' + r.id + '\')">\uD83D\uDDD1 DEL</button>' +
          '</td>' +
        '</tr>';
      });

      html += '</tbody></table></div>';
    });

    content.innerHTML = html;
  }

  // Always fetch fresh from server to ensure latest data
  dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { content.innerHTML = '<div style="color:#f85149;padding:16px">ERROR: ' + err.message + '</div>'; });
}

// -- FUZZY NAME MATCHING --------------------------------------
// Normalizes a name string: strips periods, extra spaces, suffixes
function normalizeName(s) {
  return (s || '').toUpperCase()
    .replace(/\./g, '')
    .replace(/\b(JR|SR|II|III|IV)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function editDistance(a, b) {
  var m = a.length, n = b.length, dp = [], i, j;
  for (i = 0; i <= m; i++) {
    dp[i] = [i];
    for (j = 1; j <= n; j++) {
      dp[i][j] = i === 0 ? j :
        a[i-1] === b[j-1] ? dp[i-1][j-1] :
        1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}
function fuzzyNameMatch(a, b) {
  var lastA  = normalizeName(a.lastName),  lastB  = normalizeName(b.lastName);
  var firstA = normalizeName(a.firstName), firstB = normalizeName(b.firstName);
  var midA   = normalizeName(a.middleName),midB   = normalizeName(b.middleName);

  if (!lastA || !firstA || !lastB || !firstB) return false;

  // If first names are completely different, skip ? avoids false positives
  var firstDist = editDistance(firstA, firstB);
  var maxFirstLen = Math.max(firstA.length, firstB.length);
  // Allow at most 2 edits OR 25% of the longer name (whichever is smaller)
  var firstThreshold = Math.min(2, Math.floor(maxFirstLen * 0.25));
  if (firstDist > firstThreshold) return false;

  var lastDist  = editDistance(lastA, lastB);

  // Exact last + exact first
  if (lastA === lastB && firstA === firstB) return true;

  // Exact last + first name typo (dist = 1, min 4 chars)
  if (lastA === lastB && firstA.length >= 4 && firstB.length >= 4 && firstDist <= 1) return true;

  // Both last AND first are typos (dist <= 1 each, min 6 chars for last to avoid short name false positives)
  if (lastA.length >= 6 && lastB.length >= 6 && firstA.length >= 4 && firstB.length >= 4 &&
      lastDist <= 1 && firstDist <= 1) return true;

  // Both last AND first are typos with same middle name as anchor (dist <= 2 first, min 6 chars last)
  if (midA.length >= 4 && midA === midB &&
      lastA.length >= 6 && lastB.length >= 6 && lastDist <= 1 &&
      firstA.length >= 4 && firstB.length >= 4 && firstDist <= 2) return true;

  // Swapped last/first: a.lastName ? b.firstName AND a.firstName ? b.lastName (exact or dist = 1)
  var swapLastDist  = editDistance(lastA,  firstB);
  var swapFirstDist = editDistance(firstA, lastB);
  if (lastA.length >= 4 && firstB.length >= 4 && firstA.length >= 4 && lastB.length >= 4 &&
      swapLastDist <= 1 && swapFirstDist <= 1) return true;

  // Swapped last/middle: a.lastName = b.middleName AND a.middleName = b.lastName (same first name)
  if (firstA === firstB && midA.length >= 4 && midB.length >= 4 &&
      lastA.length >= 4 && lastB.length >= 4 &&
      editDistance(lastA, midB) <= 1 && editDistance(midA, lastB) <= 1) return true;

  return false;
}

// -- FIND DUPLICATE GROUPS ------------------------------------
// Returns array of groups, each group is an array of records with the same
// last+first name (excluding Jr./Sr. pairs which are different people)
function findDuplicateGroups(records) {
  function recGetSuffix(r) {
    var combined = [r.lastName, r.firstName, r.middleName, r.alias].join(' ').toUpperCase();
    var m = combined.match(/\b(JR\.?|SR\.?)\b/);
    return m ? m[1].replace('.', '') : '';
  }
  // Build groups using fuzzy matching ? O(n?) but fine for <1000 records
  var grouped = []; // array of arrays
  var assigned = {}; // id ? group index

  records.forEach(function(r) {
    if (assigned[r.id] !== undefined) return;
    var grpIdx = grouped.length;
    grouped.push([r]);
    assigned[r.id] = grpIdx;

    records.forEach(function(other) {
      if (other.id === r.id || assigned[other.id] !== undefined) return;
      var sufR = recGetSuffix(r), sufO = recGetSuffix(other);
      // Different JR/SR = different people
      if (sufR && sufO && sufR !== sufO) return;
      if (fuzzyNameMatch(r, other)) {
        grouped[grpIdx].push(other);
        assigned[other.id] = grpIdx;
      }
    });
  });

  // Keep only groups with 2+ members
  var duplicates = grouped.filter(function(g) { return g.length >= 2; });
  duplicates.sort(function(a, b) { return (a[0].lastName||'').localeCompare(b[0].lastName||''); });
  return duplicates;
}

// -- PRINT PHILHEALTH LIST ------------------------------------
function printPhilhealthList(hasPhilhealth) {
  function run(records) {
    var list = records.filter(function(r) {
      var asst = r.assistance || [];
      var has = asst.indexOf('PHILHEALTH') !== -1;
      return hasPhilhealth ? has : !has;
    }).slice().sort(function(a, b) {
      var la=(a.lastName||'').toUpperCase(), lb=(b.lastName||'').toUpperCase();
      var fa=(a.firstName||'').toUpperCase(), fb=(b.firstName||'').toUpperCase();
      if (la<lb) return -1; if (la>lb) return 1;
      if (fa<fb) return -1; if (fa>fb) return 1;
      return 0;
    });
    if (!list.length) { showToast('NO RECORDS FOUND', 'info'); return; }

    var title    = hasPhilhealth ? 'PROFILES WITH PHILHEALTH' : 'PROFILES WITHOUT PHILHEALTH';
    var printed  = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    var tableRows = list.map(function(r, i) {
      var philStatus = (r.assistance||[]).indexOf('PHILHEALTH') !== -1;
      var address = [r.addressBarangay||r.address, r.addressMunicipality, r.addressProvince].filter(Boolean).join(', ');
      return '<tr>' +
        '<td style="text-align:center">' + (i+1) + '</td>' +
        '<td><strong>' + (r.lastName||'') + ', ' + (r.firstName||'') + '</strong>' + (r.middleName ? ' ' + r.middleName : '') + '</td>' +
        '<td>' + (r.alias||'-') + '</td>' +
        '<td style="text-align:center">' + (r.sex||'-') + '</td>' +
        '<td style="text-align:center">' + calcAgeFromDob(r.dob) + '</td>' +
        '<td style="text-align:center">' + formatDate(r.dob) + '</td>' +
        '<td>' + (address||'-') + '</td>' +
        '<td style="text-align:center;color:' + (philStatus?'#3fb950':'#f85149') + ';font-weight:700">' + (philStatus?'YES':'NO') + '</td>' +
        '</tr>';
    }).join('');

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>' + title + '</p>' +
        '<p>Printed: ' + printed + ' &nbsp;|&nbsp; Printed by: ' + printedBy + '</p>' +
      '</div>' +
      '<table class="report-table" style="width:100%;font-size:10px">' +
        '<thead><tr>' +
          '<th style="text-align:center;width:30px">#</th>' +
          '<th>FULL NAME</th><th>ALIAS</th>' +
          '<th style="text-align:center">SEX</th>' +
          '<th style="text-align:center">AGE</th>' +
          '<th style="text-align:center">DATE OF BIRTH</th>' +
          '<th>ADDRESS</th>' +
          '<th style="text-align:center">PHILHEALTH</th>' +
        '</tr></thead>' +
        '<tbody>' + tableRows + '</tbody>' +
        '<tfoot><tr><td colspan="8" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
          'TOTAL: ' + list.length + ' RECORD' + (list.length!==1?'S':'') +
        '</td></tr></tfoot>' +
      '</table>';

    openPrintDocument('FR ' + title, body, REPORT_PRINT_STYLES);
    showToast('PRINT PREVIEW OPENED', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(recs) { allRecordsCache = recs; run(recs); });
}

// -- PRINT NON-4Ps LIST ---------------------------------------
function printNon4PsList() {
  function run(records) {
    var list = records.filter(function(r) { return r.fourPs !== 'YES'; })
      .slice().sort(function(a, b) {
        var la=(a.lastName||'').toUpperCase(), lb=(b.lastName||'').toUpperCase();
        var fa=(a.firstName||'').toUpperCase(), fb=(b.firstName||'').toUpperCase();
        if (la<lb) return -1; if (la>lb) return 1;
        if (fa<fb) return -1; if (fa>fb) return 1;
        return 0;
      });
    if (!list.length) { showToast('NO NON-4Ps RECORDS FOUND', 'info'); return; }

    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

    var tableRows = list.map(function(r, i) {
      return '<tr>' +
        '<td style="text-align:center">' + (i+1) + '</td>' +
        '<td><strong>' + (r.lastName||'') + ', ' + (r.firstName||'') + '</strong>' + (r.middleName ? ' ' + r.middleName : '') + '</td>' +
        '<td>' + (r.alias||'-') + '</td>' +
        '<td style="text-align:center">' + (r.sex||'-') + '</td>' +
        '<td style="text-align:center">' + calcAgeFromDob(r.dob) + '</td>' +
        '<td>' + ([r.addressBarangay||r.address, r.addressMunicipality, r.addressProvince].filter(Boolean).join(', ')||'-') + '</td>' +
        '<td style="text-align:center;color:' + (r.fourPs==='YES'?'#3fb950':'#f85149') + ';font-weight:700">' + (r.fourPs||'NO') + '</td>' +
        '</tr>';
    }).join('');

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>NON-4Ps MEMBERS LIST</p>' +
        '<p>Printed: ' + printed + ' &nbsp;|&nbsp; Printed by: ' + printedBy + '</p>' +
      '</div>' +
      '<table class="report-table" style="width:100%;font-size:10px">' +
        '<thead><tr>' +
          '<th style="text-align:center;width:30px">#</th>' +
          '<th>FULL NAME</th><th>ALIAS</th>' +
          '<th style="text-align:center">SEX</th>' +
          '<th style="text-align:center">AGE</th>' +
          '<th>ADDRESS</th>' +
          '<th style="text-align:center">4Ps STATUS</th>' +
        '</tr></thead>' +
        '<tbody>' + tableRows + '</tbody>' +
        '<tfoot><tr><td colspan="7" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
          'TOTAL: ' + list.length + ' RECORD' + (list.length!==1?'S':'') +
        '</td></tr></tfoot>' +
      '</table>';

    openPrintDocument('FR Non-4Ps Members', body, REPORT_PRINT_STYLES);
    showToast('PRINT PREVIEW OPENED', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(recs) { allRecordsCache = recs; run(recs); });
}

// -- PRINT DUPLICATES LIST ------------------------------------
function printDuplicatesList() {
  function run(records) {
    var groups = findDuplicateGroups(records);
    if (!groups.length) { showToast('NO POSSIBLE DUPLICATES FOUND', 'success'); return; }

    var printed   = new Date().toLocaleString('en-PH');
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';
    var totalPairs = groups.length;
    var totalRecords = groups.reduce(function(s, g) { return s + g.length; }, 0);

    var rows = '';
    groups.forEach(function(grp, gi) {
      grp.forEach(function(r, ri) {
        var age = calcAgeFromDob(r.dob);
        var bgStyle = ri % 2 === 0 ? 'background:#1a1f2e' : '';
        var firstCell = ri === 0
          ? '<td rowspan="' + grp.length + '" style="text-align:center;vertical-align:middle;font-weight:700;color:#f85149;font-size:1rem">' + (gi + 1) + '</td>'
          : '';
        rows += '<tr style="' + bgStyle + '">' +
          firstCell +
          '<td><strong>' + (r.lastName||'') + ', ' + (r.firstName||'') + '</strong>' + (r.middleName ? ' ' + r.middleName : '') + '</td>' +
          '<td>' + (r.alias||'-') + '</td>' +
          '<td style="text-align:center">' + (r.sex||'-') + '</td>' +
          '<td style="text-align:center">' + age + '</td>' +
          '<td style="text-align:center">' + formatDate(r.dob) + '</td>' +
          '<td>' + (r.referringUnit||'-') + '</td>' +
          '<td style="text-align:center">' + formatDate(r.dateSurrendered) + '</td>' +
          '<td><a onclick="return false" style="color:#388bfd;cursor:pointer" href="#">' + r.id + '</a></td>' +
          '</tr>';
      });
      rows += '<tr><td colspan="9" style="border:none;height:8px"></td></tr>';
    });

    var body =
      '<div class="print-header">' +
        '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
        '<p>POSSIBLE DUPLICATE PROFILES</p>' +
        '<p>Generated: ' + printed + ' &nbsp;|&nbsp; By: ' + printedBy + '</p>' +
      '</div>' +
      '<div style="margin-bottom:12px;font-size:11px"><strong>' + totalPairs + ' DUPLICATE GROUP' + (totalPairs !== 1 ? 'S' : '') + '</strong> &nbsp;|&nbsp; ' + totalRecords + ' TOTAL RECORDS AFFECTED</div>' +
      '<table class="report-table" style="width:100%;font-size:10px">' +
        '<thead><tr>' +
          '<th style="text-align:center;width:24px">#</th>' +
          '<th>FULL NAME</th><th>ALIAS</th>' +
          '<th style="text-align:center">SEX</th>' +
          '<th style="text-align:center">AGE</th>' +
          '<th style="text-align:center">DATE OF BIRTH</th>' +
          '<th>REFERRING UNIT</th>' +
          '<th style="text-align:center">DATE SURRENDERED</th>' +
          '<th>RECORD ID</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td colspan="9" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
          totalPairs + ' GROUP' + (totalPairs !== 1 ? 'S' : '') + ' - ' + totalRecords + ' RECORDS AFFECTED' +
        '</td></tr></tfoot>' +
      '</table>';

    openPrintDocument('Possible Duplicates', body, REPORT_PRINT_STYLES);
    showToast('DUPLICATES REPORT - ' + totalPairs + ' GROUP(S) FOUND', 'success');
  }
  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

// -- DOWNLOAD REPORT CSV --------------------------------------
function downloadReportCSV(type) {
  function run(records) {
    var csv, filename, count;
    var dateStr = new Date().toISOString().slice(0, 10);
    var printedBy = currentUser ? currentUser.username : 'ADMIN';

    function q(v) { return '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"'; }

    if (type === 'summary') {
      // Full database export with all fields
      var headers = ['#','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS','DATE OF BIRTH','AGE',
        'SEX','CIVIL STATUS','TRIBAL GROUP','STATUS','RELIGION','CONTACT NUMBER',
        'MEDICAL CONDITION','MEDICAL CONDITION SPECIFY','4Ps','PWD DISABILITY',
        'BARANGAY','MUNICIPALITY','PROVINCE','SECTOR','UNIT','POSITION',
        'MEMBERSHIP TYPE','AREA OF OPERATION','YEARS IN MOVEMENT','DATE SURRENDERED',
        'PENDING CASE','REFERRING UNIT','REMARKS','ASSISTANCE PROVIDED',
        'JAPIC ON FILE','SOCIAL CASE REPORT FILE','CREATED BY','CREATED AT'];
      var rows = records.map(function(r, i) {
        return [
          i+1, r.lastName, r.firstName, r.middleName, r.alias, r.dob,
          calcAgeFromDob(r.dob), r.sex, r.civilStatus,
          normalizeTribalGroup(r.tribalGroup)||r.tribalGroup,
          r.recordStatus||'', r.religion, r.contactNumber,
          r.medicalCondition, r.medicalConditionSpec, r.fourPs, r.pwdDisability,
          r.addressBarangay||r.address, r.addressMunicipality||'',
          r.addressProvince||'OCCIDENTAL MINDORO',
          (r.sector||[]).join('; '), r.unit, r.position, r.membershipType,
          r.areaOfOperation, r.yearsInMovement, r.dateSurrendered,
          r.pendingCase, r.referringUnit, r.remarks||'',
          (r.assistance||[]).join('; '),
          (r.japic && (r.japic.url||r.japic.dataUrl||r.japic.fileName)) ? 'YES' : 'NO',
          r.socialCaseReport ? (typeof r.socialCaseReport==='object' ? r.socialCaseReport.fileName : r.socialCaseReport) : '',
          r.createdBy, r.createdAt ? new Date(r.createdAt).toLocaleString('en-PH') : ''
        ].map(q);
      });
      count = records.length;
      filename = 'FR_SUMMARY_REPORT_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r){return r.join(',');})).join('\n');

    } else if (type === 'noeclip') {
      var list = records.filter(function(r) {
        var asst = r.assistance || [];
        return asst.indexOf('E-CLIP') === -1 && asst.indexOf('NOT QUALIFIED FOR E-CLIP') === -1;
      }).sort(function(a,b){return(a.lastName||'').localeCompare(b.lastName||'');});
      if (!list.length) { showToast('ALL PROFILES HAVE E-CLIP OR NOT QUALIFIED STATUS', 'success'); return; }
      var headers = ['#','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS','SEX','AGE',
        'REFERRING UNIT','DATE SURRENDERED','STATUS','CURRENT ASSISTANCE'];
      var rows = list.map(function(r, i) {
        return [i+1, r.lastName, r.firstName, r.middleName||'', r.alias||'',
          r.sex||'', calcAgeFromDob(r.dob), r.referringUnit||'',
          r.dateSurrendered||'', r.recordStatus||'',
          (r.assistance||[]).join('; ')].map(q);
      });
      count = list.length;
      filename = 'FR_NO_ECLIP_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r){return r.join(',');})).join('\n');

    } else if (type === 'nojapic') {
      var list = records.filter(function(r) {
        return !r.japic || !(r.japic.url || r.japic.dataUrl || r.japic.fileName);
      }).sort(function(a,b){return(a.lastName||'').localeCompare(b.lastName||'');});
      if (!list.length) { showToast('ALL PROFILES HAVE JAPIC ON FILE', 'success'); return; }
      var headers = ['#','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS','SEX','AGE',
        'REFERRING UNIT','DATE SURRENDERED','STATUS'];
      var rows = list.map(function(r, i) {
        return [i+1, r.lastName, r.firstName, r.middleName||'', r.alias||'',
          r.sex||'', calcAgeFromDob(r.dob),
          r.referringUnit||'', r.dateSurrendered||'', r.recordStatus||''].map(q);
      });
      count = list.length;
      filename = 'FR_NO_JAPIC_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r){return r.join(',');})).join('\n');

    } else if (type === 'withjapic') {
      var list = records.filter(function(r) {
        return r.japic && (r.japic.url || r.japic.dataUrl || r.japic.fileName);
      }).sort(function(a,b){return(a.lastName||'').localeCompare(b.lastName||'');});
      if (!list.length) { showToast('NO PROFILES WITH JAPIC ON FILE', 'info'); return; }
      var headers = ['#','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS','SEX','AGE',
        'REFERRING UNIT','DATE SURRENDERED','STATUS','JAPIC FILE'];
      var rows = list.map(function(r, i) {
        return [i+1, r.lastName, r.firstName, r.middleName||'', r.alias||'',
          r.sex||'', calcAgeFromDob(r.dob),
          r.referringUnit||'', r.dateSurrendered||'', r.recordStatus||'',
          r.japic.fileName||'ON FILE'].map(q);
      });
      count = list.length;
      filename = 'FR_WITH_JAPIC_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r){return r.join(',');})).join('\n');

    } else if (type === 'incomplete') {
      var list = records.filter(function(r) {
        return getMissingFieldsGlobal(r).length > 0;
      }).sort(function(a,b){return(a.lastName||'').localeCompare(b.lastName||'');});
      if (!list.length) { showToast('ALL PROFILES HAVE COMPLETE DATA', 'success'); return; }
      var headers = ['#','LAST NAME','FIRST NAME','MIDDLE NAME','REFERRING UNIT','MISSING FIELDS'];
      var rows = list.map(function(r, i) {
        return [i+1, r.lastName, r.firstName, r.middleName||'',
          r.referringUnit||'', getMissingFieldsGlobal(r).join('; ')].map(q);
      });
      count = list.length;
      filename = 'FR_INCOMPLETE_DATA_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r){return r.join(',');})).join('\n');

    } else if (type === 'fulllist') {
      var list = records.slice().sort(function(a, b) {
        var la = (a.lastName  || '').toUpperCase();
        var lb = (b.lastName  || '').toUpperCase();
        var fa = (a.firstName || '').toUpperCase();
        var fb = (b.firstName || '').toUpperCase();
        if (la < lb) return -1; if (la > lb) return 1;
        if (fa < fb) return -1; if (fa > fb) return 1;
        return 0;
      });
      var headers = ['#','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS',
        'REFERRING UNIT','SEX','AGE','DATE OF BIRTH','CURRENT ASSISTANCE'];
      var rows = list.map(function(r, i) {
        return [
          i + 1,
          r.lastName   || '',
          r.firstName  || '',
          r.middleName || '',
          r.alias      || '',
          r.referringUnit || '',
          r.sex        || '',
          calcAgeFromDob(r.dob),
          r.dob || '',
          (r.assistance || []).join('; ')
        ].map(q);
      });
      count    = list.length;
      filename = 'FR_FULL_LIST_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r) { return r.join(','); })).join('\n');

    } else if (type === 'non4ps') {
      var list = records.filter(function(r) { return r.fourPs !== 'YES'; })
        .slice().sort(function(a, b) {
          var la = (a.lastName  || '').toUpperCase(), lb = (b.lastName  || '').toUpperCase();
          var fa = (a.firstName || '').toUpperCase(), fb = (b.firstName || '').toUpperCase();
          if (la < lb) return -1; if (la > lb) return 1;
          if (fa < fb) return -1; if (fa > fb) return 1;
          return 0;
        });
      var headers = ['#','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS',
        'SEX','AGE','ADDRESS','4Ps STATUS'];
      var rows = list.map(function(r, i) {
        var addr = [r.addressBarangay||r.address, r.addressMunicipality, r.addressProvince].filter(Boolean).join(', ');
        return [i+1, r.lastName||'', r.firstName||'', r.middleName||'', r.alias||'',
          r.sex||'', calcAgeFromDob(r.dob), addr, r.fourPs||'NO'].map(q);
      });
      count    = list.length;
      filename = 'FR_NON_4PS_MEMBERS_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r) { return r.join(','); })).join('\n');

    } else if (type === 'philhealth' || type === 'nophilhealth') {
      var wantPhil = type === 'philhealth';
      var list = records.filter(function(r) {
        var has = (r.assistance||[]).indexOf('PHILHEALTH') !== -1;
        return wantPhil ? has : !has;
      }).slice().sort(function(a,b){var la=(a.lastName||'').toUpperCase(),lb=(b.lastName||'').toUpperCase(),fa=(a.firstName||'').toUpperCase(),fb=(b.firstName||'').toUpperCase();if(la<lb)return -1;if(la>lb)return 1;if(fa<fb)return -1;if(fa>fb)return 1;return 0;});
      var headers = ['#','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS','SEX','AGE','DATE OF BIRTH','ADDRESS','PHILHEALTH'];
      var rows = list.map(function(r,i){
        var has=(r.assistance||[]).indexOf('PHILHEALTH')!==-1;
        var addr=[r.addressBarangay||r.address,r.addressMunicipality,r.addressProvince].filter(Boolean).join(', ');
        return [i+1,r.lastName||'',r.firstName||'',r.middleName||'',r.alias||'',r.sex||'',calcAgeFromDob(r.dob),r.dob||'',addr,has?'YES':'NO'].map(q);
      });
      count    = list.length;
      filename = 'FR_' + (wantPhil?'WITH':'WITHOUT') + '_PHILHEALTH_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r){return r.join(',');})).join('\n');

    } else if (type === 'duplicates') {
      var groups = findDuplicateGroups(records);
      if (!groups.length) { showToast('NO POSSIBLE DUPLICATES FOUND', 'success'); return; }
      var headers = ['GROUP #','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS',
        'SEX','AGE','DATE OF BIRTH','REFERRING UNIT','DATE SURRENDERED','RECORD ID'];
      var rows = [];
      groups.forEach(function(grp, gi) {
        grp.forEach(function(r) {
          rows.push([gi+1, r.lastName, r.firstName, r.middleName||'', r.alias||'',
            r.sex||'', calcAgeFromDob(r.dob), r.dob||'',
            r.referringUnit||'', r.dateSurrendered||'', r.id].map(q));
        });
        rows.push(['---','---','---','---','---','---','---','---','---','---','---'].map(q));
      });
      count = groups.reduce(function(s, g) { return s + g.length; }, 0);
      filename = 'FR_POSSIBLE_DUPLICATES_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r){return r.join(',');})).join('\n');

    } else if (type === 'unitsummary') {
      var unitMap = {};
      records.forEach(function(r) {
        var unit = (r.referringUnit || 'NOT SPECIFIED').trim().toUpperCase();
        if (!unitMap[unit]) unitMap[unit] = { total: 0, regularNpa: 0, milisyang: 0, noType: 0, noJapic: 0 };
        unitMap[unit].total++;
        if (r.membershipType === 'REGULAR NPA')          unitMap[unit].regularNpa++;
        else if (r.membershipType === 'MILISYANG BAYAN') unitMap[unit].milisyang++;
        else                                             unitMap[unit].noType++;
        if (!r.japic || !(r.japic.url || r.japic.dataUrl || r.japic.fileName)) unitMap[unit].noJapic++;
      });
      var units = Object.keys(unitMap).sort(function(a, b) {
        if (a === 'NOT SPECIFIED') return 1;
        if (b === 'NOT SPECIFIED') return -1;
        return a.localeCompare(b);
      });
      var headers = ['#', 'REFERRING UNIT', 'TOTAL FRs', 'REGULAR NPA', 'MILISYANG BAYAN', 'NOT SPECIFIED', 'NO JAPIC'];
      var rows = units.map(function(unit, i) {
        var d = unitMap[unit];
        return [i + 1, unit, d.total, d.regularNpa, d.milisyang, d.noType, d.noJapic].map(q);
      });
      var gt = 0, gnpa = 0, gmb = 0, gno = 0, gnj = 0;
      units.forEach(function(u) { gt += unitMap[u].total; gnpa += unitMap[u].regularNpa; gmb += unitMap[u].milisyang; gno += unitMap[u].noType; gnj += unitMap[u].noJapic; });
      rows.push(['', 'GRAND TOTAL', gt, gnpa, gmb, gno, gnj].map(q));
      count    = units.length;
      filename = 'FR_PER_UNIT_SUMMARY_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r) { return r.join(','); })).join('\n');

    } else if (type === 'assistance') {
      var list = records.slice().sort(function(a,b){
        var la=(a.lastName||'').toUpperCase(),lb=(b.lastName||'').toUpperCase();
        var fa=(a.firstName||'').toUpperCase(),fb=(b.firstName||'').toUpperCase();
        if(la<lb)return -1;if(la>lb)return 1;if(fa<fb)return -1;if(fa>fb)return 1;return 0;
      });
      var headers = ['#','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS','SEX','AGE','DATE OF BIRTH','REFERRING UNIT','ASSISTANCE PROVIDED'];
      var rows = list.map(function(r,i){
        return [
          i+1,
          r.lastName||'',
          r.firstName||'',
          r.middleName||'',
          r.alias||'',
          r.sex||'',
          calcAgeFromDob(r.dob),
          r.dob||'',
          r.referringUnit||'',
          (r.assistance||[]).join('; ')
        ].map(q);
      });
      count    = list.length;
      filename = 'FR_ASSISTANCE_REPORT_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r){return r.join(',');})).join('\n');
    }

    else if (type === 'noassistance') {
      var list = records.filter(function(r) {
        return !r.assistance || r.assistance.length === 0;
      }).slice().sort(function(a,b){
        var la=(a.lastName||'').toUpperCase(),lb=(b.lastName||'').toUpperCase();
        var fa=(a.firstName||'').toUpperCase(),fb=(b.firstName||'').toUpperCase();
        if(la<lb)return -1;if(la>lb)return 1;if(fa<fb)return -1;if(fa>fb)return 1;return 0;
      });
      if (!list.length) { showToast('ALL PROFILES HAVE ASSISTANCE RECORDED', 'success'); return; }
      var headers = ['#','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS',
        'SEX','AGE','REFERRING UNIT','DATE SURRENDERED','STATUS'];
      var rows = list.map(function(r, i) {
        return [i+1, r.lastName||'', r.firstName||'', r.middleName||'', r.alias||'',
          r.sex||'', calcAgeFromDob(r.dob), r.referringUnit||'',
          r.dateSurrendered||'', r.recordStatus||'ACTIVE'].map(q);
      });
      count    = list.length;
      filename = 'FR_NO_ASSISTANCE_' + dateStr + '.csv';
      csv = [headers.map(q).join(',')].concat(rows.map(function(r){return r.join(',');})).join('\n');
    }

    var blob = new Blob([csv], { type: 'text/csv' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast('CSV DOWNLOADED - ' + count + ' RECORD' + (count !== 1 ? 'S' : ''), 'success');
  }

  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records) { allRecordsCache = records; run(records); })
    .catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}


// -- DASHBOARD REPORT HTML ------------------------------------
function buildDashboardReportHtml(records) {
  var total = records.length;
  var male = 0, female = 0, regularNpa = 0, milisyang = 0, cannotLocate = 0, deceased = 0, incarcerated = 0;
  records.forEach(function(r) {
    if (r.sex === 'MALE') male++;
    if (r.sex === 'FEMALE') female++;
    if (r.membershipType === 'REGULAR NPA') regularNpa++;
    if (r.membershipType === 'MILISYANG BAYAN') milisyang++;
    if (r.recordStatus === 'CANNOT BE LOCATED') cannotLocate++;
    if (r.recordStatus === 'DECEASED') deceased++;
    if (r.recordStatus === 'INCARCERATED') incarcerated++;
  });

  // ASSISTANCE
  var ASST_TYPES = ['E-CLIP','NOT QUALIFIED FOR E-CLIP','FEA REMUNERATION','LIVELIHOOD','MEDICAL','EDUCATIONAL','ISSUANCE OF CREDENTIALS','PHILHEALTH','ISSUANCE OF SAFE CONDUCT PASS','APPLIED FOR AMNESTY','OTHERS'];
  var asstCounts = {}; ASST_TYPES.forEach(function(t){asstCounts[t]=0;});
  records.forEach(function(r){(r.assistance||[]).forEach(function(a){var k=a.indexOf('OTHERS')===0?'OTHERS':a;if(asstCounts[k]!==undefined)asstCounts[k]++;});});
  // NO E-CLIP = records that have neither E-CLIP nor NOT QUALIFIED FOR E-CLIP
  var noEclipCount = records.filter(function(r){
    var asst = r.assistance||[];
    return asst.indexOf('E-CLIP')===-1 && asst.indexOf('NOT QUALIFIED FOR E-CLIP')===-1;
  }).length;
  var asstRows = ASST_TYPES.map(function(t){var c=asstCounts[t];return[t,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];});
  asstRows.push(['NO E-CLIP', noEclipCount, total>0?((noEclipCount/total)*100).toFixed(1)+'%':'0.0%']);
  asstRows.push(['TOTAL ASSISTANCE RENDERED', ASST_TYPES.filter(function(t){return t!=='NOT QUALIFIED FOR E-CLIP';}).reduce(function(s,t){return s+asstCounts[t];},0), '-']);

  // JAPIC
  var noJapicCount = records.filter(function(r) {
    return !r.japic || !(r.japic.url || r.japic.dataUrl || r.japic.fileName);
  }).length;
  var withJapicCount = total - noJapicCount;
  var japicRows = [
    ['WITH JAPIC ON FILE',    withJapicCount, total>0?((withJapicCount/total)*100).toFixed(1)+'%':'0.0%'],
    ['WITHOUT JAPIC ON FILE', noJapicCount,   total>0?((noJapicCount/total)*100).toFixed(1)+'%':'0.0%']
  ];

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
  var ipCount    = TRIBAL_GROUP_TYPES.filter(function(t){return t!=='NO TRIBAL GROUP';}).reduce(function(s,t){return s+tribalCounts[t];},0);
  var nonIpCount = tribalCounts['NO TRIBAL GROUP'];
  var tribalRows = [['IP (INDIGENOUS PEOPLE)', ipCount, total>0?((ipCount/total)*100).toFixed(1)+'%':'0.0%'],
                    ['NON-IP (NO TRIBAL GROUP)', nonIpCount, total>0?((nonIpCount/total)*100).toFixed(1)+'%':'0.0%']];
  tribalRows = tribalRows.concat(TRIBAL_GROUP_TYPES.map(function(t){var c=tribalCounts[t];return['\u00A0\u00A0'+t,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];}));
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
  var SECTORS=['FARMER','FISHERFOLK','WOMEN','PWD','CHILDREN AND YOUTH','SENIOR CITIZEN','SOLO PARENT','INDIGENOUS PEOPLE','URBAN POOR','OTHERS'];
  var secCounts={}; SECTORS.forEach(function(s){secCounts[s]=0;});
  records.forEach(function(r){(r.sector||[]).forEach(function(s){
    // backward compat: split old combined value
    if(s==='FARMER/FISHERFOLK'){secCounts['FARMER']++;secCounts['FISHERFOLK']++;return;}
    var k=s.indexOf('OTHERS')===0?'OTHERS':s;if(secCounts[k]!==undefined)secCounts[k]++;
  });});
  var withSec=records.filter(function(r){return r.sector&&r.sector.length>0;}).length;
  var secRows=SECTORS.map(function(s){var c=secCounts[s];return[s,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];});
  secRows.push(['NO SECTOR SPECIFIED',total-withSec,total>0?(((total-withSec)/total)*100).toFixed(1)+'%':'0.0%']);

  // REFERRING UNIT
  var UNITS=['102nd SAC','1st Infantry "Always First" Battalion','1st OMPMFC','203rd Infantry "Bantay Kapayapaan" Brigade','23MICO','2CMO Battalion','2nd OMPMFC','402nd B MC RMFB 4B','405th B MC RMFB 4B','4th Infantry "Scorpion" Battalion','68th Infantry "Kaagapay" Battalion','76th Infantry "Victrix" Battalion','ISAFP','PIU','PIT Occidental Mindoro RIU 4B','OTHERS'];
  var unitCounts={}; UNITS.forEach(function(u){unitCounts[u]=0;}); var noUnit=0;
  records.forEach(function(r){var u=r.referringUnit||'';if(!u){noUnit++;return;}var k=u.indexOf('OTHERS')===0?'OTHERS':u;if(unitCounts[k]!==undefined)unitCounts[k]++;else noUnit++;});
  var unitRows=UNITS.map(function(u){var c=unitCounts[u];return[u,c,total>0?((c/total)*100).toFixed(1)+'%':'0.0%'];});
  unitRows.push(['NOT SPECIFIED',noUnit,total>0?((noUnit/total)*100).toFixed(1)+'%':'0.0%']);

  // STATUS
  var activeCount = total - cannotLocate - deceased - incarcerated;
  var statusRows = [
    ['ACTIVE / NO STATUS', activeCount,    total>0?((activeCount/total)*100).toFixed(1)+'%':'0.0%'],
    ['CANNOT BE LOCATED',  cannotLocate,   total>0?((cannotLocate/total)*100).toFixed(1)+'%':'0.0%'],
    ['DECEASED',           deceased,       total>0?((deceased/total)*100).toFixed(1)+'%':'0.0%'],
    ['INCARCERATED',       incarcerated,   total>0?((incarcerated/total)*100).toFixed(1)+'%':'0.0%']
  ];

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
      '<div class="report-stat report-stat--warning"><strong>'+cannotLocate+'</strong><span>CANNOT BE LOCATED</span></div>' +
      '<div class="report-stat report-stat--danger"><strong>'+deceased+'</strong><span>DECEASED</span></div>' +
      '<div class="report-stat report-stat--purple"><strong>'+incarcerated+'</strong><span>INCARCERATED</span></div>' +
    '</div></div>' +
    '<div class="report-section"><h2>STATUS - CANNOT BE LOCATED / DECEASED</h2>' + buildReportTable(['STATUS','COUNT','% OF TOTAL'], statusRows) + '</div>' +
    '<div class="report-section"><h2>ASSISTANCE PROVIDED</h2>' + buildReportTable(['TYPE OF ASSISTANCE','COUNT','% OF TOTAL'], asstRows) + '</div>' +
    '<div class="report-section"><h2>JAPIC CERTIFICATE STATUS</h2>' + buildReportTable(['JAPIC STATUS','COUNT','% OF TOTAL'], japicRows) + '</div>' +
    '<div class="report-section"><h2>SURRENDER BY YEAR ('+START_YEAR+'?'+curYear+')</h2>' + buildReportTable(['YEAR','COUNT','% OF TOTAL'], yrRows) + '</div>' +
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
  var ASST_TYPES = ['E-CLIP','NOT QUALIFIED FOR E-CLIP','FEA REMUNERATION','LIVELIHOOD','MEDICAL','EDUCATIONAL','ISSUANCE OF CREDENTIALS','PHILHEALTH','ISSUANCE OF SAFE CONDUCT PASS','APPLIED FOR AMNESTY','OTHERS'];
  var SHORT = {'E-CLIP':'E-CLIP','NOT QUALIFIED FOR E-CLIP':'NOT QUAL.','FEA REMUNERATION':'FEA','LIVELIHOOD':'LIVELIHOOD','MEDICAL':'MEDICAL','EDUCATIONAL':'EDUCATIONAL','ISSUANCE OF CREDENTIALS':'CREDENTIALS','PHILHEALTH':'PHILHEALTH','ISSUANCE OF SAFE CONDUCT PASS':'SAFE CONDUCT','APPLIED FOR AMNESTY':'AMNESTY','OTHERS':'OTHERS'};
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

  // IP vs Non-IP counts
  var ipCount    = TYPES.filter(function(t){return t!=='NO TRIBAL GROUP';}).reduce(function(s,t){return s+counts[t];},0);
  var nonIpCount = counts['NO TRIBAL GROUP'];
  var noDataCount = total - withType;

  document.getElementById('tribalTotalBadge').textContent = ipCount + ' IP / ' + nonIpCount + ' NON-IP';

  // IP vs Non-IP stat badges
  var ipBadge = document.getElementById('statIP');
  var nonIpBadge = document.getElementById('statNonIP');
  if (ipBadge) ipBadge.textContent = ipCount;
  if (nonIpBadge) nonIpBadge.textContent = nonIpCount;

  // Main tribal donut
  var canvas=document.getElementById('tribalDonut'),ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,160,160);
  var cx=80,cy=80,r=60,inner=36,total2=withType||1,startAngle=-Math.PI/2;
  TYPES.forEach(function(type){var slice=(counts[type]/total2)*2*Math.PI;ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,startAngle,startAngle+slice);ctx.closePath();ctx.fillStyle=COLORS[type];ctx.fill();startAngle+=slice;});
  ctx.beginPath();ctx.arc(cx,cy,inner,0,2*Math.PI);ctx.fillStyle='#161b22';ctx.fill();
  ctx.fillStyle='#e6edf3';ctx.font='bold 18px Segoe UI,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(withType,cx,cy);
  document.getElementById('tribalLegend').innerHTML=TYPES.map(function(t){return '<div class="donut-legend-item"><span class="donut-dot" style="background:'+COLORS[t]+'"></span><span>'+t+'</span><strong>'+counts[t]+'</strong></div>';}).join('');

  // IP vs Non-IP pie chart
  var ipCanvas = document.getElementById('ipPieChart');
  if (ipCanvas) {
    var ipCtx = ipCanvas.getContext('2d');
    ipCtx.clearRect(0,0,160,160);
    var ipSlices = [
      { label:'IP',      count:ipCount,    color:'#3fb950' },
      { label:'NON-IP',  count:nonIpCount, color:'#6e7681' },
      { label:'NO DATA', count:noDataCount,color:'#30363d' }
    ];
    var ipTotal = ipSlices.reduce(function(s,sl){return s+sl.count;},0) || 1;
    var sa = -Math.PI/2;
    ipSlices.forEach(function(sl){
      if(!sl.count) return;
      var slice=(sl.count/ipTotal)*2*Math.PI;
      ipCtx.beginPath();ipCtx.moveTo(80,80);ipCtx.arc(80,80,60,sa,sa+slice);ipCtx.closePath();
      ipCtx.fillStyle=sl.color;ipCtx.fill();
      sa+=slice;
    });
    ipCtx.beginPath();ipCtx.arc(80,80,36,0,2*Math.PI);ipCtx.fillStyle='#161b22';ipCtx.fill();
    ipCtx.fillStyle='#e6edf3';ipCtx.font='bold 14px Segoe UI,sans-serif';ipCtx.textAlign='center';ipCtx.textBaseline='middle';
    ipCtx.fillText(total,80,80);
    var ipLegend = document.getElementById('ipPieLegend');
    if (ipLegend) {
      ipLegend.innerHTML = ipSlices.map(function(sl){
        var pct = total > 0 ? ((sl.count/total)*100).toFixed(1) : '0.0';
        return '<div class="donut-legend-item"><span class="donut-dot" style="background:'+sl.color+'"></span>' +
          '<span>'+sl.label+'</span><strong>'+sl.count+' <span style="font-weight:400;color:var(--text3);font-size:0.7rem">('+pct+'%)</span></strong></div>';
      }).join('');
    }
  }

  document.getElementById('tribalTableBody').innerHTML=TYPES.map(function(type){
    var count=counts[type],pct=total>0?((count/total)*100).toFixed(1):'0.0',barW=total>0?Math.round((count/total)*100):0;
    return '<tr><td><span class="donut-dot" style="background:'+COLORS[type]+';display:inline-block;margin-right:6px"></span>'+type+'</td><td style="text-align:center;font-weight:700;color:'+COLORS[type]+'">'+count+'</td><td style="text-align:center">'+pct+'%</td><td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:'+barW+'%;background:'+COLORS[type]+'"></div></div></td></tr>';
  }).join('')+'<tr style="border-top:2px solid var(--border);background:var(--bg3)"><td style="font-weight:700">NOT SPECIFIED</td><td style="text-align:center;font-weight:700;color:var(--text2)">'+noDataCount+'</td><td style="text-align:center">'+(total>0?((noDataCount/total)*100).toFixed(1):'0.0')+'%</td><td></td></tr>';
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

// -- PHILHEALTH REPORT ----------------------------------------
function renderPhilhealthReport(records) {
  var total = records.length;
  var yes   = records.filter(function(r) { return (r.assistance||[]).indexOf('PHILHEALTH') !== -1; }).length;
  var no    = total - yes;
  document.getElementById('philhealthTotalBadge').textContent = yes + ' WITH PHILHEALTH';
  var rows = [
    { label: 'WITH PHILHEALTH',    count: yes, color: '#3fb950' },
    { label: 'WITHOUT PHILHEALTH', count: no,  color: '#f85149' }
  ];
  var maxCount = Math.max.apply(null, rows.map(function(r) { return r.count; }).concat([1]));
  document.getElementById('philhealthBars').innerHTML = rows.map(function(r) {
    var barPx = Math.max(Math.round((r.count / maxCount) * 110), r.count > 0 ? 4 : 0);
    return '<div class="asst-bar-group"><div class="asst-bar-wrap">' +
      '<div class="asst-bar-count">' + r.count + '</div>' +
      '<div class="asst-bar" style="height:' + barPx + 'px;background:linear-gradient(180deg,' + r.color + ' 0%,' + r.color + '99 100%)" title="' + r.label + ': ' + r.count + '"></div>' +
      '</div><div class="asst-bar-label">' + r.label + '</div></div>';
  }).join('');
  document.getElementById('philhealthTableBody').innerHTML = rows.map(function(r) {
    var pct  = total > 0 ? ((r.count / total) * 100).toFixed(1) : '0.0';
    var barW = total > 0 ? Math.round((r.count / total) * 100) : 0;
    return '<tr class="' + (r.count === 0 ? 'asst-zero' : '') + '">' +
      '<td><span class="donut-dot" style="background:' + r.color + ';display:inline-block;margin-right:6px"></span>' + r.label + '</td>' +
      '<td style="text-align:center;font-weight:' + (r.count > 0 ? '700' : '400') + ';color:' + (r.count > 0 ? r.color : 'var(--text3)') + '">' + r.count + '</td>' +
      '<td style="text-align:center">' + pct + '%</td>' +
      '<td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:' + barW + '%;background:' + r.color + '"></div></div></td>' +
    '</tr>';
  }).join('');
}

function renderSectorReport(records) {
  var SECTORS=['FARMER','FISHERFOLK','WOMEN','PWD','CHILDREN AND YOUTH','SENIOR CITIZEN','SOLO PARENT','INDIGENOUS PEOPLE','URBAN POOR','OTHERS'];
  var COLORS=['#3fb950','#58a6ff','#a371f7','#f85149','#388bfd','#d29922','#79c0ff','#39d353','#ffa657','#6e7681'];
  var total=records.length, counts={}; SECTORS.forEach(function(s){counts[s]=0;});
  records.forEach(function(r){(r.sector||[]).forEach(function(s){
    // backward compat: split old combined value
    if(s==='FARMER/FISHERFOLK'){counts['FARMER']++;counts['FISHERFOLK']++;return;}
    var key=s.indexOf('OTHERS')===0?'OTHERS':s;if(counts[key]!==undefined)counts[key]++;
  });});
  var withSector=records.filter(function(r){return r.sector&&r.sector.length>0;}).length;
  var maxCount=Math.max.apply(null,SECTORS.map(function(s){return counts[s];}).concat([1]));
  document.getElementById('sectorTotalBadge').textContent=withSector+' WITH SECTOR';
  document.getElementById('sectorBars').innerHTML=SECTORS.map(function(s,i){var count=counts[s],barPx=Math.max(Math.round((count/maxCount)*110),count>0?4:0);return '<div class="asst-bar-group"><div class="asst-bar-wrap"><div class="asst-bar-count">'+count+'</div><div class="asst-bar" style="height:'+barPx+'px;background:linear-gradient(180deg,'+COLORS[i]+' 0%,'+COLORS[i]+'99 100%)" title="'+s+': '+count+'"></div></div><div class="asst-bar-label" style="font-size:0.6rem">'+s+'</div></div>';}).join('');
  document.getElementById('sectorTableBody').innerHTML=SECTORS.map(function(s,i){var count=counts[s],pct=total>0?((count/total)*100).toFixed(1):'0.0',barW=total>0?Math.round((count/total)*100):0;return '<tr class="'+(count===0?'asst-zero':'')+'"><td><span class="donut-dot" style="background:'+COLORS[i]+';display:inline-block;margin-right:6px"></span>'+s+'</td><td style="text-align:center;font-weight:'+(count>0?'700':'400')+';color:'+(count>0?COLORS[i]:'var(--text3)')+'">'+count+'</td><td style="text-align:center">'+pct+'%</td><td><div class="asst-mini-bar-wrap"><div class="asst-mini-bar" style="width:'+barW+'%;background:'+COLORS[i]+'"></div></div></td></tr>';}).join('');
  document.getElementById('sectorTableFoot').innerHTML='<tr class="asst-tfoot-row"><td>RECORDS WITH NO SECTOR</td><td style="text-align:center">'+(total-withSector)+'</td><td style="text-align:center">'+(total>0?(((total-withSector)/total)*100).toFixed(1):'0.0')+'%</td><td></td></tr>';
}

function renderReferringUnitReport(records) {
  var UNITS=['102nd SAC','1st Infantry "Always First" Battalion','1st OMPMFC','203rd Infantry "Bantay Kapayapaan" Brigade','23MICO','2CMO Battalion','2nd OMPMFC','402nd B MC RMFB 4B','405th B MC RMFB 4B','4th Infantry "Scorpion" Battalion','68th Infantry "Kaagapay" Battalion','76th Infantry "Victrix" Battalion','ISAFP','PIU','PIT Occidental Mindoro RIU 4B','OTHERS'];
  var COLORS=['#388bfd','#3fb950','#d29922','#f85149','#a371f7','#39d353','#58a6ff','#79c0ff','#ffa657','#ff7b72','#56d364','#e3b341','#2ea043','#db6d28','#1f6feb','#6e7681'];
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
function renderRecords(records, filter, unitFilter, membershipFilter, yearFilter) {
  filter           = filter           || '';
  unitFilter       = unitFilter       || '';
  membershipFilter = membershipFilter || '';
  yearFilter       = yearFilter       || '';
  var list = records;
  if (filter) {
    var q = filter.toLowerCase();
    list = list.filter(function(r) {
      var asst = r.assistance || [];
      var eclipStatus = asst.indexOf('E-CLIP') !== -1
        ? 'e-clip'
        : asst.indexOf('NOT QUALIFIED FOR E-CLIP') !== -1
          ? 'not qualified for e-clip not qualified'
          : 'no e-clip';
      return (r.lastName+' '+r.firstName+' '+(r.middleName||'')).toLowerCase().indexOf(q)!==-1 ||
        (r.alias||'').toLowerCase().indexOf(q)!==-1 ||
        (r.unit||'').toLowerCase().indexOf(q)!==-1 ||
        (r.referringUnit||'').toLowerCase().indexOf(q)!==-1 ||
        (r.tribalGroup||'').toLowerCase().indexOf(q)!==-1 ||
        eclipStatus.indexOf(q) !== -1;
    });
  }
  if (membershipFilter) {
    list = list.filter(function(r) { return r.membershipType === membershipFilter; });
  }
  if (unitFilter) {
    list = list.filter(function(r) {
      var ru = r.referringUnit || '';
      // match exact unit name, or OTHERS prefix for free-text entries
      if (unitFilter === 'OTHERS') return ru.indexOf('OTHERS') === 0;
      return ru === unitFilter;
    });
  }
  if (yearFilter) {
    list = list.filter(function(r) {
      if (!r.dateSurrendered) return false;
      return new Date(r.dateSurrendered).getFullYear().toString() === yearFilter;
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
  filteredRecordsCache = list; // keep reference for print/export
  populateYearFilter(records); // rebuild year options from full dataset
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

// Tracks the last rendered filtered list so print/export can use it
var filteredRecordsCache = [];

// -- POPULATE YEAR FILTER -------------------------------------
function populateYearFilter(records) {
  var sel = document.getElementById('yearFilterSelect');
  if (!sel) return;
  var current = sel.value; // preserve selection across refreshes
  var years = {};
  records.forEach(function(r) {
    if (r.dateSurrendered) {
      var y = new Date(r.dateSurrendered).getFullYear();
      if (!isNaN(y)) years[y] = true;
    }
  });
  var sorted = Object.keys(years).map(Number).sort(function(a, b) { return b - a; }); // newest first
  sel.innerHTML = '<option value="">ALL YEARS</option>' +
    sorted.map(function(y) {
      return '<option value="' + y + '"' + (current === String(y) ? ' selected' : '') + '>' + y + '</option>';
    }).join('');
}

function filterRecords() {
  var search           = document.getElementById('searchInput').value;
  var unitFilter       = document.getElementById('unitFilterSelect').value;
  var membershipFilter = document.getElementById('membershipFilterSelect').value;
  var yearFilter       = document.getElementById('yearFilterSelect') ? document.getElementById('yearFilterSelect').value : '';
  renderRecords(allRecordsCache, search, unitFilter, membershipFilter, yearFilter);
  // Show print button whenever any filter is active
  var printBtn = document.getElementById('printFilteredBtn');
  if (printBtn) printBtn.style.display = (search || unitFilter || membershipFilter || yearFilter) ? 'inline-flex' : 'none';
}

// -- PRINT FILTERED RECORDS LIST ------------------------------
function printFilteredRecords() {
  var list = filteredRecordsCache;
  if (!list || !list.length) { showToast('NO RECORDS TO PRINT', 'info'); return; }

  var unitFilter = document.getElementById('unitFilterSelect').value;
  var search     = document.getElementById('searchInput').value;
  var printed    = new Date().toLocaleString('en-PH');
  var printedBy  = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';

  var filterDesc = [];
  if (unitFilter) filterDesc.push('REFERRING UNIT: ' + unitFilter);
  if (search)     filterDesc.push('SEARCH: ' + search.toUpperCase());
  var filterLine = filterDesc.length ? filterDesc.join(' &nbsp;|&nbsp; ') : 'ALL RECORDS';

  var tableRows = list.map(function(r, i) {
    var age = calcAgeFromDob(r.dob);
    var statusStyle = '';
    if (r.recordStatus === 'DECEASED')          statusStyle = 'color:#cf222e;font-weight:700';
    if (r.recordStatus === 'CANNOT BE LOCATED') statusStyle = 'color:#9a6700;font-weight:700';
    if (r.recordStatus === 'INCARCERATED')      statusStyle = 'color:#7a43b6;font-weight:700';
    var hasJapic = r.japic && (r.japic.url || r.japic.fileName);
    var japicCell = hasJapic
      ? '<span style="color:#1a7f37;font-weight:700">YES</span>'
      : '<span style="color:#cf222e;font-weight:700">NO</span>';
    return '<tr>' +
      '<td style="text-align:center">' + (i + 1) + '</td>' +
      '<td><strong>' + (r.lastName || '') + ', ' + (r.firstName || '') + '</strong>' + (r.middleName ? ' ' + r.middleName : '') + '</td>' +
      '<td>' + (r.alias || '-') + '</td>' +
      '<td style="text-align:center">' + (r.sex || '-') + '</td>' +
      '<td style="text-align:center">' + age + '</td>' +
      '<td>' + (r.membershipType || '-') + '</td>' +
      '<td>' + (r.referringUnit || '-') + '</td>' +
      '<td style="text-align:center">' + formatDate(r.dateSurrendered) + '</td>' +
      '<td style="text-align:center">' + japicCell + '</td>' +
      '<td style="' + statusStyle + '">' + (r.recordStatus || 'ACTIVE') + '</td>' +
      '</tr>';
  }).join('');

  var body =
    '<div class="print-header">' +
      '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
      '<p>RECORDS LIST</p>' +
      '<p style="font-size:10px">Filter: ' + filterLine + '</p>' +
      '<p>Printed: ' + printed + ' &nbsp;|&nbsp; Printed by: ' + printedBy + '</p>' +
    '</div>' +
    '<table class="report-table" style="width:100%;font-size:10px">' +
      '<thead><tr>' +
        '<th style="text-align:center;width:30px">#</th>' +
        '<th>FULL NAME</th>' +
        '<th>ALIAS</th>' +
        '<th style="text-align:center">SEX</th>' +
        '<th style="text-align:center">AGE</th>' +
        '<th>MEMBERSHIP</th>' +
        '<th>REFERRING UNIT</th>' +
        '<th style="text-align:center">DATE SURRENDERED</th>' +
        '<th style="text-align:center">JAPIC</th>' +
        '<th>STATUS</th>' +
      '</tr></thead>' +
      '<tbody>' + tableRows + '</tbody>' +
      '<tfoot><tr><td colspan="10" style="text-align:right;font-size:9px;padding-top:6px;border-top:2px solid #333">' +
        'TOTAL: ' + list.length + ' RECORD' + (list.length !== 1 ? 'S' : '') +
      '</td></tr></tfoot>' +
    '</table>';

  openPrintDocument('FR Records List', body, REPORT_PRINT_STYLES);
  showToast('PRINT PREVIEW OPENED', 'success');
}

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
function onTribalGroupChange() { var val=document.getElementById('tribalGroup').value,ipCb=document.getElementById('sec_ip'),farmerCb=document.getElementById('sec_farmer');if(val&&val!=='NO TRIBAL GROUP'){ipCb.checked=true;farmerCb.checked=true;}else if(val==='NO TRIBAL GROUP'){ipCb.checked=false;} }
function onIPSectorChange() { var ipCb=document.getElementById('sec_ip'),farmerCb=document.getElementById('sec_farmer');if(ipCb.checked)farmerCb.checked=true; }

// -- SAVE RECORD (with Firebase Storage upload) ---------------
var isSaving = false; // guard against double-submit

function saveRecord(event) {
  event.preventDefault();
  if (isSaving) return; // already saving - ignore extra clicks
  isSaving = true; // lock immediately - before any async work

  var saveBtn = document.querySelector('#recordForm button[type="submit"]');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '? SAVING...'; }

  function unlockSave() {
    isSaving = false;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '\uD83D\uDCBE SAVE RECORD'; }
  }
  var sectorChecked = SECTOR_IDS.some(function(id){return document.getElementById(id).checked;});
  var sectorErr = document.getElementById('sectorError');
  if(!sectorChecked){sectorErr.style.display='block';document.getElementById('sec_farmer').scrollIntoView({behavior:'smooth',block:'center'});unlockSave();return;}
  sectorErr.style.display='none';
  if(document.getElementById('religion').value==='OTHERS'&&!document.getElementById('religionOthers').value.trim()){document.getElementById('religionOthers').focus();showToast('PLEASE SPECIFY RELIGION','error');unlockSave();return;}

  var asstIds=['asst_eclip','asst_noteclip','asst_fea','asst_livelihood','asst_medical','asst_educational','asst_credentials','asst_philhealth','asst_safeconduct','asst_amnesty'];
  var asstVals={asst_eclip:'E-CLIP',asst_noteclip:'NOT QUALIFIED FOR E-CLIP',asst_fea:'FEA REMUNERATION',asst_livelihood:'LIVELIHOOD',asst_medical:'MEDICAL',asst_educational:'EDUCATIONAL',asst_credentials:'ISSUANCE OF CREDENTIALS',asst_philhealth:'PHILHEALTH',asst_safeconduct:'ISSUANCE OF SAFE CONDUCT PASS',asst_amnesty:'APPLIED FOR AMNESTY'};
  var assistance=[];
  asstIds.forEach(function(id){if(document.getElementById(id).checked)assistance.push(asstVals[id]);});
  if(document.getElementById('asst_others').checked){var spec=document.getElementById('asst_others_spec').value.trim();assistance.push('OTHERS'+(spec?': '+spec.toUpperCase():''));}

  var religionVal=document.getElementById('religion').value;
  if(religionVal==='OTHERS')religionVal='OTHERS: '+document.getElementById('religionOthers').value.trim().toUpperCase();

  var secMap={sec_farmer:'FARMER',sec_fisherfolk:'FISHERFOLK',sec_women:'WOMEN',sec_pwd:'PWD',sec_youth:'CHILDREN AND YOUTH',sec_senior:'SENIOR CITIZEN',sec_solo_parent:'SOLO PARENT',sec_ip:'INDIGENOUS PEOPLE',sec_urban_poor:'URBAN POOR'};
  var sectorList=[];
  Object.keys(secMap).forEach(function(id){if(document.getElementById(id).checked)sectorList.push(secMap[id]);});
  if(document.getElementById('sec_others').checked){var secSpec=document.getElementById('sec_others_spec').value.trim();sectorList.push('OTHERS'+(secSpec?': '+secSpec.toUpperCase():''));}

  var referringUnitVal=(function(){var val=document.getElementById('referringUnit').value;if(val==='OTHERS'){var spec=document.getElementById('referringUnitOthers').value.trim().toUpperCase();return spec?'OTHERS: '+spec:'OTHERS';}return val;})();

  var recordId = editingRecordId || genId();
  var record = {
    id: recordId,
    lastName:            document.getElementById('lastName').value.trim().toUpperCase(),
    firstName:           document.getElementById('firstName').value.trim().toUpperCase(),
    middleName:          document.getElementById('middleName').value.trim().toUpperCase() || 'UNKNOWN',
    alias:               document.getElementById('alias').value.trim().toUpperCase(),
    dob:                 document.getElementById('dob').value,
    sex:                 document.getElementById('sex').value,
    civilStatus:         document.getElementById('civilStatus').value || defaultCivilStatus(document.getElementById('dob').value),
    tribalGroup:         document.getElementById('tribalGroup').value,
    recordStatus:        document.getElementById('recordStatus').value,
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
    unit:                document.getElementById('unit').value.trim().toUpperCase() || (document.getElementById('membershipType').value === 'MILISYANG BAYAN' ? 'MB' : ''),
    position:            document.getElementById('position').value.trim().toUpperCase() || 'MEMBER',
    membershipType:      document.getElementById('membershipType').value,
    areaOfOperation:     document.getElementById('areaOfOperation').value,
    yearsInMovement:     document.getElementById('yearsInMovement').value || '1',
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
  // Strip name extension suffixes for comparison purposes
  function stripSuffix(name) {
    return (name || '').replace(/\b(JR\.?|SR\.?|II|III|IV)\s*$/i, '').trim().toUpperCase();
  }
  // Returns the matched suffix (e.g. "JR" or "SR") or empty string
  function getSuffix(r) {
    var combined = [r.lastName, r.firstName, r.middleName, r.alias].join(' ').toUpperCase();
    var m = combined.match(/\b(JR\.?|SR\.?)\b/);
    return m ? m[1].replace('.', '') : '';
  }

  showToast('CHECKING FOR DUPLICATES...', 'info');
  // Fuzzy check against full cache ? handles swapped names and typos
  var duplicate = null;
  if (allRecordsCache.length) {
    for (var ci = 0; ci < allRecordsCache.length; ci++) {
      var cand = allRecordsCache[ci];
      if (cand.id === record.id) continue; // skip self
      var newSuffix = getSuffix(record);
      var exSuffix  = getSuffix(cand);
      if (newSuffix && exSuffix && newSuffix !== exSuffix) continue;
      if (fuzzyNameMatch(record, cand)) { duplicate = cand; break; }
    }
  }
  if (duplicate) {
    showToast(
      'DUPLICATE ENTRY - ' + duplicate.lastName + ', ' + duplicate.firstName +
      (duplicate.middleName ? ' ' + duplicate.middleName : '') +
      ' ALREADY EXISTS. ADD JR. OR SR. IF THIS IS A DIFFERENT PERSON.',
      'error'
    );
    unlockSave();
    return;
  }
  // No fuzzy match in cache -- use cache-only check (avoids extra Firestore read on every save)
  function proceedWithSave() {
    var finalDup = null;
    for (var fi = 0; fi < allRecordsCache.length; fi++) {
      var fc = allRecordsCache[fi];
      if (fc.id === record.id) continue;
      var fNewSuffix = getSuffix(record);
      var fExSuffix  = getSuffix(fc);
      if (fNewSuffix && fExSuffix && fNewSuffix !== fExSuffix) continue;
      if ((fc.lastName  || '').toUpperCase() === (record.lastName  || '').toUpperCase() &&
          (fc.firstName || '').toUpperCase() === (record.firstName || '').toUpperCase()) {
        finalDup = fc; break;
      }
    }
    if (finalDup) {
      showToast(
        'DUPLICATE ENTRY - ' + finalDup.lastName + ', ' + finalDup.firstName +
        (finalDup.middleName ? ' ' + finalDup.middleName : '') +
        ' ALREADY EXISTS. ADD JR. OR SR. IF THIS IS A DIFFERENT PERSON.',
        'error'
      );
      unlockSave();
      return;
    }
    // No duplicate -- proceed with save
    showToast('SAVING RECORD...', 'info');
    uploadRecordFiles(record).then(function(r) {
      return dbPut(r);
    }).then(function() {
      unlockSave();
      playChime();
      showToast(isEdit ? 'RECORD UPDATED SUCCESSFULLY' : 'RECORD SAVED SUCCESSFULLY', 'success');
      try { var _ri = JSON.parse(localStorage.getItem('frdb-recentImports')||'[]'); localStorage.setItem('frdb-recentImports', JSON.stringify(_ri.filter(function(e){return e.id!==recordId;}))); } catch(ex) {}
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
  }

  if (allRecordsCache.length) {
    proceedWithSave();
  } else {
    // Cache empty -- load it first, then check and save
    dbGetAll().then(function(records) {
      allRecordsCache = records;
      proceedWithSave();
    }).catch(function(err) {
      console.warn('[FRDB] Cache load failed before save:', err.message);
      showToast('ERROR: COULD NOT VERIFY DUPLICATES - ' + err.message, 'error');
      unlockSave();
    });
  }
}

// -- RESET FORM -----------------------------------------------
function resetForm() {
  editingRecordId=null;
  document.getElementById('recordForm').reset();
  document.getElementById('recordId').value='';
  document.getElementById('age').value='UNKNOWN';
  removeIdPhoto(); validIdSlots=[]; renderValidIdSlots(); removeJapic(); removeSocialCase();
  ['asst_eclip','asst_noteclip','asst_fea','asst_livelihood','asst_medical','asst_educational','asst_credentials','asst_philhealth','asst_safeconduct','asst_amnesty','asst_others'].forEach(function(id){document.getElementById(id).checked=false;});
  document.getElementById('asst_others_spec').style.display='none'; document.getElementById('asst_others_spec').value='';
  SECTOR_IDS.forEach(function(id){document.getElementById(id).checked=false;});
  document.getElementById('sec_others_spec').style.display='none'; document.getElementById('sec_others_spec').value='';
  document.getElementById('sectorError').style.display='none';
  document.getElementById('religion').value=''; document.getElementById('religionOthers').value=''; document.getElementById('religionOthersGroup').style.display='none';
  document.getElementById('contactNumber').value=''; document.getElementById('medicalCondition').value=''; document.getElementById('medicalConditionSpec').value='';
  document.getElementById('fourPs').value=''; document.getElementById('pendingCase').value=''; document.getElementById('referringUnit').value='';
  document.getElementById('referringUnitOthers').value=''; document.getElementById('referringUnitOthersGroup').style.display='none';
  document.getElementById('remarks').value='';
  document.getElementById('recordStatus').value='';
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
  document.getElementById('recordStatus').value=r.recordStatus||'';
  document.getElementById('addressBarangay').value=r.addressBarangay||r.address||'';
  document.getElementById('addressProvince').value=r.addressProvince||'OCCIDENTAL MINDORO';
  onProvinceChange();
  if(r.addressProvince==='OUTSIDE MINDORO')document.getElementById('addressMunicipalityText').value=r.addressMunicipality||'';
  else document.getElementById('addressMunicipality').value=r.addressMunicipality||'';
  var savedReligion=r.religion||'', knownReligions=['CATHOLIC','SEVENTH DAY ADVENTIST','CHRISTIAN','BORN AGAIN CHRISTIAN','IGLESIA NI CRISTO'];
  if(knownReligions.indexOf(savedReligion)!==-1){document.getElementById('religion').value=savedReligion;document.getElementById('religionOthersGroup').style.display='none';document.getElementById('religionOthers').value='';}
  else if(savedReligion){document.getElementById('religion').value='OTHERS';document.getElementById('religionOthersGroup').style.display='block';document.getElementById('religionOthers').value=savedReligion.replace('OTHERS: ','').replace('OTHERS','');}
  else{document.getElementById('religion').value='';document.getElementById('religionOthersGroup').style.display='none';}
  document.getElementById('contactNumber').value=r.contactNumber||''; document.getElementById('medicalCondition').value=r.medicalCondition||''; document.getElementById('fourPs').value=r.fourPs||''; document.getElementById('pwdDisability').value=r.pwdDisability||'';
  onMedicalConditionChange();
  if(r.medicalCondition==='YES'&&r.medicalConditionSpec)document.getElementById('medicalConditionSpec').value=r.medicalConditionSpec;
  var secMap={'FARMER':'sec_farmer','FISHERFOLK':'sec_fisherfolk','WOMEN':'sec_women','PWD':'sec_pwd','CHILDREN AND YOUTH':'sec_youth','SENIOR CITIZEN':'sec_senior','SOLO PARENT':'sec_solo_parent','INDIGENOUS PEOPLE':'sec_ip','URBAN POOR':'sec_urban_poor'};
  Object.values(secMap).forEach(function(id){document.getElementById(id).checked=false;});
  document.getElementById('sec_others').checked=false; document.getElementById('sec_others_spec').style.display='none'; document.getElementById('sec_others_spec').value=''; document.getElementById('sectorError').style.display='none';
  (r.sector||[]).forEach(function(s){
    // backward compat: old combined value maps to both checkboxes
    if(s==='FARMER/FISHERFOLK'){document.getElementById('sec_farmer').checked=true;document.getElementById('sec_fisherfolk').checked=true;return;}
    if(secMap[s])document.getElementById(secMap[s]).checked=true;else if(s.indexOf('OTHERS')===0){document.getElementById('sec_others').checked=true;document.getElementById('sec_others_spec').style.display='inline-block';document.getElementById('sec_others_spec').value=s.replace('OTHERS: ','').replace('OTHERS','');}
  });
  // Auto-check FARMER if INDIGENOUS PEOPLE is checked
  if(document.getElementById('sec_ip').checked) document.getElementById('sec_farmer').checked=true;
  togglePwdSpec(); calcAge(); onTribalGroupChange();
  if(r.idPhoto){idPhotoData=r.idPhoto;var img=document.getElementById('idPhotoPreview');img.src=r.idPhoto;img.style.display='block';document.getElementById('idPhotoPlaceholder').style.display='none';document.getElementById('removePhotoBtn').style.display='block';}
  else{removeIdPhoto();}
  document.getElementById('unit').value=r.unit||''; document.getElementById('position').value=r.position||''; document.getElementById('membershipType').value=r.membershipType||'';
  document.getElementById('areaOfOperation').value=r.areaOfOperation||''; document.getElementById('yearsInMovement').value=r.yearsInMovement||'';
  document.getElementById('dateSurrendered').value=r.dateSurrendered||''; document.getElementById('pendingCase').value=r.pendingCase||'';
  document.getElementById('remarks').value=r.remarks||'';
  var KNOWN_UNITS=['102nd SAC','1st Infantry "Always First" Battalion','1st OMPMFC','203rd Infantry "Bantay Kapayapaan" Brigade','23MICO','2CMO Battalion','2nd OMPMFC','402nd B MC RMFB 4B','405th B MC RMFB 4B','4th Infantry "Scorpion" Battalion','68th Infantry "Kaagapay" Battalion','76th Infantry "Victrix" Battalion','ISAFP','PIU','PIT Occidental Mindoro RIU 4B','OTHERS'];
  var savedUnit=r.referringUnit||'';
  // Normalize saved unit to canonical form before matching dropdown
  var savedUnit = normalizeReferringUnit(savedUnit) || savedUnit;
  if(!savedUnit){document.getElementById('referringUnit').value='';document.getElementById('referringUnitOthersGroup').style.display='none';}
  else if(KNOWN_UNITS.indexOf(savedUnit)!==-1){document.getElementById('referringUnit').value=savedUnit;document.getElementById('referringUnitOthersGroup').style.display='none';}
  else if(savedUnit.indexOf('OTHERS')===0){document.getElementById('referringUnit').value='OTHERS';document.getElementById('referringUnitOthersGroup').style.display='block';document.getElementById('referringUnitOthers').value=savedUnit.replace('OTHERS: ','').replace('OTHERS','');}
  else{document.getElementById('referringUnit').value='OTHERS';document.getElementById('referringUnitOthersGroup').style.display='block';document.getElementById('referringUnitOthers').value=savedUnit;}
  var asstMap={'E-CLIP':'asst_eclip','NOT QUALIFIED FOR E-CLIP':'asst_noteclip','FEA REMUNERATION':'asst_fea','LIVELIHOOD':'asst_livelihood','MEDICAL':'asst_medical','EDUCATIONAL':'asst_educational','ISSUANCE OF CREDENTIALS':'asst_credentials','PHILHEALTH':'asst_philhealth','ISSUANCE OF SAFE CONDUCT PASS':'asst_safeconduct','APPLIED FOR AMNESTY':'asst_amnesty'};
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
  var photoFileName=(r.lastName||'PHOTO')+'_'+(r.firstName||'')+'_2x2.jpg';
  var photoImg=photoSrc
    ?'<img src="'+photoSrc+'" class="modal-id-photo" alt="ID Photo"/>'
    :'<img src="BHB.png" class="modal-id-photo" alt="ID Photo"/>';
  // Store photo src + filename on the button via data attributes to avoid URL-in-onclick escaping issues
  var dlBtn=(!forPrint&&photoSrc)
    ?'<button class="btn-attach-dl btn-dl-photo" data-src="'+photoSrc.replace(/"/g,'&quot;')+'" data-name="'+photoFileName.replace(/"/g,'&quot;')+'" style="margin-top:6px;width:100px;font-size:0.65rem">&#11015; DOWNLOAD</button>'
    :'';
  var photoHtml='<div style="display:flex;flex-direction:column;align-items:center;gap:4px">'+photoImg+dlBtn+'</div>';
  var tagsSex=r.sex?'<span class="tag tag-blue">'+r.sex+'</span>':'';
  var tagsCivil=r.civilStatus?'<span class="tag tag-blue">'+r.civilStatus+'</span>':'';
  var tribalDisplay=normalizeTribalGroup(r.tribalGroup)||r.tribalGroup;
  var tagsTribal=tribalDisplay?'<span class="tag tag-blue">'+tribalDisplay+'</span>':'';
  var statusColors={'CANNOT BE LOCATED':'#d29922','DECEASED':'#f85149','INCARCERATED':'#a371f7'};
  var tagsStatus=r.recordStatus?'<span class="tag" style="background:rgba(248,81,73,0.15);border-color:'+statusColors[r.recordStatus]+';color:'+statusColors[r.recordStatus]+';font-weight:700">&#9679; '+r.recordStatus+'</span>':'';
  var asstRaw = r.assistance || [];
  // Collapse bare 'OTHERS' if a specific 'OTHERS: <value>' already exists ? avoids redundant tags
  var hasSpecificOthers = asstRaw.some(function(a) { return a.length > 6 && a.indexOf('OTHERS:') === 0; });
  var asstFiltered = hasSpecificOthers ? asstRaw.filter(function(a) { return a !== 'OTHERS'; }) : asstRaw;
  var asstHtml = asstFiltered.length ? asstFiltered.map(function(a){return'<span class="tag tag-green">'+a+'</span>';}).join('') : '-';
  var sectorHtml=(r.sector&&r.sector.length)?r.sector.map(function(s){return'<span class="tag tag-blue">'+s+'</span>';}).join(''):'-';
  if(r.sector&&r.sector.indexOf('PWD')!==-1&&r.pwdDisability)sectorHtml+='<div class="pwd-disability-note">DISABILITY: '+r.pwdDisability+'</div>';

  function attachCard(src, fileName, type) {
    if (forPrint) {
      // For print: show ON-FILE status, not the actual image
      return '<span class="on-file-badge">&#10003; ON-FILE - ' + (fileName || 'FILE') + '</span>';
    }
    return '<div class="attach-card attach-card--wide">'+(type==='image'?'<img src="'+src+'" class="attach-preview-img" style="max-height:90px;border-radius:4px;border:1px solid var(--border)" onclick="openAttachment(\''+src+'\',\''+fileName+'\')" alt="'+fileName+'"/>':'<div class="attach-file-icon">&#128196;</div>')+'<div class="attach-name">'+fileName+'</div><div class="attach-actions">'+(type==='image'?'<button class="btn-attach-view" onclick="openAttachment(\''+src+'\',\''+fileName+'\')">&#128065; VIEW</button>':'')+'<button class="btn-attach-dl" onclick="downloadAttachment(\''+src+'\',\''+fileName+'\')">&#11015; DOWNLOAD</button></div></div>';
  }

  var validIdHtml = (r.validIds && r.validIds.length)
    ? (forPrint
        ? r.validIds.map(function(v, i) {
            return '<span class="on-file-badge">&#10003; ON-FILE - ' + (v.fileName || ('VALID ID ' + (i+1))) + '</span>';
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

  return '<div class="modal-top-row"><div>'+photoHtml+'</div><div class="modal-top-info"><div class="modal-full-name">'+r.lastName+', '+r.firstName+' '+(r.middleName||'')+'</div><div class="modal-alias">'+(r.alias?'ALIAS: '+r.alias:'')+'</div><div style="margin-top:8px">'+tagsSex+tagsCivil+tagsTribal+tagsStatus+'</div></div></div>' +
    '<div class="modal-section"><div class="modal-section-title">PART I - PERSONAL DETAILS</div><div class="modal-record-grid">' +
    '<div class="modal-field"><div class="modal-field-label">DATE OF BIRTH</div><div class="modal-field-value">'+formatDate(r.dob)+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">AGE</div><div class="modal-field-value">'+(age||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">SEX</div><div class="modal-field-value">'+(r.sex||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">CIVIL STATUS</div><div class="modal-field-value">'+(r.civilStatus||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">TRIBAL GROUP</div><div class="modal-field-value">'+(tribalDisplay||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">STATUS</div><div class="modal-field-value" style="'+(r.recordStatus?'font-weight:700;color:'+(statusColors[r.recordStatus]||'inherit'):'')+'">'+  (r.recordStatus||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">RELIGION</div><div class="modal-field-value">'+(r.religion||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">CONTACT</div><div class="modal-field-value">'+(r.contactNumber||'-')+'</div></div>' +
    '<div class="modal-field"><div class="modal-field-label">MEDICAL</div><div class="modal-field-value">'+(r.medicalCondition||'-')+(r.medicalCondition==='YES'&&r.medicalConditionSpec?' - '+r.medicalConditionSpec:'')+'</div></div>' +
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
  // Handle photo download button (uses data attributes to avoid URL-in-onclick escaping issues)
  var dlPhotoBtn = document.querySelector('.btn-dl-photo');
  if (dlPhotoBtn) {
    dlPhotoBtn.addEventListener('click', function() {
      downloadAttachment(this.getAttribute('data-src'), this.getAttribute('data-name'));
    });
  }
  document.getElementById('viewModal').classList.remove('hidden');
}
function closeModal() { document.getElementById('viewModal').classList.add('hidden'); }
function editFromModal() { closeModal(); editRecord(viewingRecordId); }

function printRecord(id) {
  id=id||viewingRecordId; var r=getRecordById(id); if(!r){showToast('RECORD NOT FOUND','error');return;}
  var name=r.lastName+', '+r.firstName, printed=new Date().toLocaleString('en-PH');
  var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';
  var html='<!DOCTYPE html><html><head><meta charset="UTF-8"><title></title><style>'+PRINT_RECORD_STYLES+CONFIDENTIAL_WATERMARK_STYLE+'</style></head><body><div class="confidential-watermark">CONFIDENTIAL</div><div class="print-header"><h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1><p>RECORD PRINTOUT</p><p>Printed: '+printed+'</p><p>Printed by: '+printedBy+'</p></div>'+buildRecordDetailHtml(r,true)+'</body></html>';
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
  if (!src) return;
  // For http/https URLs (Firebase Storage etc.) — fetch as blob so browser saves the file
  if (src.startsWith('http://') || src.startsWith('https://')) {
    fetch(src)
      .then(function(res) { return res.blob(); })
      .then(function(blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = fileName || 'download'; a.click();
        setTimeout(function() { URL.revokeObjectURL(url); }, 3000);
      })
      .catch(function() {
        // Fallback: open in new tab if fetch fails (CORS etc.)
        window.open(src, '_blank');
      });
    return;
  }
  // Base64 / data URL
  var a = document.createElement('a'); a.href = src; a.download = fileName || 'download'; a.click();
}

// -- DELETE ---------------------------------------------------
function promptDelete(id) { deleteTargetId=id; document.getElementById('deleteModal').classList.remove('hidden'); }
function closeDeleteModal() { deleteTargetId=null; document.getElementById('deleteModal').classList.add('hidden'); }
function confirmDelete() {
  if(!deleteTargetId) return;
  dbDelete(deleteTargetId).then(function() {
    closeDeleteModal(); showToast('RECORD DELETED','error');
    dbGetAll().then(function(records){allRecordsCache=records;renderRecords(records,document.getElementById('searchInput').value,document.getElementById('unitFilterSelect').value,document.getElementById('membershipFilterSelect').value,document.getElementById('yearFilterSelect')?document.getElementById('yearFilterSelect').value:'');});
  }).catch(function(err){showToast('DELETE FAILED: '+err.message,'error');});
}

// -- IMPORT CSV -----------------------------------------------
function parseCSVLine(line) {
  var result = [], cur = '', inQuote = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }       // escaped quote
      else if (ch === '"') { inQuote = false; }                          // end quote
      else { cur += ch; }
    } else {
      if (ch === '"') { inQuote = true; }                                // start quote
      else if (ch === ',') { result.push(cur.trim()); cur = ''; }        // delimiter
      else { cur += ch; }
    }
  }
  result.push(cur.trim()); // last field
  return result;
}

// -- IMPORT HELPERS -------------------------------------------
// Convert any recognisable date string to YYYY-MM-DD (the database canonical form).
// Accepts: YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY (ambiguous treated as MM/DD),
//          "January 1, 2000", "1 January 2000", ISO timestamps, etc.
function normalizeDateForImport(raw) {
  if (!raw) return '';
  var s = raw.toString().trim();
  if (!s) return '';
  // Already ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ISO datetime - take date part only
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  // MM/DD/YYYY or DD/MM/YYYY or M/D/YYYY
  var slashParts = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashParts) {
    var mm = slashParts[1].padStart(2, '0');
    var dd = slashParts[2].padStart(2, '0');
    var yyyy = slashParts[3];
    return yyyy + '-' + mm + '-' + dd;
  }
  // Try native Date parse as last resort
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    var y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), dy = String(d.getDate()).padStart(2, '0');
    return y + '-' + mo + '-' + dy;
  }
  return s; // return as-is if unparseable
}

// Uppercase a plain text field; return empty string for falsy values.
function ucField(v) { return v ? v.toString().trim().toUpperCase() : ''; }

// Normalize a known enum field against an allowed list (case-insensitive).
// Returns the canonical value if matched, otherwise returns the uppercased raw value.
function matchEnum(val, allowedList) {
  if (!val) return '';
  var up = val.toString().trim().toUpperCase();
  for (var i = 0; i < allowedList.length; i++) {
    if (allowedList[i].toUpperCase() === up) return allowedList[i];
  }
  return up;
}

// Normalize sector values from a CSV semicolon-separated string.
var IMPORT_SECTOR_MAP = {
  'FARMER/FISHERFOLK': ['FARMER', 'FISHERFOLK'],
  'FARMER': ['FARMER'], 'FISHERFOLK': ['FISHERFOLK'],
  'WOMEN': ['WOMEN'], 'PWD': ['PWD'],
  'CHILDREN AND YOUTH': ['CHILDREN AND YOUTH'], 'YOUTH': ['CHILDREN AND YOUTH'],
  'SENIOR CITIZEN': ['SENIOR CITIZEN'], 'SENIOR': ['SENIOR CITIZEN'],
  'SOLO PARENT': ['SOLO PARENT'],
  'INDIGENOUS PEOPLE': ['INDIGENOUS PEOPLE'], 'IP': ['INDIGENOUS PEOPLE'],
  'URBAN POOR': ['URBAN POOR']
};
// Keyword map for fuzzy sector matching
var SECTOR_KEYWORD_MAP = [
  { keywords: ['FARMER/FISHERFOLK'],               canonical: ['FARMER', 'FISHERFOLK'] },
  { keywords: ['FARMER'],                          canonical: ['FARMER'] },
  { keywords: ['FISHERFOLK','FISHER'],             canonical: ['FISHERFOLK'] },
  { keywords: ['WOMEN','WOMAN','FEMALE'],          canonical: ['WOMEN'] },
  { keywords: ['PWD','DISABILITY','DISABLED','PERSONS WITH DISABILITY'], canonical: ['PWD'] },
  { keywords: ['YOUTH','CHILDREN','CHILD','MINOR'],canonical: ['CHILDREN AND YOUTH'] },
  { keywords: ['SENIOR','ELDERLY','OLDER'],        canonical: ['SENIOR CITIZEN'] },
  { keywords: ['SOLO PARENT','SINGLE PARENT'],     canonical: ['SOLO PARENT'] },
  { keywords: ['INDIGENOUS PEOPLE','INDIGENOUS','LUMAD','MANGYAN','TRIBAL','IP'], canonical: ['INDIGENOUS PEOPLE'] },
  { keywords: ['URBAN POOR','INFORMAL SETTLER'],   canonical: ['URBAN POOR'] }
];
function normalizeSectorList(raw) {
  if (!raw) return [];
  var seen = {}, result = [];
  raw.split(';').forEach(function(s) {
    var up = s.trim().toUpperCase();
    if (!up) return;
    // Exact map match
    var mapped = IMPORT_SECTOR_MAP[up];
    if (mapped) {
      mapped.forEach(function(m) { if (!seen[m]) { seen[m] = true; result.push(m); } });
      return;
    }
    // Already OTHERS prefixed
    if (up.indexOf('OTHERS') === 0) {
      if (!seen[up]) { seen[up] = true; result.push(up); }
      return;
    }
    // Fuzzy keyword match (whole-word to avoid false positives)
    var matched = false;
    for (var j = 0; j < SECTOR_KEYWORD_MAP.length; j++) {
      var entry = SECTOR_KEYWORD_MAP[j];
      for (var k = 0; k < entry.keywords.length; k++) {
        var kw = entry.keywords[k];
        // Match exact equality OR keyword appears as whole word (bounded by space/start/end)
        var kwMatch = (up === kw) ||
          (new RegExp('(^|[^A-Z])' + kw.replace(/[/]/g, '\\/') + '([^A-Z]|$)').test(up));
        if (kwMatch) {
          entry.canonical.forEach(function(m) { if (!seen[m]) { seen[m] = true; result.push(m); } });
          matched = true; break;
        }
      }
      if (matched) break;
    }
    if (!matched) {
      // Unknown ? store as OTHERS: <value>
      var othersVal = 'OTHERS: ' + up;
      if (!seen[othersVal]) { seen[othersVal] = true; result.push(othersVal); }
    }
  });
  return result;
}

// Normalize assistance values from a CSV semicolon-separated string.
var IMPORT_ASST_CANONICAL = [
  'E-CLIP','NOT QUALIFIED FOR E-CLIP','FEA REMUNERATION','LIVELIHOOD','MEDICAL',
  'EDUCATIONAL','ISSUANCE OF CREDENTIALS','PHILHEALTH',
  'ISSUANCE OF SAFE CONDUCT PASS','APPLIED FOR AMNESTY'
];

// Keyword map: if any keyword appears in the value, map to canonical
var ASST_KEYWORD_MAP = [
  { keywords: ['E-CLIP','ECLIP'],                               canonical: 'E-CLIP' },
  { keywords: ['NOT QUALIFIED'],                                canonical: 'NOT QUALIFIED FOR E-CLIP' },
  { keywords: ['FEA','REMUNERATION'],                           canonical: 'FEA REMUNERATION' },
  { keywords: ['LIVELIHOOD'],                                   canonical: 'LIVELIHOOD' },
  { keywords: ['MEDICAL','MEDICINE','HOSPITALIZATION','HEALTH'],canonical: 'MEDICAL' },
  { keywords: ['EDUCATIONAL','EDUCATION','SCHOLARSHIP','TUITION'],canonical: 'EDUCATIONAL' },
  { keywords: ['CREDENTIAL','DOCUMENT','NBI','BIRTH CERT'],     canonical: 'ISSUANCE OF CREDENTIALS' },
  { keywords: ['PHILHEALTH'],                                   canonical: 'PHILHEALTH' },
  { keywords: ['SAFE CONDUCT'],                                 canonical: 'ISSUANCE OF SAFE CONDUCT PASS' },
  { keywords: ['AMNESTY'],                                      canonical: 'APPLIED FOR AMNESTY' }
];

function normalizeAsstList(raw) {
  if (!raw) return [];
  var result = [];
  var seen = {};
  raw.split(';').forEach(function(s) {
    var up = s.trim().toUpperCase();
    if (!up) return;
    // Exact match
    for (var i = 0; i < IMPORT_ASST_CANONICAL.length; i++) {
      if (IMPORT_ASST_CANONICAL[i] === up) {
        if (!seen[IMPORT_ASST_CANONICAL[i]]) { seen[IMPORT_ASST_CANONICAL[i]] = true; result.push(IMPORT_ASST_CANONICAL[i]); }
        return;
      }
    }
    // Already prefixed with OTHERS ? keep as-is
    if (up.indexOf('OTHERS') === 0) {
      if (!seen[up]) { seen[up] = true; result.push(up); }
      return;
    }
    // Fuzzy keyword match
    var matchedCanonical = null;
    for (var j = 0; j < ASST_KEYWORD_MAP.length; j++) {
      var entry = ASST_KEYWORD_MAP[j];
      for (var k = 0; k < entry.keywords.length; k++) {
        if (up.indexOf(entry.keywords[k]) !== -1) {
          matchedCanonical = entry.canonical;
          break;
        }
      }
      if (matchedCanonical) break;
    }
    if (matchedCanonical) {
      // Check if value has extra content beyond just the keyword
      // (e.g. amounts, sources ? indicates a descriptive note)
      var isDescriptive = /\d/.test(up) || up.length > matchedCanonical.length + 15;
      if (!seen[matchedCanonical]) { seen[matchedCanonical] = true; result.push(matchedCanonical); }
      if (isDescriptive) {
        // Also store the full raw value in OTHERS for the specify field
        var othersVal = 'OTHERS: ' + up;
        if (!seen[othersVal]) { seen[othersVal] = true; result.push(othersVal); }
      }
    } else {
      // No match at all ? store as OTHERS: <value>
      var othersKey = 'OTHERS: ' + up;
      if (!seen[othersKey]) { seen[othersKey] = true; result.push(othersKey); }
    }
  });
  // If any OTHERS: <value> entries exist, remove bare 'OTHERS' ? it's redundant
  var hasSpecificOthers = result.some(function(a) { return a.length > 6 && a.indexOf('OTHERS:') === 0; });
  if (hasSpecificOthers) result = result.filter(function(a) { return a !== 'OTHERS'; });
  return result;
}

// Normalize referring unit - keep known units verbatim, uppercase everything else.
// Also maps known all-caps variants to the canonical mixed-case form.
var REFERRING_UNIT_ALIASES = {
  // Correct spelling, all-caps
  '4TH INFANTRY "SCORPION" BATTALION':   '4th Infantry "Scorpion" Battalion',
  '4TH INFANTRY "SCORPION" BATTALION.':  '4th Infantry "Scorpion" Battalion',
  // Misspelled BATALLION (double L)
  '4TH INFANTRY "SCORPION" BATALLION':   '4th Infantry "Scorpion" Battalion',
  '4TH INFANTRY "SCORPION" BATALLION.':  '4th Infantry "Scorpion" Battalion',
  '4th Infantry "Scorpion" Batallion':   '4th Infantry "Scorpion" Battalion',
  '4th INFANTRY "SCORPION" BATALLION':   '4th Infantry "Scorpion" Battalion',
  '4th INFANTRY "SCORPION" Battalion':   '4th Infantry "Scorpion" Battalion',
  // Other units all-caps
  '1ST INFANTRY "ALWAYS FIRST" BATTALION':         '1st Infantry "Always First" Battalion',
  '1ST INFANTRY "ALWAYS FIRST" BATALLION':         '1st Infantry "Always First" Battalion',
  '203RD INFANTRY "BANTAY KAPAYAPAAN" BRIGADE':    '203rd Infantry "Bantay Kapayapaan" Brigade',
  '68TH INFANTRY "KAAGAPAY" BATTALION':            '68th Infantry "Kaagapay" Battalion',
  '68TH INFANTRY "KAAGAPAY" BATALLION':            '68th Infantry "Kaagapay" Battalion',
  '76TH INFANTRY "VICTRIX" BATTALION':             '76th Infantry "Victrix" Battalion',
  '76TH INFANTRY "VICTRIX" BATALLION':             '76th Infantry "Victrix" Battalion',
  // 1st OMPMFC aliases
  '1ST OCCIDENTAL MINDORO PMFC':                   '1st OMPMFC',
  '1ST OCCIDENTAL MINDORO PMFC.':                  '1st OMPMFC',
  '1ST OCC. MINDORO PMFC':                         '1st OMPMFC',
  '1 OMPMFC':                                      '1st OMPMFC',
  '1ST OMPMFC':                                    '1st OMPMFC',
  // PIU aliases
  'PIU, OCCIDENTAL MINDORO':                       'PIU',
  'PIU OCCIDENTAL MINDORO':                        'PIU',
  'PIU-OCCIDENTAL MINDORO':                        'PIU',
  'PROVINCIAL INTELLIGENCE UNIT':                  'PIU',
  'PROVINCIAL INTELLIGENCE UNIT, OCCIDENTAL MINDORO': 'PIU',
  // Short abbreviations
  '4IB':                                           '4th Infantry "Scorpion" Battalion',
  '4TH IB':                                        '4th Infantry "Scorpion" Battalion',
  '4TH INFANTRY BATTALION':                        '4th Infantry "Scorpion" Battalion',
  '4TH INF BN':                                    '4th Infantry "Scorpion" Battalion',
  '4TH INF BATTALION':                             '4th Infantry "Scorpion" Battalion',
  '68IB':                                          '68th Infantry "Kaagapay" Battalion',
  '68TH IB':                                       '68th Infantry "Kaagapay" Battalion',
  '68TH INFANTRY BATTALION':                       '68th Infantry "Kaagapay" Battalion',
  '68TH INF BN':                                   '68th Infantry "Kaagapay" Battalion',
  '68TH INF BATTALION':                            '68th Infantry "Kaagapay" Battalion',
  '76IB':                                          '76th Infantry "Victrix" Battalion',
  '76TH IB':                                       '76th Infantry "Victrix" Battalion',
  '76TH INFANTRY BATTALION':                       '76th Infantry "Victrix" Battalion',
  '76TH INF BN':                                   '76th Infantry "Victrix" Battalion',
  '76TH INF BATTALION':                            '76th Infantry "Victrix" Battalion'
};
var IMPORT_KNOWN_UNITS = [
  '102nd SAC','1st Infantry "Always First" Battalion','1st OMPMFC',
  '203rd Infantry "Bantay Kapayapaan" Brigade','23MICO','2CMO Battalion',
  '2nd OMPMFC','402nd B MC RMFB 4B','405th B MC RMFB 4B',
  '4th Infantry "Scorpion" Battalion','68th Infantry "Kaagapay" Battalion',
  '76th Infantry "Victrix" Battalion','ISAFP','PIU','PIT Occidental Mindoro RIU 4B'
];
function normalizeReferringUnit(raw) {
  if (!raw) return '';
  var up = raw.toString().trim().toUpperCase();
  // Check alias map first
  if (REFERRING_UNIT_ALIASES[up]) return REFERRING_UNIT_ALIASES[up];
  for (var i = 0; i < IMPORT_KNOWN_UNITS.length; i++) {
    if (IMPORT_KNOWN_UNITS[i].toUpperCase() === up) return IMPORT_KNOWN_UNITS[i];
  }
  return up; // uppercase free-text / OTHERS
}

// -- IMPORT OVERLAY -------------------------------------------
function showImportOverlay(msg) {
  var el = document.getElementById('importOverlay');
  var msgEl = document.getElementById('importOverlayMsg');
  if (msgEl) msgEl.textContent = msg || 'IMPORTING...';
  if (el) el.classList.remove('hidden');
}
function hideImportOverlay() {
  var el = document.getElementById('importOverlay');
  if (el) el.classList.add('hidden');
}

// -- IMPORT CSV -----------------------------------------------
function importCSVFile(event) {
  var file = event.target.files[0]; if (!file) return;
  showImportOverlay('READING FILE...');
  var reader = new FileReader();
  reader.onload = function(e) {
    var text = e.target.result, lines = text.split(/\r?\n/).filter(function(l) { return l.trim(); });
    if (lines.length < 2) { hideImportOverlay(); showToast('CSV IS EMPTY OR INVALID', 'error'); return; }
    showImportOverlay('PARSING ' + (lines.length - 1) + ' RECORDS...');
    var headers = parseCSVLine(lines[0]), idx = {};
    headers.forEach(function(h, i) { idx[h.trim()] = i; });
    var headerCount = headers.length;
    var skippedMisaligned = 0;

    var SEX_VALS       = ['MALE', 'FEMALE'];
    var CIVIL_VALS     = ['SINGLE','MARRIED','WIDOW/WIDOWER','SEPARATED','COMMON-LAW'];
    var MEDICAL_VALS   = ['YES', 'NO'];
    var FOURPS_VALS    = ['YES', 'NO'];
    var PENDING_VALS   = ['YES', 'NO'];
    var MEMBERSHIP_VALS = ['REGULAR NPA', 'MILISYANG BAYAN'];
    var AOO_VALS       = ['SOUTHERN PART OF MINDORO','NORTHERN PART OF MINDORO','MINDORO ISLAND'];
    var STATUS_VALS    = ['CANNOT BE LOCATED','DECEASED','INCARCERATED'];
    var RELIGION_VALS  = ['CATHOLIC','SEVENTH DAY ADVENTIST','CHRISTIAN','BORN AGAIN CHRISTIAN','IGLESIA NI CRISTO'];
    var PROVINCE_VALS  = ['OCCIDENTAL MINDORO','ORIENTAL MINDORO','OUTSIDE MINDORO'];

    var parsed = [];
    for (var r = 1; r < lines.length; r++) {
      var cols = parseCSVLine(lines[r]);
      // Skip rows with significantly more columns than the header ? unquoted comma in a field
      if (cols.length > headerCount + 3) { skippedMisaligned++; continue; }
      var col  = function(name) { return (cols[idx[name]] || '').trim(); };

      // -- Text fields ? UPPERCASE
      var lastName       = ucField(col('LAST NAME'));
      var firstName      = ucField(col('FIRST NAME'));
      var middleName     = ucField(col('MIDDLE NAME'));
      if (!middleName || middleName.length <= 1) middleName = 'UNKNOWN';
      var alias          = ucField(col('ALIAS'));
      var addressBarangay = ucField(col('BARANGAY'));
      var unit           = ucField(col('UNIT'));
      var position       = ucField(col('POSITION')) || 'MEMBER';
      var remarks        = ucField(col('REMARKS'));
      var pwdDisability  = ucField(col('PWD DISABILITY'));
      var medicalSpec    = ucField(col('MEDICAL CONDITION SPECIFY'));
      var contactNumber  = (col('CONTACT NUMBER') || '').trim();
      var yearsInMovement = (col('YEARS IN MOVEMENT') || '1').trim();

      // -- Enum fields - match against known values
      var sex            = matchEnum(col('SEX'), SEX_VALS);
      var civilStatus    = matchEnum(col('CIVIL STATUS'), CIVIL_VALS) || defaultCivilStatus(dob);
      var medicalCond    = matchEnum(col('MEDICAL CONDITION'), MEDICAL_VALS) || 'NO';
      var fourPs         = matchEnum(col('4Ps'), FOURPS_VALS) || 'NO';
      var pendingCase    = matchEnum(col('PENDING CASE'), PENDING_VALS) || 'NO';
      var membershipType = (function() {
        var rawMem = ucField(col('MEMBERSHIP TYPE'));
        // Normalize common variants before matching
        if (rawMem === 'NPA' || rawMem === 'REGULAR' || rawMem === 'REG NPA' || rawMem === 'REG. NPA') {
          return 'REGULAR NPA';
        }
        if (rawMem === 'MB' || rawMem.indexOf('MILISYA') === 0) {
          return 'MILISYANG BAYAN';
        }
        return matchEnum(rawMem, MEMBERSHIP_VALS);
      })();
      var areaOfOp       = matchEnum(col('AREA OF OPERATION'), AOO_VALS);
      var recordStatus   = col('STATUS') ? matchEnum(col('STATUS'), STATUS_VALS) : '';
      var province       = col('PROVINCE') ? matchEnum(col('PROVINCE'), PROVINCE_VALS) : 'OCCIDENTAL MINDORO';

      // -- Religion: preserve known values; prefix unknown with OTHERS; default to CHRISTIAN
      var rawReligion = ucField(col('RELIGION'));
      var religion = '';
      if (rawReligion) {
        if (RELIGION_VALS.indexOf(rawReligion) !== -1) {
          religion = rawReligion;
        } else if (rawReligion === 'INC' || rawReligion.indexOf('IGLESIA') !== -1) {
          religion = 'IGLESIA NI CRISTO';
        } else if (rawReligion.indexOf('ROMAN CATHOLIC') !== -1 || rawReligion.indexOf('ROMANO KATOLIKO') !== -1 || rawReligion === 'RC') {
          religion = 'CATHOLIC';
        } else if (rawReligion.indexOf('BORN AGAIN') !== -1) {
          religion = 'BORN AGAIN CHRISTIAN';
        } else if (rawReligion.indexOf('ADVENTIST') !== -1 || rawReligion.indexOf('SDA') !== -1) {
          religion = 'SEVENTH DAY ADVENTIST';
        } else if (rawReligion.indexOf('OTHERS') === 0) {
          religion = rawReligion;
        } else {
          religion = 'OTHERS: ' + rawReligion;
        }
      } else {
        religion = 'CHRISTIAN'; // default when column is empty
      }

      // -- Tribal group - normalize via existing function (handles HANUNUO MANGYAN etc.)
      var tribalGroup = normalizeTribalGroup(ucField(col('TRIBAL GROUP')));
      // If normalizeTribalGroup returns '' for a non-empty input, store uppercased original
      if (!tribalGroup && col('TRIBAL GROUP').trim()) {
        tribalGroup = ucField(col('TRIBAL GROUP'));
      }
      // Default to NO TRIBAL GROUP if empty
      if (!tribalGroup) tribalGroup = 'NO TRIBAL GROUP';

      // -- Municipality - uppercase for free-text, keep known names as-is
      var municipality = ucField(col('MUNICIPALITY'));

      // -- Date fields ? YYYY-MM-DD
      var dob            = normalizeDateForImport(col('DATE OF BIRTH'));
      var dateSurrendered = normalizeDateForImport(col('DATE SURRENDERED'));

      // -- List fields
      var sectorList = normalizeSectorList(col('SECTOR'));
      var asstList   = normalizeAsstList(col('ASSISTANCE PROVIDED'));

      // -- Auto-tick INDIGENOUS PEOPLE if a tribal group is present
      if (tribalGroup && tribalGroup !== 'NO TRIBAL GROUP' && sectorList.indexOf('INDIGENOUS PEOPLE') === -1) {
        sectorList.push('INDIGENOUS PEOPLE');
      }
      // -- Auto-tick FARMER if INDIGENOUS PEOPLE is in sector
      if (sectorList.indexOf('INDIGENOUS PEOPLE') !== -1 && sectorList.indexOf('FARMER') === -1) {
        sectorList.push('FARMER');
      }
      // -- Auto-tick WOMEN if sex is FEMALE
      if (sex === 'FEMALE' && sectorList.indexOf('WOMEN') === -1) {
        sectorList.push('WOMEN');
      }

      // -- Referring unit
      var referringUnit = normalizeReferringUnit(col('REFERRING UNIT'));

      // -- Social case report filename
      var scFile = col('SOCIAL CASE REPORT FILE') ? ucField(col('SOCIAL CASE REPORT FILE')) : '';

      // Skip rows with no name at all
      if (!lastName && !firstName) continue;

      // Skip rows where lastName looks like raw field data (not a real name):
      // - longer than 60 characters
      // - contains parentheses (unit descriptions, remarks)
      // - contains 4 or more words (names are 1-3 words at most)
      // - contains 3 or more commas (field dump)
      // - contains digits mixed with slashes or hyphens
      var wordCount = lastName.trim().split(/\s+/).length;
      var looksLikeData = (lastName.length > 60) ||
        /[()]/.test(lastName) ||
        (wordCount >= 4) ||
        ((lastName.match(/,/g) || []).length >= 3) ||
        (/\d/.test(lastName) && /[\/\-]/.test(lastName));
      if (looksLikeData) continue;

      parsed.push({
        id:                  col('ID') || genId(),
        lastName:            lastName,
        firstName:           firstName,
        middleName:          middleName,
        alias:               alias,
        dob:                 dob,
        sex:                 sex,
        civilStatus:         civilStatus,
        tribalGroup:         tribalGroup,
        recordStatus:        recordStatus,
        religion:            religion,
        contactNumber:       contactNumber,
        medicalCondition:    medicalCond,
        medicalConditionSpec: medicalSpec,
        fourPs:              fourPs,
        pwdDisability:       pwdDisability,
        addressBarangay:     addressBarangay,
        address:             addressBarangay,
        addressMunicipality: municipality,
        addressProvince:     province,
        sector:              sectorList,
        unit:                unit,
        position:            position,
        membershipType:      membershipType,
        areaOfOperation:     areaOfOp,
        yearsInMovement:     yearsInMovement,
        dateSurrendered:     dateSurrendered,
        pendingCase:         pendingCase,
        referringUnit:       referringUnit,
        remarks:             remarks,
        assistance:          asstList,
        validIds:            [],
        idPhoto:             null,
        japic:               null,
        socialCaseReport:    scFile ? { fileName: scFile, url: null, type: 'doc' } : null,
        createdBy:           ucField(col('CREATED BY')) || 'ADMIN',
        createdAt:           col('CREATED AT') || new Date().toISOString(),
        updatedAt:           new Date().toISOString()
      });
    }

    if (!parsed.length) { showToast('NO RECORDS FOUND IN CSV', 'error'); hideImportOverlay(); return; }
    showImportOverlay('CHECKING FOR DUPLICATES...');
    dbGetAll().then(function(existing) {
      // Returns the suffix token ("JR" / "SR") or empty string
      function recGetSuffix(r) {
        var m = [r.lastName, r.firstName, r.middleName, r.alias].join(' ').toUpperCase().match(/\b(JR\.?|SR\.?)\b/);
        return m ? m[1].replace('.', '') : '';
      }
      function nameKey(r) {
        return (r.lastName || '').toUpperCase() + '|' + (r.firstName || '').toUpperCase();
      }
      // Count how many non-empty meaningful fields a record has
      function fieldCount(r) {
        var FIELDS = ['lastName','firstName','middleName','alias','dob','sex','civilStatus',
          'tribalGroup','recordStatus','religion','contactNumber','medicalCondition',
          'medicalConditionSpec','fourPs','pwdDisability','addressBarangay','addressMunicipality',
          'addressProvince','unit','position','membershipType','areaOfOperation',
          'yearsInMovement','dateSurrendered','pendingCase','referringUnit','remarks'];
        var count = 0;
        FIELDS.forEach(function(f) { if (r[f] && String(r[f]).trim() !== '') count++; });
        if (r.sector && r.sector.length)    count += r.sector.length;
        if (r.assistance && r.assistance.length) count += r.assistance.length;
        return count;
      }
      // Merge: copy non-empty values from src into dest, return merged object
      function mergeRecord(dest, src) {
        var MERGE_FIELDS = ['middleName','alias','dob','sex','civilStatus','tribalGroup',
          'recordStatus','religion','contactNumber','medicalCondition','medicalConditionSpec',
          'fourPs','pwdDisability','addressBarangay','address','addressMunicipality',
          'addressProvince','unit','position','membershipType','areaOfOperation',
          'yearsInMovement','dateSurrendered','pendingCase','referringUnit','remarks'];
        var merged = Object.assign({}, dest);
        MERGE_FIELDS.forEach(function(f) {
          if (src[f] && String(src[f]).trim() !== '') merged[f] = src[f];
        });
        // Merge arrays - union without duplicates
        if (src.sector && src.sector.length) {
          var secSet = {};
          (dest.sector || []).forEach(function(s) { secSet[s] = true; });
          src.sector.forEach(function(s) { secSet[s] = true; });
          merged.sector = Object.keys(secSet);
        }
        if (src.assistance && src.assistance.length) {
          var asstSet = {};
          (dest.assistance || []).forEach(function(a) { asstSet[a] = true; });
          src.assistance.forEach(function(a) { asstSet[a] = true; });
          merged.assistance = Object.keys(asstSet);
        }
        merged.updatedAt = new Date().toISOString();
        return merged;
      }

      // Build lookup maps
      var existingById   = {};
      var existingByName = {}; // nameKey ? existing record
      existing.forEach(function(r) {
        existingById[r.id] = r;
        var k = nameKey(r);
        if (!existingByName[k]) existingByName[k] = [];
        existingByName[k].push(r);
      });

      // Also deduplicate within the CSV batch itself (keep first occurrence per name)
      var batchNameKeys = {};
      var toInsert  = [];  // brand-new records
      var toUpdate  = [];  // existing records to be overwritten with merged data
      var skippedNew = 0;  // skipped because existing has same/more data
      var mergedCount = 0;

      parsed.forEach(function(incoming) {
        var k = nameKey(incoming);
        var inSuffix = recGetSuffix(incoming);

        // Find matching existing record (by ID first, then by name)
        var existMatch = null;
        if (existingById[incoming.id]) {
          existMatch = existingById[incoming.id];
        } else {
          // First try exact name key lookup, then fuzzy match across all existing
          var nameMatches = existingByName[k] || [];
          for (var i = 0; i < nameMatches.length; i++) {
            var exSuffix = recGetSuffix(nameMatches[i]);
            if (inSuffix && exSuffix && inSuffix !== exSuffix) continue;
            existMatch = nameMatches[i];
            break;
          }
          // Fuzzy fallback ? catches swapped names and typo variants
          if (!existMatch) {
            for (var fi = 0; fi < existing.length; fi++) {
              var cand = existing[fi];
              var candSuffix = recGetSuffix(cand);
              if (inSuffix && candSuffix && inSuffix !== candSuffix) continue;
              if (fuzzyNameMatch(incoming, cand)) { existMatch = cand; break; }
            }
          }
        }

        if (existMatch) {          // Determine which is more recent by createdAt / dateSurrendered
          var inDate  = incoming.createdAt  || incoming.dateSurrendered || '';
          var exDate  = existMatch.createdAt || existMatch.dateSurrendered || '';
          var inCount = fieldCount(incoming);
          var exCount = fieldCount(existMatch);

          var incomingIsNewer = inDate && exDate && inDate > exDate;
          var incomingHasMore = inCount > exCount;

          if (incomingIsNewer || incomingHasMore) {
            // Merge incoming values into existing - keep existing ID
            var merged = mergeRecord(existMatch, incoming);
            toUpdate.push(merged);
            mergedCount++;
          } else {
            // Existing is same age or newer and has equal/more data - skip
            skippedNew++;
          }
          return;
        }

        // Check for duplicate within the batch itself
        var batchMatches = batchNameKeys[k] || [];
        for (var j = 0; j < batchMatches.length; j++) {
          var bmSuffix = recGetSuffix(batchMatches[j]);
          if (inSuffix && bmSuffix && inSuffix !== bmSuffix) continue;
          skippedNew++; return; // exact same name in same batch
        }

        // Truly new record
        if (!batchNameKeys[k]) batchNameKeys[k] = [];
        batchNameKeys[k].push(incoming);
        toInsert.push(incoming);
      });

      var totalOps = toInsert.length + toUpdate.length;
      if (!totalOps) {
        hideImportOverlay();
        showToast('ALL RECORDS ALREADY UP TO DATE - ' + skippedNew + ' SKIPPED', 'info');
        return;
      }

      showImportOverlay(
        'SAVING ' + toInsert.length + ' NEW + ' + toUpdate.length + ' UPDATED RECORD' +
        (totalOps !== 1 ? 'S' : '') + '...'
      );

      var allOps = toInsert.concat(toUpdate).map(function(r) { return dbPut(r); });
      Promise.all(allOps).then(function() {
        hideImportOverlay();

        // -- Save undo snapshot to localStorage
        var snapshot = {
          timestamp: new Date().toISOString(),
          inserted:  toInsert.map(function(r) { return r.id; }),
          restored:  toUpdate.map(function(r) {
            // Find the pre-merge state from existingById
            var pre = existingById[r.id];
            return pre ? Object.assign({}, pre) : null;
          }).filter(Boolean)
        };
        try { localStorage.setItem('frdb-lastImportSnapshot', JSON.stringify(snapshot)); } catch(e) {}
        updateUndoImportBtn();

        // -- Save recently imported/updated to localStorage for dashboard widget
        var recentKey = 'frdb-recentImports';
        var existing  = [];
        try { existing = JSON.parse(localStorage.getItem(recentKey) || '[]'); } catch(e) { existing = []; }
        var now = new Date().toISOString();
        toInsert.forEach(function(r) {
          existing.push({ id: r.id, name: (r.lastName||'') + ', ' + (r.firstName||'') + (r.middleName ? ' ' + r.middleName : ''), type: 'NEW', timestamp: now });
        });
        toUpdate.forEach(function(r) {
          // Remove any prior entry for this record then re-add as UPDATED
          existing = existing.filter(function(e) { return e.id !== r.id; });
          existing.push({ id: r.id, name: (r.lastName||'') + ', ' + (r.firstName||'') + (r.middleName ? ' ' + r.middleName : ''), type: 'UPDATED', timestamp: now });
        });
        // Keep only the 50 most recent
        existing = existing.slice(-50);
        try { localStorage.setItem(recentKey, JSON.stringify(existing)); } catch(e) {}
        renderRecentImportsWidget();
        hideImportOverlay();
        allRecordsCache = [];
        var parts = [];
        if (toInsert.length) parts.push(toInsert.length + ' NEW');
        if (toUpdate.length) parts.push(toUpdate.length + ' UPDATED');
        var msg = parts.join(', ') + ' RECORD' + (totalOps !== 1 ? 'S' : '') + ' IMPORTED';
        if (skippedNew > 0) msg += ' - ' + skippedNew + ' SKIPPED (ALREADY UP TO DATE)';
        if (skippedMisaligned > 0) msg += ' - ' + skippedMisaligned + ' ROW' + (skippedMisaligned !== 1 ? 'S' : '') + ' SKIPPED (COLUMN MISMATCH ? CHECK CSV FOR UNQUOTED COMMAS)';
        showToast(msg, 'success');
        showPage('records');
      }).catch(function(err) { hideImportOverlay(); showToast('IMPORT ERROR: ' + err.message, 'error'); });
    });
  };
  reader.readAsText(file);
  event.target.value = '';
}

// -- UNDO LAST IMPORT -----------------------------------------
var _undoExpireTimer = null;

function updateUndoImportBtn() {
  var btn = document.getElementById('undoImportBtn');
  if (!btn) return;
  var snapshot = null;
  try { snapshot = JSON.parse(localStorage.getItem('frdb-lastImportSnapshot') || 'null'); } catch(e) {}

  // Expire if older than 5 minutes
  if (snapshot) {
    var age = Date.now() - new Date(snapshot.timestamp).getTime();
    if (age > 5 * 60 * 1000) {
      try { localStorage.removeItem('frdb-lastImportSnapshot'); } catch(e) {}
      snapshot = null;
    }
  }

  if (snapshot) {
    var ts = new Date(snapshot.timestamp).toLocaleString('en-PH', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    var count = (snapshot.inserted || []).length + (snapshot.restored || []).length;
    var remaining = Math.max(0, Math.ceil((5 * 60 * 1000 - (Date.now() - new Date(snapshot.timestamp).getTime())) / 1000));
    var mins = Math.floor(remaining / 60);
    var secs = remaining % 60;
    var timeStr = mins + ':' + (secs < 10 ? '0' : '') + secs;
    btn.style.display = 'inline-flex';
    btn.textContent = '\u21A9 UNDO LAST IMPORT (' + timeStr + ')';
    btn.title = 'Undo import from ' + ts + ' (' + count + ' record' + (count !== 1 ? 's' : '') + ')';

    // Refresh countdown every second
    clearTimeout(_undoExpireTimer);
    _undoExpireTimer = setTimeout(function() { updateUndoImportBtn(); }, 1000);
  } else {
    clearTimeout(_undoExpireTimer);
    btn.style.display = 'none';
    btn.textContent = '\u21A9 UNDO LAST IMPORT';
  }
}

function undoLastImport() {
  var snapshot = null;
  try { snapshot = JSON.parse(localStorage.getItem('frdb-lastImportSnapshot') || 'null'); } catch(e) {}
  if (!snapshot) { showToast('NO IMPORT TO UNDO', 'info'); return; }

  var inserted = snapshot.inserted || [];
  var restored = snapshot.restored || [];
  var total    = inserted.length + restored.length;

  if (!confirm(
    'UNDO LAST IMPORT?\n\n' +
    '? ' + inserted.length + ' new record(s) will be DELETED\n' +
    '? ' + restored.length + ' updated record(s) will be RESTORED to their previous state\n\n' +
    'This cannot be undone again.'
  )) return;

  showImportOverlay('UNDOING IMPORT...');

  var ops = [];

  // Delete newly inserted records
  inserted.forEach(function(id) {
    ops.push(dbDelete(id));
  });

  // Restore pre-merge snapshots of updated records
  restored.forEach(function(r) {
    ops.push(dbPut(r));
  });

  Promise.all(ops).then(function() {
    // Clear snapshot and recent imports for these records
    try { localStorage.removeItem('frdb-lastImportSnapshot'); } catch(e) {}
    try {
      var recentKey = 'frdb-recentImports';
      var entries = JSON.parse(localStorage.getItem(recentKey) || '[]');
      var removedIds = inserted.concat(restored.map(function(r) { return r.id; }));
      entries = entries.filter(function(e) { return removedIds.indexOf(e.id) === -1; });
      localStorage.setItem(recentKey, JSON.stringify(entries));
    } catch(e) {}

    hideImportOverlay();
    allRecordsCache = [];
    updateUndoImportBtn();
    renderRecentImportsWidget();
    showToast('IMPORT UNDONE - ' + total + ' RECORD' + (total !== 1 ? 'S' : '') + ' REVERTED', 'success');
    showPage('records');
  }).catch(function(err) {
    hideImportOverlay();
    showToast('UNDO FAILED: ' + err.message, 'error');
  });
}

// -- EXPORT XLSX -----------------------------------------------
function exportCSV() {
  var unitFilter       = document.getElementById('unitFilterSelect')       ? document.getElementById('unitFilterSelect').value       : '';
  var membershipFilter = document.getElementById('membershipFilterSelect') ? document.getElementById('membershipFilterSelect').value : '';
  var search           = document.getElementById('searchInput')            ? document.getElementById('searchInput').value            : '';
  // Use filtered list if any filter is active, otherwise export all
  var records = (unitFilter || membershipFilter || search) && filteredRecordsCache.length ? filteredRecordsCache : null;

  function doExport(recs) {
    if (!recs.length) { showToast('NO RECORDS TO EXPORT', 'info'); return; }

    var headers = [
      'ID','LAST NAME','FIRST NAME','MIDDLE NAME','ALIAS',
      'DATE OF BIRTH','AGE','SEX','CIVIL STATUS','TRIBAL GROUP','STATUS',
      'RELIGION','CONTACT NUMBER','MEDICAL CONDITION','MEDICAL CONDITION SPECIFY',
      '4Ps','PWD DISABILITY','BARANGAY','MUNICIPALITY','PROVINCE','SECTOR',
      'UNIT','POSITION','MEMBERSHIP TYPE','AREA OF OPERATION','YEARS IN MOVEMENT',
      'DATE SURRENDERED','PENDING CASE','REFERRING UNIT','REMARKS',
      'ASSISTANCE PROVIDED','JAPIC','SOCIAL CASE REPORT FILE',
      'CREATED BY','CREATED AT'
    ];

    var rows = recs.map(function(r) {
      var japic = r.japic && (r.japic.url || r.japic.fileName) ? 'ON FILE' : 'NO JAPIC ATTACHED';
      return [
        r.id,
        r.lastName,
        r.firstName,
        r.middleName,
        r.alias,
        r.dob,
        calcAgeFromDob(r.dob),
        r.sex,
        r.civilStatus,
        normalizeTribalGroup(r.tribalGroup) || r.tribalGroup,
        r.recordStatus || '',
        r.religion,
        r.contactNumber,
        r.medicalCondition,
        r.medicalConditionSpec,
        r.fourPs,
        r.pwdDisability,
        r.addressBarangay || r.address,
        r.addressMunicipality || '',
        r.addressProvince || 'OCCIDENTAL MINDORO',
        (r.sector || []).join('; '),
        r.unit,
        r.position,
        r.membershipType,
        r.areaOfOperation,
        r.yearsInMovement,
        r.dateSurrendered,
        r.pendingCase,
        r.referringUnit,
        r.remarks || '',
        (r.assistance || []).join('; '),
        japic,
        r.socialCaseReport ? (typeof r.socialCaseReport === 'object' ? r.socialCaseReport.fileName : r.socialCaseReport) : '',
        r.createdBy,
        r.createdAt ? new Date(r.createdAt).toLocaleString('en-PH') : ''
      ];
    });

    // Build worksheet data: header row + data rows
    var wsData = [headers].concat(rows);
    var ws = XLSX.utils.aoa_to_sheet(wsData);

    // Auto-fit column widths based on the longest value in each column
    var colWidths = headers.map(function(h, ci) {
      var maxLen = h.length;
      rows.forEach(function(row) {
        var cell = row[ci];
        var len = cell !== null && cell !== undefined ? String(cell).length : 0;
        if (len > maxLen) maxLen = len;
      });
      return { wch: Math.min(maxLen + 2, 60) }; // +2 padding, cap at 60
    });
    ws['!cols'] = colWidths;

    // Set row height for all rows (header + data)
    var rowHeights = wsData.map(function() { return { hpt: 18 }; }); // 18pt per row
    rowHeights[0] = { hpt: 22 }; // slightly taller header row
    ws['!rows'] = rowHeights;

    // Apply borders to every cell
    var borderStyle = {
      top:    { style: 'thin', color: { rgb: '000000' } },
      bottom: { style: 'thin', color: { rgb: '000000' } },
      left:   { style: 'thin', color: { rgb: '000000' } },
      right:  { style: 'thin', color: { rgb: '000000' } }
    };
    var range = XLSX.utils.decode_range(ws['!ref']);
    for (var R = range.s.r; R <= range.e.r; R++) {
      for (var C = range.s.c; C <= range.e.c; C++) {
        var cellAddr = XLSX.utils.encode_cell({ r: R, c: C });
        if (!ws[cellAddr]) ws[cellAddr] = { v: '', t: 's' };
        if (!ws[cellAddr].s) ws[cellAddr].s = {};
        ws[cellAddr].s.border = borderStyle;
        // Bold + background for header row
        if (R === 0) {
          ws[cellAddr].s.font = { bold: true };
          ws[cellAddr].s.fill = { fgColor: { rgb: 'D9E1F2' }, patternType: 'solid' };
          ws[cellAddr].s.alignment = { horizontal: 'center', vertical: 'center', wrapText: true };
        }
      }
    }

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'FR DATABASE');

    var unitLabel = unitFilter ? '_' + unitFilter.replace(/[^A-Z0-9]/gi, '_').toUpperCase() : '';
    var fileName  = 'FR_DATABASE' + unitLabel + '_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    XLSX.writeFile(wb, fileName);

    showToast('XLSX EXPORTED - ' + recs.length + ' RECORD' + (recs.length !== 1 ? 'S' : ''), 'success');
  }

  if (records) { doExport(records); return; }
  dbGetAll().then(function(recs) { allRecordsCache = recs; doExport(recs); });
}

// -- USER MANAGEMENT (Firebase Auth + Firestore) --------------
var editingUserId = null;

function renderUsers() {
  waitForAuth().then(function() {
    return db.collection('users').get();
  }).then(function(snap) {
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
        '<div style="font-size:0.62rem;color:var(--text3);margin-top:2px">&#128231; ' + (u.email || '-') + '</div>' +
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
      showToast('OPERATOR ' + username + ' ADDED - LOGIN: ' + email, 'success');
      cancelUserEdit(); renderUsers();
    }).catch(function(err) {
      if (err.code === 'auth/email-already-in-use') {
        // Auth account exists but Firestore doc was deleted - sign in to get UID and recreate doc
        errEl.textContent = 'RECOVERING EXISTING AUTH ACCOUNT...';
        secondaryAuth.signInWithEmailAndPassword(email, password).then(function(cred) {
          var existingUid = cred.user.uid;
          secondaryAuth.signOut();
          return db.collection('users').doc(existingUid).set({
            username:  username,
            role:      'OPERATOR',
            email:     email,
            uid:       existingUid,
            createdAt: new Date().toISOString()
          });
        }).then(function() {
          errEl.textContent = '';
          showToast('OPERATOR ' + username + ' RESTORED - LOGIN: ' + email, 'success');
          cancelUserEdit(); renderUsers();
        }).catch(function(err2) {
          if (err2.code === 'auth/wrong-password' || err2.code === 'auth/invalid-credential') {
            errEl.textContent = 'USERNAME TAKEN IN FIREBASE AUTH WITH A DIFFERENT PASSWORD. USE A DIFFERENT USERNAME.';
          } else {
            errEl.textContent = 'ERROR: ' + err2.message;
          }
        });
      } else {
        errEl.textContent = 'ERROR: ' + err.message;
      }
    });
  }).catch(function(err) { errEl.textContent = 'ERROR: ' + err.message; });
}

// -- MANUAL MIGRATION TRIGGER ---------------------------------
function runMigrationsManually() {
  if (!currentUser || currentUser.role !== 'ADMIN') { showToast('ACCESS DENIED', 'error'); return; }
  showToast('RUNNING MIGRATIONS...', 'info');
  // Reset the one-time flag so migrations actually run
  localStorage.removeItem('frdb-migrations-done-v2');
  migrateCivilStatus();
  migrateDefaults();
  // Give Firestore time to complete then show result
  setTimeout(function() {
    allRecordsCache = [];
    localStorage.setItem('frdb-migrations-done-v2', '1');
    showToast('MIGRATIONS COMPLETE - RECORDS UPDATED', 'success');
  }, 4000);
}

// -- MIDDLE NAME UPDATE ----------------------------------------
function runMiddleNameUpdate() {
  if (!currentUser || currentUser.role !== 'ADMIN') { 
    showToast('ACCESS DENIED - ADMIN ONLY', 'error'); 
    return; 
  }

  var statusSpan = document.getElementById('middleNameUpdateStatus');
  if (statusSpan) statusSpan.textContent = '? Checking records...';
  
  showToast('CHECKING RECORDS WITH MISSING MIDDLE NAMES...', 'info');

  waitForAuth().then(function() {
    return db.collection('records').get();
  }).then(function(snapshot) {
    var needsUpdate = [];
    var alreadySet = 0;

    snapshot.forEach(function(doc) {
      var data = doc.data();
      var middleName = data.middleName;

      if (!middleName || middleName.trim() === '' || middleName.trim().length <= 1) {
        var fullName = (data.lastName || '?') + ', ' + (data.firstName || '?');
        needsUpdate.push({
          id: doc.id,
          name: fullName,
          ref: doc.ref
        });
      } else {
        alreadySet++;
      }
    });

    if (statusSpan) {
      statusSpan.textContent = 'Found ' + needsUpdate.length + ' record(s) needing update';
    }

    if (needsUpdate.length === 0) {
      showToast('? ALL RECORDS ALREADY HAVE MIDDLE NAMES SET', 'success');
      if (statusSpan) statusSpan.textContent = '? All records have middle names';
      return;
    }

    // Build confirmation message with record list
    var recordsList = needsUpdate.slice(0, 10).map(function(r) { return '  ? ' + r.name; }).join('\n');
    if (needsUpdate.length > 10) {
      recordsList += '\n  ... and ' + (needsUpdate.length - 10) + ' more';
    }

    var confirmMsg = 'UPDATE ' + needsUpdate.length + ' RECORD(S)?\n\n' +
                     'These records will have middleName set to "UNKNOWN":\n\n' +
                     recordsList + '\n\n' +
                     'CONTINUE?';

    if (!confirm(confirmMsg)) {
      showToast('UPDATE CANCELLED', 'info');
      if (statusSpan) statusSpan.textContent = '';
      return;
    }

    // Update records
    if (statusSpan) statusSpan.textContent = '? Updating ' + needsUpdate.length + ' record(s)...';
    showToast('UPDATING RECORDS...', 'info');

    var completed = 0;
    var failed = 0;
    var promises = needsUpdate.map(function(record) {
      return record.ref.update({ middleName: 'UNKNOWN' })
        .then(function() {
          completed++;
        })
        .catch(function(error) {
          failed++;
          console.error('Failed to update ' + record.name + ':', error);
        });
    });

    return Promise.all(promises).then(function() {
      var msg = '? UPDATED ' + completed + ' RECORD(S)';
      if (failed > 0) {
        msg += ' (' + failed + ' FAILED)';
        showToast(msg, 'error');
      } else {
        showToast(msg, 'success');
      }
      
      if (statusSpan) {
        statusSpan.textContent = '? Updated ' + completed + ' record(s)';
      }

      // Refresh cache and current page
      allRecordsCache = [];
      if (currentPage) {
        setTimeout(function() { showPage(currentPage); }, 1000);
      }
    });

  }).catch(function(error) {
    var errorMsg = 'ERROR: ' + error.message;
    showToast(errorMsg, 'error');
    if (statusSpan) statusSpan.textContent = '? Error';
    console.error('Middle name update error:', error);
  });
}

// -- NAIBUAN TRIBAL FIX (one-time migration) ------------------
function runNaibuanTribalFix() {
  if (!currentUser || currentUser.role !== 'ADMIN') { showToast('ACCESS DENIED - ADMIN ONLY', 'error'); return; }
  var statusSpan = document.getElementById('naibuanFixStatus');
  if (statusSpan) statusSpan.textContent = 'Checking records...';
  showToast('SCANNING FOR NAIBUAN RECORDS...', 'info');

  waitForAuth().then(function() {
    return db.collection('records').get();
  }).then(function(snapshot) {
    var toFix = [];
    snapshot.forEach(function(doc) {
      var r = doc.data();
      var addr = ((r.addressBarangay || '') + ' ' + (r.address || '')).toUpperCase();
      if (addr.indexOf('NAIBUAN') !== -1 && r.tribalGroup !== 'HANUNUO') {
        toFix.push({ ref: doc.ref });
      }
    });

    if (!toFix.length) {
      showToast('NO NAIBUAN RECORDS NEED UPDATING', 'success');
      if (statusSpan) statusSpan.textContent = 'Nothing to update.';
      return;
    }

    if (!confirm('Set tribalGroup = "HANUNUO" on ' + toFix.length + ' record(s) with NAIBUAN address?\n\nThis cannot be undone.')) {
      if (statusSpan) statusSpan.textContent = '';
      return;
    }

    if (statusSpan) statusSpan.textContent = 'Updating ' + toFix.length + ' record(s)...';
    var batch = db.batch();
    toFix.forEach(function(item) {
      batch.update(item.ref, { tribalGroup: 'HANUNUO', updatedAt: new Date().toISOString() });
    });
    return batch.commit().then(function() {
      showToast('UPDATED ' + toFix.length + ' RECORD(S) TO HANUNUO', 'success');
      if (statusSpan) statusSpan.textContent = '? Updated ' + toFix.length + ' record(s).';
      allRecordsCache = [];
    });
  }).catch(function(err) {
    showToast('ERROR: ' + err.message, 'error');
    if (statusSpan) statusSpan.textContent = '? Error.';
  });
}

// -- NO TRIBAL GROUP FIX (one-time migration) -----------------
function runNoTribalGroupFix() {
  if (!currentUser || currentUser.role !== 'ADMIN') { showToast('ACCESS DENIED - ADMIN ONLY', 'error'); return; }
  var statusSpan = document.getElementById('noTribalGroupFixStatus');
  if (statusSpan) statusSpan.textContent = 'Checking records...';
  showToast('SCANNING FOR RECORDS WITH NO TRIBAL GROUP DATA...', 'info');

  waitForAuth().then(function() {
    return db.collection('records').get();
  }).then(function(snapshot) {
    var toFix = [];
    snapshot.forEach(function(doc) {
      var r = doc.data();
      if (!r.tribalGroup || r.tribalGroup.trim() === '') {
        toFix.push({
          ref: doc.ref,
          name: (r.lastName || '?') + ', ' + (r.firstName || '?')
        });
      }
    });

    if (!toFix.length) {
      showToast('NO RECORDS WITH MISSING TRIBAL GROUP FOUND', 'success');
      if (statusSpan) statusSpan.textContent = 'Nothing to update.';
      return;
    }

    var recordsList = toFix.slice(0, 10).map(function(r) { return '  - ' + r.name; }).join('\n');
    if (toFix.length > 10) recordsList += '\n  ... and ' + (toFix.length - 10) + ' more';

    if (!confirm('Set tribalGroup = "NO TRIBAL GROUP" on ' + toFix.length + ' record(s) with no tribal group data?\n\n' + recordsList + '\n\nTHIS CANNOT BE UNDONE.')) {
      if (statusSpan) statusSpan.textContent = '';
      return;
    }

    if (statusSpan) statusSpan.textContent = 'Updating ' + toFix.length + ' record(s)...';
    var batch = db.batch();
    toFix.forEach(function(item) {
      batch.update(item.ref, { tribalGroup: 'NO TRIBAL GROUP', updatedAt: new Date().toISOString() });
    });
    return batch.commit().then(function() {
      showToast('UPDATED ' + toFix.length + ' RECORD(S) TO NO TRIBAL GROUP', 'success');
      if (statusSpan) statusSpan.textContent = 'Updated ' + toFix.length + ' record(s).';
      allRecordsCache = [];
    });
  }).catch(function(err) {
    showToast('ERROR: ' + err.message, 'error');
    if (statusSpan) statusSpan.textContent = 'Error.';
  });
}

// -- UNRECOGNIZED TRIBAL GROUP FIX (one-time migration) -------
function runUnrecognizedTribalGroupFix() {
  if (!currentUser || currentUser.role !== 'ADMIN') { showToast('ACCESS DENIED - ADMIN ONLY', 'error'); return; }
  var statusSpan = document.getElementById('unrecognizedTribalGroupFixStatus');
  if (statusSpan) statusSpan.textContent = 'Checking records...';
  showToast('SCANNING FOR RECORDS WITH UNSPECIFIED TRIBAL GROUP...', 'info');

  var VALID_TRIBAL = ['IRAYA','ALANGAN','TADYAWAN','TAU-BUID','BANGON','BUHID','HANUNUO','RATAGNON','OTHERS','NO TRIBAL GROUP'];

  waitForAuth().then(function() {
    return db.collection('records').get();
  }).then(function(snapshot) {
    var toFix = [];
    snapshot.forEach(function(doc) {
      var r = doc.data();
      var tg = (r.tribalGroup || '').trim().toUpperCase();
      if (tg && VALID_TRIBAL.indexOf(tg) === -1) {
        var sector = r.sector || [];
        var needsIP = sector.indexOf('INDIGENOUS PEOPLE') === -1;
        var needsFarmer = sector.indexOf('FARMER') === -1;
        toFix.push({
          ref: doc.ref,
          name: (r.lastName || '?') + ', ' + (r.firstName || '?'),
          currentValue: r.tribalGroup,
          sector: sector,
          needsIP: needsIP,
          needsFarmer: needsFarmer
        });
      }
    });

    if (!toFix.length) {
      showToast('NO RECORDS WITH UNRECOGNIZED TRIBAL GROUP FOUND', 'success');
      if (statusSpan) statusSpan.textContent = 'Nothing to update.';
      return;
    }

    var recordsList = toFix.slice(0, 10).map(function(r) {
      return '  - ' + r.name + ' (currently: "' + r.currentValue + '")';
    }).join('\n');
    if (toFix.length > 10) recordsList += '\n  ... and ' + (toFix.length - 10) + ' more';

    if (!confirm('Set tribalGroup = "OTHERS" and add INDIGENOUS PEOPLE to sector on ' + toFix.length + ' record(s) with unrecognized tribal group values?\n\n' + recordsList + '\n\nTHIS CANNOT BE UNDONE.')) {
      if (statusSpan) statusSpan.textContent = '';
      return;
    }

    if (statusSpan) statusSpan.textContent = 'Updating ' + toFix.length + ' record(s)...';
    var batch = db.batch();
    toFix.forEach(function(item) {
      var newSector = item.sector.slice();
      if (item.needsIP)     newSector.push('INDIGENOUS PEOPLE');
      if (item.needsFarmer) newSector.push('FARMER');
      batch.update(item.ref, {
        tribalGroup: 'OTHERS',
        sector: newSector,
        updatedAt: new Date().toISOString()
      });
    });
    return batch.commit().then(function() {
      showToast('UPDATED ' + toFix.length + ' RECORD(S) TO OTHERS (IP)', 'success');
      if (statusSpan) statusSpan.textContent = 'Updated ' + toFix.length + ' record(s).';
      allRecordsCache = [];
    });
  }).catch(function(err) {
    showToast('ERROR: ' + err.message, 'error');
    if (statusSpan) statusSpan.textContent = 'Error.';
  });
}

// -- PURGE ALL OPERATORS --------------------------------------
function purgeAllOperators() {
  if (!currentUser || currentUser.role !== 'ADMIN') { showToast('ACCESS DENIED', 'error'); return; }
  if (!confirm('DELETE ALL OPERATOR PROFILES FROM FIRESTORE?\n\nThis removes all operator documents.\nYou must also delete their accounts manually in the Firebase Console.\n\nTHIS CANNOT BE UNDONE.')) return;

  waitForAuth().then(function() {
    return db.collection('users').where('role', '==', 'OPERATOR').get();
  }).then(function(snap) {
    if (!snap.size) { showToast('NO OPERATORS TO DELETE', 'info'); return; }
    var batch = db.batch();
    snap.docs.forEach(function(d) { batch.delete(d.ref); });
    return batch.commit().then(function() {
      showToast('ALL ' + snap.size + ' OPERATOR PROFILE(S) DELETED', 'error');
      renderUsers();
    });
  }).catch(function(err) { showToast('ERROR: ' + err.message, 'error'); });
}

function deleteUser(id) {
  if (!currentUser || currentUser.role !== 'ADMIN') { showToast('ACCESS DENIED', 'error'); return; }
  if (!confirm('DELETE THIS OPERATOR?\n\nThis removes their Firestore profile and blocks login.\nNote: If you re-add the same username later, use the same password.\nTHIS CANNOT BE UNDONE.')) return;
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
document.getElementById('duplicatesModal').addEventListener('click',function(e){if(e.target===this)closeDuplicatesModal();});

// -- IDLE LOGOUT (3 minutes) ----------------------------------
var IDLE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
var idleTimer = null;

function resetIdleTimer() {
  if (!currentUser) return; // only track when logged in
  clearTimeout(idleTimer);
  idleTimer = setTimeout(function() {
    if (!currentUser) return;
    showToast('SESSION EXPIRED - LOGGED OUT DUE TO INACTIVITY', 'error');
    setTimeout(function() { doLogout(); }, 1500);
  }, IDLE_TIMEOUT_MS);
}

// Listen to all user activity events
['mousemove','mousedown','keydown','touchstart','scroll','click'].forEach(function(evt) {
  document.addEventListener(evt, resetIdleTimer, { passive: true });
});

// -- AUTO LOGOUT ON WINDOW CLOSE ------------------------------
// Fires when the Electron window is closed (or browser tab unloaded).
// Signs out from Firebase so the session is invalidated immediately.
window.addEventListener('beforeunload', function() {
  try {
    if (typeof auth !== 'undefined' && auth.currentUser) {
      auth.signOut();
    }
  } catch (e) { /* silent — window is already closing */ }
});

// -- ELECTRON TITLE BAR --------------------------------------
(function() {
  // Only activate when running inside Electron (electronAPI is injected by preload.js)
  if (!window.electronAPI) return;

  // Show the title bar and push body content down
  var bar = document.getElementById('titleBar');
  if (bar) bar.classList.add('visible');
  document.body.classList.add('electron-mode');

  // Sync the maximize/restore icon on load
  window.electronAPI.isMaximized().then(function(isMax) {
    updateMaxBtn(isMax);
  });

  // Keep in sync when the window is maximized/restored externally (e.g. Win+?)
  window.electronAPI.onMaximized(function(isMax) {
    updateMaxBtn(isMax);
  });

  function updateMaxBtn(isMax) {
    var btn = document.getElementById('tbMaxBtn');
    if (!btn) return;
    // ? = restore, ? = maximize
    btn.innerHTML   = isMax ? '&#10697;' : '&#9744;';
    btn.title       = isMax ? 'Restore'  : 'Maximize';
  }
})();

function tbMinimize() { if (window.electronAPI) window.electronAPI.minimize(); }
function tbMaximize() { if (window.electronAPI) window.electronAPI.maximize(); }
function tbClose()    { if (window.electronAPI) window.electronAPI.close();    }
function tbRefresh()  { location.reload(); }

// -- THEME TOGGLE --------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  var icon  = document.getElementById('themeToggleIcon');
  var label = document.getElementById('themeToggleLabel');
  if (theme === 'light') {
    if (icon)  icon.textContent  = '\uD83C\uDF19'; // ?? moon
    if (label) label.textContent = 'DARK';
  } else {
    if (icon)  icon.textContent  = '\u2600\uFE0F'; // ?? sun
    if (label) label.textContent = 'LIGHT';
  }
  localStorage.setItem('frdb-theme', theme);
}

function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// Apply saved theme immediately on load (before login)
(function() {
  var saved = localStorage.getItem('frdb-theme') || 'dark';
  applyTheme(saved);
})();

// -- HOLIDAY DYNAMIC THEMES (login page only) ----------------
var HOLIDAY_CONFIG = {
  christmas:   { emojis: ['\u2744\uFE0F','\uD83C\uDF84','\u26C4','\uD83D\uDD14','\uD83C\uDF81','\uD83E\uDD8C','\u2B50'], count: 18 },
  newyear:     { emojis: ['\uD83C\uDF86','\uD83C\uDF87','\u2728','\uD83C\uDF89','\uD83E\uDD42','\uD83C\uDF1F'], count: 14 },
  valentines:  { emojis: ['\u2764\uFE0F','\uD83D\uDC95','\uD83D\uDC9E','\uD83C\uDF39','\uD83D\uDC9D','\uD83D\uDC98'], count: 16 },
  halloween:   { emojis: ['\uD83C\uDF83','\uD83D\uDC7B','\uD83E\uDE87','\uD83D\uDD78\uFE0F','\uD83D\uDD78','\uD83D\uDC80','\uD83E\uDD89'], count: 8 },
  arawatan:    { emojis: ['\uD83C\uDF34','\u2600\uFE0F','\uD83C\uDF3A','\uD83C\uDF89','\uD83C\uDFB6','\uD83C\uDFBA','\uD83E\uDD41','\uD83E\uDE95'], count: 16 },
  jacobs:      { emojis: ['\uD83C\uDF82','\uD83C\uDF88','\uD83C\uDF89','\uD83C\uDF81','\uD83E\uDD73','\uD83C\uDF8A','\uD83E\uDDC1','\uD83C\uDF86'], count: 16 },
  independence:{ emojis: ['\u2B50','\uD83C\uDDF5\uD83C\uDDF2','\u2600\uFE0F','\uD83E\uDD99','\uD83C\uDF3A'], count: 14 }
};

// Returns a holiday key based on the current date, or null for none.
function getCurrentHoliday() {
  var now = new Date();
  var m = now.getMonth() + 1; // 1-12
  var d = now.getDate();
  if (m === 12)                          return 'christmas';    // all of December
  if (m === 1 && d <= 7)                 return 'newyear';      // Jan 1-7
  if (m === 2 && d <= 15)                return 'valentines';   // Feb 1-15
  if ((m === 10 && d >= 15) ||
      (m === 11 && d <= 2))              return 'halloween';    // Oct 15 - Nov 2
  if (m === 11 && d >= 10 && d <= 15)    return 'arawatan';     // Nov 10-15 Arawatan Festival
  if (m === 6 && d === 15)               return 'jacobs';       // Jun 15 Jacob's Birthday
  if (m === 6 && d <= 15)                return 'independence'; // Jun 1-15 (PH Independence)
  return null;
}

// Applies the holiday theme to the login screen only.
function applyHolidayTheme() {
  var holiday = getCurrentHoliday();
  var loginScreen = document.getElementById('loginScreen');
  if (!loginScreen) return;
  if (holiday) {
    loginScreen.setAttribute('data-holiday', holiday);
    var decor = document.getElementById('holidayDecor');
    if (decor) {
      decor.innerHTML = '';

      // === HALLOWEEN SCARY EFFECTS ===
      if (holiday === 'halloween') {
        // Two realistic spiders at different positions
        var spiderData = [
          { left: 12 + Math.random() * 22, delay: 0 },
          { left: 66 + Math.random() * 22, delay: 4.5 }
        ];
        spiderData.forEach(function(sd) {
          var spider = document.createElement('div');
          spider.className = 'hween-spider';
          spider.style.left = sd.left + '%';
          spider.innerHTML =
            '<div class="hween-silk"></div>' +
            '<div class="hween-spider-body">' +
              '<div class="hween-leg hween-l1"></div><div class="hween-leg hween-l2"></div>' +
              '<div class="hween-leg hween-l3"></div><div class="hween-leg hween-l4"></div>' +
              '<div class="hween-leg hween-r1"></div><div class="hween-leg hween-r2"></div>' +
              '<div class="hween-leg hween-r3"></div><div class="hween-leg hween-r4"></div>' +
              '<div class="hween-spider-eyes"></div>' +
            '</div>';
          if (sd.delay) {
            spider.querySelector('.hween-silk').style.animationDelay = sd.delay + 's';
            spider.querySelector('.hween-spider-body').style.animationDelay = sd.delay + 's';
          }
          decor.appendChild(spider);
        });

        // Peeking ghost
        var ghost = document.createElement('div');
        ghost.className = 'hween-ghost';
        ghost.innerHTML =
          '<div class="hween-ghost-eyes"></div>' +
          '<div class="hween-ghost-mouth"></div>';
        decor.appendChild(ghost);

        // Glowing eyes in the dark (4 pairs spread evenly across screen)
        var eyePositions = [
          { left: 6 + Math.random() * 14,  top: 15 + Math.random() * 20 },
          { left: 32 + Math.random() * 14, top: 58 + Math.random() * 18 },
          { left: 60 + Math.random() * 14, top: 18 + Math.random() * 20 },
          { left: 82 + Math.random() * 10, top: 52 + Math.random() * 22 }
        ];
        eyePositions.forEach(function(pos, idx) {
          var eyePair = document.createElement('div');
          eyePair.className = 'hween-eyes-pair';
          eyePair.style.left = pos.left + '%';
          eyePair.style.top = pos.top + '%';
          eyePair.style.animationDelay = (idx * 1.5 + Math.random() * 2) + 's';
          eyePair.style.animationDuration = (5 + Math.random() * 4) + 's';
          decor.appendChild(eyePair);
        });

        // Rolling fog at the bottom
        var fog = document.createElement('div');
        fog.className = 'hween-fog';
        decor.appendChild(fog);
      }
    }
    console.log('[FRDB] Holiday theme applied: ' + holiday);
  } else {
    loginScreen.removeAttribute('data-holiday');
    var d = document.getElementById('holidayDecor');
    if (d) d.innerHTML = '';
  }
}

// Apply holiday theme immediately on load (before login)
applyHolidayTheme();

// -- MANIACAL LAUGH (Halloween login sound) -------------------
function playManiacalLaugh() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ctx = new AC();
    var now = ctx.currentTime;

    // Master volume
    var master = ctx.createGain();
    master.gain.value = 0.25;
    master.connect(ctx.destination);

    // Delay for a creepy echo
    var delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.18;
    var delayGain = ctx.createGain();
    delayGain.gain.value = 0.35;
    var feedback = ctx.createGain();
    feedback.gain.value = 0.4;
    delay.connect(delayGain);
    delayGain.connect(master);
    delayGain.connect(feedback);
    feedback.connect(delay);

    // Series of "ha" syllables with rising pitch (maniacal escalation)
    var numHa = 10, haDur = 0.13, gap = 0.07, basePitch = 150;

    for (var i = 0; i < numHa; i++) {
      var t = now + i * (haDur + gap);
      var pitch = basePitch + i * 22;          // each ha rises in pitch
      var endPitch = pitch * 0.65;             // drop within the syllable

      // Harsh sawtooth for gritty voice character
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(pitch, t);
      osc.frequency.exponentialRampToValueAtTime(endPitch, t + haDur);

      // Square wave an octave below for body
      var osc2 = ctx.createOscillator();
      osc2.type = 'square';
      osc2.frequency.setValueAtTime(pitch * 0.5, t);
      osc2.frequency.exponentialRampToValueAtTime(endPitch * 0.5, t + haDur);

      // Vibrato for an unhinged wobble (gets faster with each ha)
      var vib = ctx.createOscillator();
      vib.frequency.value = 6 + i * 0.5;
      var vibGain = ctx.createGain();
      vibGain.gain.value = 8;
      vib.connect(vibGain);
      vibGain.connect(osc.frequency);
      vib.start(t);
      vib.stop(t + haDur);

      // Bandpass filter for a voice-like tone
      var filt = ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = pitch * 2.5;
      filt.Q.value = 1.5;

      // Amplitude envelope — quick attack, fast decay per "ha"
      var env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.8, t + 0.012);
      env.gain.exponentialRampToValueAtTime(0.01, t + haDur);

      osc.connect(filt);
      osc2.connect(filt);
      filt.connect(env);
      env.connect(master);
      env.connect(delay);

      osc.start(t); osc.stop(t + haDur);
      osc2.start(t); osc2.stop(t + haDur);
    }

    // Clean up audio context after the laugh + echo finishes
    var totalDur = numHa * (haDur + gap) + 2.5;
    setTimeout(function() { try { ctx.close(); } catch(e) {} }, totalDur * 1000);
  } catch(e) {
    console.warn('[FRDB] Laugh sound failed:', e.message);
  }
}

// -- DEFAULTS MIGRATION ---------------------------------------
// Fills in missing position, yearsInMovement, civilStatus on existing records
function migrateDefaults() {
  waitForAuth().then(function() {
    return db.collection('records').get();
  }).then(function(snap) {
    var toFix = [];
    snap.docs.forEach(function(d) {
      var r = d.data();
      var updates = {};
      if (!r.position)        updates.position        = 'MEMBER';
      if (!r.yearsInMovement && r.yearsInMovement !== 0)
                              updates.yearsInMovement = '1';
      if (!r.civilStatus)     updates.civilStatus     = defaultCivilStatus(r.dob);
      // Fix referring unit variants (e.g. all-caps "SCORPION" ? canonical form)
      if (r.referringUnit) {
        var normalized = normalizeReferringUnit(r.referringUnit);
        if (normalized && normalized !== r.referringUnit) updates.referringUnit = normalized;
      }
      // MILISYANG BAYAN with no unit ? default unit to "MB"
      if (r.membershipType === 'MILISYANG BAYAN' && !r.unit) {
        updates.unit = 'MB';
      }
      if (Object.keys(updates).length > 0) {
        updates.updatedAt = new Date().toISOString();
        toFix.push({ ref: d.ref, updates: updates });
      }
    });
    if (!toFix.length) { console.log('[FRDB] migrateDefaults: nothing to fix'); return; }
    // Firestore batch limit is 500
    var BATCH_SIZE = 400;
    var batches = [];
    for (var i = 0; i < toFix.length; i += BATCH_SIZE) {
      var batch = db.batch();
      toFix.slice(i, i + BATCH_SIZE).forEach(function(item) {
        batch.update(item.ref, item.updates);
      });
      batches.push(batch.commit());
    }
    return Promise.all(batches).then(function() {
      console.log('[FRDB] migrateDefaults: updated ' + toFix.length + ' record(s)');
    });
  }).catch(function(err) {
    console.warn('[FRDB] migrateDefaults failed:', err.message);
  });
}

// -- CIVIL STATUS MIGRATION -----------------------------------
// Rewrites legacy values: "LIVE-IN" and "COMMON-LAW PARTNER" ? "COMMON-LAW"
function migrateCivilStatus() {
  var OLD_VALUES = ['LIVE-IN', 'COMMON-LAW PARTNER'];
  var NEW_VALUE  = 'COMMON-LAW';
  dbGetAll().then(function(records) {
    var toFix = records.filter(function(r) {
      return OLD_VALUES.indexOf(r.civilStatus) !== -1;
    });
    if (!toFix.length) return; // nothing to do
    var batch = db.batch();
    toFix.forEach(function(r) {
      var ref = db.collection('surrenderees').doc(r.id);
      batch.update(ref, { civilStatus: NEW_VALUE, updatedAt: new Date().toISOString() });
    });
    batch.commit().then(function() {
      console.log('[FRDB] Migrated ' + toFix.length + ' record(s): civil status ? COMMON-LAW');
    }).catch(function(err) {
      console.warn('[FRDB] Civil status migration failed:', err.message);
    });
  });
}

// ============================================================
// NARRATIVE REPORT GENERATOR
// Produces a written prose summary of the entire dashboard.
// ============================================================

var NARRATIVE_REPORT_STYLES =
  'body{font-family:Georgia,"Times New Roman",serif;color:#111;margin:0;padding:32px 40px;font-size:13px;line-height:1.75}' +
  'h1{font-size:15px;text-align:center;letter-spacing:2px;margin:0 0 4px;text-transform:uppercase}' +
  '.sub-title{text-align:center;font-size:11px;color:#555;letter-spacing:1.5px;margin-bottom:4px;font-family:Arial,sans-serif}' +
  '.meta{text-align:center;font-size:10px;color:#777;margin-bottom:28px;font-family:Arial,sans-serif}' +
  'hr{border:none;border-top:2px solid #111;margin:0 0 24px}' +
  'h2{font-size:13px;letter-spacing:1.5px;text-transform:uppercase;margin:28px 0 8px;font-family:Arial,sans-serif;border-bottom:1px solid #ccc;padding-bottom:4px}' +
  'p{margin:0 0 12px;text-align:justify}' +
  '.highlight{font-weight:bold}' +
  '.stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}' +
  '.stat-box{border:1px solid #ccc;padding:8px 10px;text-align:center;border-radius:4px}' +
  '.stat-box .num{font-size:20px;font-weight:bold;display:block}' +
  '.stat-box .lbl{font-size:9px;letter-spacing:1px;color:#555;font-family:Arial,sans-serif}' +
  '.stat-box.warn .num{color:#9a6700}' +
  '.stat-box.danger .num{color:#c42b1c}' +
  '.stat-box.purple .num{color:#7a43b6}' +
  'table{width:100%;border-collapse:collapse;font-size:11px;margin:10px 0 18px;font-family:Arial,sans-serif}' +
  'th{background:#f0f0f0;border:1px solid #ccc;padding:5px 8px;text-align:left;font-size:9.5px;letter-spacing:.8px}' +
  'th.num,td.num{text-align:center}' +
  'td{border:1px solid #ccc;padding:5px 8px}' +
  'tr:nth-child(even) td{background:#fafafa}' +
  '.alert-table td:first-child{font-weight:bold}' +
  '.footer{margin-top:32px;padding-top:10px;border-top:1px solid #ccc;font-size:9px;color:#888;text-align:center;font-family:Arial,sans-serif}' +
  '@media print{' +
    'body{padding:12px}' +
    '@page{margin:12mm 12mm 20mm 12mm;size:A4;}' +
    '@page{@bottom-center{content:"PSWDO2026";font-family:Arial,sans-serif;font-size:9pt;color:#555;letter-spacing:2px;}}' +
  '}';

function _runNarrative(records, mode) {
    if (!records.length) { showToast('NO RECORDS TO GENERATE NARRATIVE', 'info'); return; }

    var total     = records.length;
    var printed   = new Date().toLocaleString('en-PH', { weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit' });
    var printedBy = currentUser ? currentUser.username + ' (' + currentUser.role + ')' : 'UNKNOWN';
    var reportDate = new Date().toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });

    // ── HELPER: ordinal / percentage ─────────────────────────
    function pct(n) { return total > 0 ? ((n / total) * 100).toFixed(1) : '0.0'; }
    function fmt(n) { return n.toLocaleString(); }

    // ── CORE COUNTS ──────────────────────────────────────────
    var male         = records.filter(function(r){ return r.sex === 'MALE'; }).length;
    var female       = records.filter(function(r){ return r.sex === 'FEMALE'; }).length;
    var regularNpa   = records.filter(function(r){ return r.membershipType === 'REGULAR NPA'; }).length;
    var milisyang    = records.filter(function(r){ return r.membershipType === 'MILISYANG BAYAN'; }).length;
    var noMemType    = total - regularNpa - milisyang;
    var cannotLocate = records.filter(function(r){ return r.recordStatus === 'CANNOT BE LOCATED'; }).length;
    var deceased     = records.filter(function(r){ return r.recordStatus === 'DECEASED'; }).length;
    var incarcerated = records.filter(function(r){ return r.recordStatus === 'INCARCERATED'; }).length;
    var activeCount  = total - cannotLocate - deceased - incarcerated;

    // ── JAPIC & E-CLIP ───────────────────────────────────────
    var withJapic  = records.filter(function(r){ return r.japic && (r.japic.url || r.japic.dataUrl || r.japic.fileName); }).length;
    var noJapic    = total - withJapic;
    var withEclip  = records.filter(function(r){ return (r.assistance||[]).indexOf('E-CLIP') !== -1; }).length;
    var notQualEclip = records.filter(function(r){ return (r.assistance||[]).indexOf('NOT QUALIFIED FOR E-CLIP') !== -1; }).length;
    var noEclipCount = records.filter(function(r){
      var a = r.assistance || [];
      return a.indexOf('E-CLIP') === -1 && a.indexOf('NOT QUALIFIED FOR E-CLIP') === -1;
    }).length;
    var noAssistanceNarr = records.filter(function(r){ return !r.assistance || r.assistance.length === 0; }).length;
    var incomplete = records.filter(function(r){ return getMissingFieldsGlobal(r).length > 0; }).length;

    // ── ASSISTANCE ───────────────────────────────────────────
    var ASST_TYPES = ['E-CLIP','NOT QUALIFIED FOR E-CLIP','FEA REMUNERATION','LIVELIHOOD','MEDICAL','EDUCATIONAL','ISSUANCE OF CREDENTIALS','PHILHEALTH','ISSUANCE OF SAFE CONDUCT PASS','APPLIED FOR AMNESTY','OTHERS'];
    var asstCounts = {}; ASST_TYPES.forEach(function(t){ asstCounts[t] = 0; });
    records.forEach(function(r){
      (r.assistance||[]).forEach(function(a){
        var k = a.indexOf('OTHERS') === 0 ? 'OTHERS' : a;
        if (asstCounts[k] !== undefined) asstCounts[k]++;
      });
    });
    var totalBeneficiaries = records.filter(function(r){ return r.assistance && r.assistance.length > 0; }).length;

    // ── TRIBAL ───────────────────────────────────────────────
    var TRIBAL_TYPES = TRIBAL_GROUP_TYPES.slice();
    var tribalCounts = {}; TRIBAL_TYPES.forEach(function(t){ tribalCounts[t] = 0; });
    records.forEach(function(r){ var k = normalizeTribalGroup(r.tribalGroup); if (k && tribalCounts[k] !== undefined) tribalCounts[k]++; });
    var withTribal   = TRIBAL_TYPES.reduce(function(s,t){ return s + tribalCounts[t]; }, 0);
    var ipCount      = TRIBAL_TYPES.filter(function(t){ return t !== 'NO TRIBAL GROUP'; }).reduce(function(s,t){ return s + tribalCounts[t]; }, 0);
    var nonIpCount   = tribalCounts['NO TRIBAL GROUP'];
    var noTribalData = total - withTribal;

    // ── AGE BRACKETS ─────────────────────────────────────────
    var BRACKETS = [
      {label:'18 & BELOW', min:0,  max:18},
      {label:'19-24',      min:19, max:24},
      {label:'25-30',      min:25, max:30},
      {label:'31-40',      min:31, max:40},
      {label:'41-59',      min:41, max:59},
      {label:'60 & ABOVE', min:60, max:999}
    ];
    var ageCounts = BRACKETS.map(function(){ return 0; });
    var withAge = 0;
    records.forEach(function(r){
      var age = parseInt(calcAgeFromDob(r.dob)); if (isNaN(age)) return; withAge++;
      for (var i = 0; i < BRACKETS.length; i++) {
        if (age >= BRACKETS[i].min && age <= BRACKETS[i].max) { ageCounts[i]++; break; }
      }
    });
    // Find peak age bracket
    var peakAgeIdx = ageCounts.indexOf(Math.max.apply(null, ageCounts));

    // ── 4Ps ──────────────────────────────────────────────────
    var fourPsYes  = records.filter(function(r){ return r.fourPs === 'YES'; }).length;
    var fourPsNo   = records.filter(function(r){ return r.fourPs === 'NO';  }).length;
    var fourPsNone = total - fourPsYes - fourPsNo;

    // ── SECTORS ──────────────────────────────────────────────
    var SECTORS = ['FARMER','FISHERFOLK','WOMEN','PWD','CHILDREN AND YOUTH','SENIOR CITIZEN','SOLO PARENT','INDIGENOUS PEOPLE','URBAN POOR','OTHERS'];
    var secCounts = {}; SECTORS.forEach(function(s){ secCounts[s] = 0; });
    records.forEach(function(r){
      (r.sector||[]).forEach(function(s){
        if (s === 'FARMER/FISHERFOLK'){ secCounts['FARMER']++; secCounts['FISHERFOLK']++; return; }
        var k = s.indexOf('OTHERS') === 0 ? 'OTHERS' : s;
        if (secCounts[k] !== undefined) secCounts[k]++;
      });
    });
    var topSectors = SECTORS.slice().sort(function(a,b){ return secCounts[b]-secCounts[a]; }).slice(0,3);

    // ── MUNICIPALITY ─────────────────────────────────────────
    var OCC_MUN = MUNICIPALITIES_BY_PROVINCE['OCCIDENTAL MINDORO'];
    var ORI_MUN = MUNICIPALITIES_BY_PROVINCE['ORIENTAL MINDORO'];
    var ALL_MUN = OCC_MUN.concat(ORI_MUN);
    var munCounts = {}; ALL_MUN.forEach(function(m){ munCounts[m] = 0; });
    var noMunCount = 0, outsideMindoroCount = 0;
    records.forEach(function(r){
      if (r.addressProvince === 'OUTSIDE MINDORO'){ outsideMindoroCount++; return; }
      var m = r.addressMunicipality || '';
      if (m && munCounts[m] !== undefined) munCounts[m]++;
      else if (m) munCounts[m] = 1;
      else noMunCount++;
    });
    // Top 3 municipalities
    var topMun = ALL_MUN.slice().sort(function(a,b){ return (munCounts[b]||0)-(munCounts[a]||0); }).slice(0,3).filter(function(m){ return (munCounts[m]||0) > 0; });

    // ── ADDRESS AREAS (MAPSA / SAMARICA) ─────────────────────
    var mapsaCount = 0, samaricaCount = 0;
    records.forEach(function(r){
      var area = classifyAddressArea(r);
      if (area === 'MAPSA') mapsaCount++;
      else if (area === 'SAMARICA') samaricaCount++;
    });

    // ── REFERRING UNITS ──────────────────────────────────────
    var KNOWN_UNITS = ['102nd SAC','1st Infantry "Always First" Battalion','1st OMPMFC','203rd Infantry "Bantay Kapayapaan" Brigade','23MICO','2CMO Battalion','2nd OMPMFC','402nd B MC RMFB 4B','405th B MC RMFB 4B','4th Infantry "Scorpion" Battalion','68th Infantry "Kaagapay" Battalion','76th Infantry "Victrix" Battalion','ISAFP','PIU','PIT Occidental Mindoro RIU 4B','OTHERS'];
    var unitCounts = {}; KNOWN_UNITS.forEach(function(u){ unitCounts[u] = 0; }); var noUnitCount = 0;
    records.forEach(function(r){
      var u = r.referringUnit || '';
      if (!u){ noUnitCount++; return; }
      var k = u.indexOf('OTHERS') === 0 ? 'OTHERS' : u;
      if (unitCounts[k] !== undefined) unitCounts[k]++;
      else noUnitCount++;
    });
    var topUnits = KNOWN_UNITS.slice().sort(function(a,b){ return unitCounts[b]-unitCounts[a]; }).slice(0,3).filter(function(u){ return unitCounts[u] > 0; });

    // ── SURRENDER BY YEAR ────────────────────────────────────
    var START_YEAR = 2016, thisYear = new Date().getFullYear();
    var yrCounts = {}; for (var yy = START_YEAR; yy <= thisYear; yy++) yrCounts[yy] = 0;
    var noDateCount = 0;
    records.forEach(function(r){
      if (!r.dateSurrendered){ noDateCount++; return; }
      var yr = new Date(r.dateSurrendered).getFullYear();
      if (yrCounts[yr] !== undefined) yrCounts[yr]++;
      else yrCounts[yr] = 1;
    });
    var peakYear = START_YEAR, peakYearCount = 0;
    for (var yy2 = START_YEAR; yy2 <= thisYear; yy2++) {
      if ((yrCounts[yy2]||0) > peakYearCount){ peakYearCount = yrCounts[yy2]; peakYear = yy2; }
    }

    // ── PENDING CASE ─────────────────────────────────────────
    var pendingYes = records.filter(function(r){ return r.pendingCase === 'YES'; }).length;

    // ── HELPERS ──────────────────────────────────────────────
    function articleNum(n) {
      // "a"/"an" for leading digit
      var s = String(n); return /^[18]/.test(s) ? 'an' : 'a';
    }
    function pluralRecords(n) { return n === 1 ? 'record' : 'records'; }

    // ── STAT BOXES ───────────────────────────────────────────
    function statBox(num, label, cls) {
      return '<div class="stat-box' + (cls ? ' ' + cls : '') + '"><span class="num">' + fmt(num) + '</span><span class="lbl">' + label + '</span></div>';
    }

    // ── TABLE BUILDER ────────────────────────────────────────
    function buildTable(headers, rows) {
      var th = headers.map(function(h, i){ return '<th' + (i > 0 ? ' class="num"':'') + '>' + h + '</th>'; }).join('');
      var tr = rows.map(function(row){
        return '<tr>' + row.map(function(c, i){ return '<td' + (i > 0 ? ' class="num"' : '') + '>' + c + '</td>'; }).join('') + '</tr>';
      }).join('');
      return '<table><thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table>';
    }

    // ══════════════════════════════════════════════════════════
    // BUILD THE NARRATIVE HTML
    // ══════════════════════════════════════════════════════════

    // ── 1. EXECUTIVE SUMMARY ─────────────────────────────────
    var topUnitText = topUnits.length
      ? topUnits.map(function(u){ return u + ' (' + unitCounts[u] + ')'; }).join(', ')
      : 'no referring unit recorded';

    var ipPctText   = withTribal > 0 ? pct(ipCount) + '%' : 'an unspecified percentage';
    var eclipPctText = pct(withEclip) + '%';
    var japicPctText = pct(withJapic) + '%';

    var execSummary =
      '<p>As of <span class="highlight">' + reportDate + '</span>, the Former Rebel Database Management and JAPIC Repository System ' +
      'of the Province of Occidental Mindoro maintains a total of <span class="highlight">' + fmt(total) + ' registered former rebel (FR) ' +
      pluralRecords(total) + '</span>. ' +
      'Of these, <span class="highlight">' + fmt(male) + '</span> (' + pct(male) + '%) are male and <span class="highlight">' + fmt(female) + '</span> (' + pct(female) + '%) are female. ' +
      'The majority of registrants (' + pct(activeCount) + '%) remain active in the reintegration program, while ' +
      fmt(cannotLocate) + ' (' + pct(cannotLocate) + '%) cannot be located, ' +
      fmt(deceased) + ' (' + pct(deceased) + '%) are deceased, and ' +
      fmt(incarcerated) + ' (' + pct(incarcerated) + '%) are currently incarcerated.</p>';

    // ── 2. MEMBERSHIP PROFILE ────────────────────────────────
    var memberPara =
      '<p>In terms of movement classification, <span class="highlight">' + fmt(regularNpa) + '</span> registrants (' + pct(regularNpa) + '%) were identified as <span class="highlight">Regular NPA</span> members, ' +
      'while <span class="highlight">' + fmt(milisyang) + '</span> (' + pct(milisyang) + '%) belonged to the <span class="highlight">Milisyang Bayan</span>. ' +
      (noMemType > 0 ? 'The remaining ' + fmt(noMemType) + ' (' + pct(noMemType) + '%) have no membership type specified in the system.' : 'All records have a membership type on file.') + ' ' +
      (pendingYes > 0
        ? fmt(pendingYes) + ' (' + pct(pendingYes) + '%) of the registrants have a pending legal case.'
        : 'No pending cases are recorded among the current registrants.') +
      '</p>';

    // ── 3. REFERRING UNITS ───────────────────────────────────
    var unitPara;
    if (topUnits.length) {
      unitPara = '<p>Former rebels were referred to the system primarily by ' + topUnitText + '. ' +
        (noUnitCount > 0 ? fmt(noUnitCount) + ' (' + pct(noUnitCount) + '%) of the registrants have no referring unit on record.' : 'All registrants have a referring unit on file.') + '</p>';
    } else {
      unitPara = '<p>Referring unit information is not yet fully populated in the database.</p>';
    }

    // ── 4. GEOGRAPHIC DISTRIBUTION ───────────────────────────
    var munTopText = topMun.length
      ? topMun.map(function(m){ return m + ' (' + (munCounts[m]||0) + ')'; }).join(', ')
      : 'not yet recorded';

    var geoPara =
      '<p>Geographically, most registrants reside within Occidental Mindoro. ' +
      'The top municipalities by number of registrants are <span class="highlight">' + munTopText + '</span>. ' +
      (mapsaCount > 0 ? fmt(mapsaCount) + ' (' + pct(mapsaCount) + '%) are from the <span class="highlight">MAPSA area</span> (Mamburao, Abra de Ilog, Paluan, Sablayan, Sta. Cruz) ' : '') +
      (samaricaCount > 0 ? 'and ' + fmt(samaricaCount) + ' (' + pct(samaricaCount) + '%) from the <span class="highlight">SAMARICA area</span> (San Jose, Magsaysay, Rizal, Calintaan). ' : '') +
      (outsideMindoroCount > 0 ? fmt(outsideMindoroCount) + ' (' + pct(outsideMindoroCount) + '%) are from outside Mindoro. ' : '') +
      (noMunCount > 0 ? fmt(noMunCount) + ' (' + pct(noMunCount) + '%) have no municipality recorded.' : '') +
      '</p>';

    // ── 5. TRIBAL GROUP ──────────────────────────────────────
    var tribalPara;
    var largestTribal = TRIBAL_TYPES.filter(function(t){ return t !== 'NO TRIBAL GROUP'; })
      .sort(function(a,b){ return tribalCounts[b]-tribalCounts[a]; })[0];
    tribalPara =
      '<p>Regarding ethnicity, <span class="highlight">' + fmt(ipCount) + '</span> (' + ipPctText + ') of all registrants belong to an <span class="highlight">Indigenous People (IP) tribal group</span>, ' +
      'while <span class="highlight">' + fmt(nonIpCount) + '</span> (' + pct(nonIpCount) + '%) have no tribal affiliation. ' +
      (noTribalData > 0 ? fmt(noTribalData) + ' (' + pct(noTribalData) + '%) have no tribal group data on file. ' : '') +
      (largestTribal && tribalCounts[largestTribal] > 0
        ? 'The largest IP group is the <span class="highlight">' + largestTribal + '</span> with ' + fmt(tribalCounts[largestTribal]) + ' (' + pct(tribalCounts[largestTribal]) + '%) registrants.'
        : '') +
      '</p>';

    // ── 6. AGE DISTRIBUTION ──────────────────────────────────
    var agePara;
    var noAgeCount = total - withAge;
    agePara =
      '<p>Age data is available for <span class="highlight">' + fmt(withAge) + '</span> out of ' + fmt(total) + ' registrants. ' +
      'The most populous age bracket is <span class="highlight">' + BRACKETS[peakAgeIdx].label + '</span>, ' +
      'accounting for ' + fmt(ageCounts[peakAgeIdx]) + ' (' + (withAge > 0 ? ((ageCounts[peakAgeIdx]/withAge)*100).toFixed(1) : '0.0') + '%) of those with recorded ages. ' +
      (noAgeCount > 0 ? fmt(noAgeCount) + ' registrant' + (noAgeCount===1?'':' records') + ' have no date of birth on file.' : 'All registrants have a date of birth on file.') +
      '</p>';

    // ── 7. 4Ps BENEFICIARIES ─────────────────────────────────
    var fourPsPara =
      '<p>On the Pantawid Pamilyang Pilipino Program (4Ps) front, <span class="highlight">' + fmt(fourPsYes) + '</span> (' + pct(fourPsYes) + '%) of registrants are 4Ps beneficiaries, ' +
      'while <span class="highlight">' + fmt(fourPsNo) + '</span> (' + pct(fourPsNo) + '%) are not. ' +
      (fourPsNone > 0 ? 'The 4Ps status of ' + fmt(fourPsNone) + ' (' + pct(fourPsNone) + '%) registrants is not yet recorded.' : '') +
      '</p>';

    // ── 8. SECTOR BREAKDOWN ──────────────────────────────────
    var sectorPara =
      '<p>In terms of sector classification, the most represented groups among registrants are ' +
      topSectors.map(function(s){ return '<span class="highlight">' + s + '</span> (' + fmt(secCounts[s]) + ')'; }).join(', ') +
      '. This reflects the predominantly rural and agricultural background of the FR population in the province.</p>';

    // ── 9. REINTEGRATION & ASSISTANCE ────────────────────────
    var asstLed = ASST_TYPES.filter(function(t){ return t !== 'NOT QUALIFIED FOR E-CLIP'; })
      .sort(function(a,b){ return asstCounts[b]-asstCounts[a]; });
    var topAsst = asstLed.slice(0,3).filter(function(t){ return asstCounts[t] > 0; });

    var asstPara =
      '<p>A total of <span class="highlight">' + fmt(totalBeneficiaries) + '</span> (' + pct(totalBeneficiaries) + '%) registrants have received at least one form of government assistance. ' +
      (topAsst.length
        ? 'The top assistance programs rendered are: ' + topAsst.map(function(t){ return '<span class="highlight">' + t + '</span> (' + asstCounts[t] + ')'; }).join(', ') + '. '
        : '') +
      '<span class="highlight">' + fmt(withEclip) + '</span> (' + eclipPctText + '%) have received <span class="highlight">E-CLIP</span> benefits, ' +
      fmt(notQualEclip) + ' (' + pct(notQualEclip) + '%) are marked as not qualified for E-CLIP, and ' +
      '<span class="highlight">' + fmt(noEclipCount) + '</span> (' + pct(noEclipCount) + '%) have yet to be assessed or processed for E-CLIP. ' +
      (noAssistanceNarr > 0
        ? '<span class="highlight">' + fmt(noAssistanceNarr) + '</span> (' + pct(noAssistanceNarr) + '%) registrants have <span class="highlight">no assistance of any kind on record</span> and require immediate follow-up.'
        : 'All registrants have at least one assistance type recorded.') +
      '</p>';

    // ── 10. JAPIC STATUS ─────────────────────────────────────
    var japicPara =
      '<p>Regarding the Joint AFP-PNP Intelligence Committee (JAPIC) Certificate, <span class="highlight">' + fmt(withJapic) + '</span> (' + japicPctText + '%) of registrants have a JAPIC certificate on file. ' +
      '<span class="highlight">' + fmt(noJapic) + '</span> (' + pct(noJapic) + '%) still lack a JAPIC certificate in the repository, requiring follow-up from the respective referring units.</p>';

    // ── 11. SURRENDER TIMELINE ───────────────────────────────
    var yrPara;
    var recentThreeYrs = [];
    for (var yy3 = thisYear; yy3 >= Math.max(START_YEAR, thisYear-2); yy3--) recentThreeYrs.push(yy3);
    var recentText = recentThreeYrs.filter(function(y){ return (yrCounts[y]||0) > 0; })
      .map(function(y){ return y + ' (' + (yrCounts[y]||0) + ')'; }).join(', ');

    yrPara =
      '<p>Surrender records span from ' + START_YEAR + ' to ' + thisYear + '. ' +
      'The year with the highest number of surrenderees on record is <span class="highlight">' + peakYear + '</span> with <span class="highlight">' + fmt(peakYearCount) + '</span> (' + pct(peakYearCount) + '%) registrants. ' +
      (recentText ? 'In the most recent years, the surrender figures are: ' + recentText + '. ' : '') +
      (noDateCount > 0 ? fmt(noDateCount) + ' (' + pct(noDateCount) + '%) registrants have no surrender date recorded.' : 'All registrants have a surrender date on file.') +
      '</p>';

    // ── 12. DATA QUALITY ─────────────────────────────────────
    var dataPara =
      '<p>Data completeness review shows that <span class="highlight">' + fmt(incomplete) + '</span> (' + pct(incomplete) + '%) of all profiles are missing one or more required fields. ' +
      'Immediate data clean-up is recommended for these records to ensure accurate reporting and eligibility assessment.</p>';

    // ══════════════════════════════════════════════════════════
    // SUMMARY TABLES
    // ══════════════════════════════════════════════════════════

    // Stat boxes row
    var statBoxRow =
      '<div class="stat-row">' +
        statBox(total,        'TOTAL RECORDS') +
        statBox(male,         'MALE') +
        statBox(female,       'FEMALE') +
        statBox(regularNpa,   'REGULAR NPA') +
        statBox(milisyang,    'MILISYANG BAYAN') +
        statBox(withEclip,    'WITH E-CLIP') +
        statBox(withJapic,    'JAPIC ON FILE') +
        statBox(totalBeneficiaries, 'WITH ASSISTANCE') +
        statBox(noAssistanceNarr,   'NO ASSISTANCE', 'warn') +
      '</div>' +
      '<div class="stat-row">' +
        statBox(activeCount,    'ACTIVE') +
        statBox(cannotLocate,   'CANNOT BE LOCATED',  'warn') +
        statBox(deceased,       'DECEASED',            'danger') +
        statBox(incarcerated,   'INCARCERATED',        'purple') +
        statBox(noEclipCount,   'NO E-CLIP',           'warn') +
        statBox(noJapic,        'NO JAPIC',            'warn') +
        statBox(incomplete,     'INCOMPLETE DATA',     'danger') +
        statBox(pendingYes,     'PENDING CASE',        'warn') +
      '</div>';

    // Assistance table
    var asstTableRows = ASST_TYPES.map(function(t){
      return [t, fmt(asstCounts[t]), pct(asstCounts[t]) + '%'];
    });
    var asstTable = buildTable(['TYPE OF ASSISTANCE','COUNT','% OF TOTAL'], asstTableRows);

    // Membership table
    var memTable = buildTable(['MEMBERSHIP TYPE','COUNT','% OF TOTAL'], [
      ['REGULAR NPA',    fmt(regularNpa),  pct(regularNpa)  + '%'],
      ['MILISYANG BAYAN',fmt(milisyang),   pct(milisyang)   + '%'],
      ['NOT SPECIFIED',  fmt(noMemType),   pct(noMemType)   + '%'],
      ['TOTAL',          fmt(total),       '100%']
    ]);

    // Tribal table
    var tribalTableRows = TRIBAL_TYPES.map(function(t){
      return [t, fmt(tribalCounts[t]), pct(tribalCounts[t]) + '%'];
    });
    if (noTribalData > 0) tribalTableRows.push(['NOT SPECIFIED', fmt(noTribalData), pct(noTribalData) + '%']);
    var tribalTable = buildTable(['TRIBAL GROUP','COUNT','% OF TOTAL'], tribalTableRows);

    // Age table
    var ageTableRows = BRACKETS.map(function(b, i){
      return [b.label, fmt(ageCounts[i]), pct(ageCounts[i]) + '%'];
    });
    if (total - withAge > 0) ageTableRows.push(['NO AGE DATA', fmt(total - withAge), pct(total - withAge) + '%']);
    var ageTable = buildTable(['AGE BRACKET','COUNT','% OF TOTAL'], ageTableRows);

    // Sector table
    var sectorTableRows = SECTORS.map(function(s){ return [s, fmt(secCounts[s]), pct(secCounts[s]) + '%']; });
    var sectorTable = buildTable(['SECTOR','COUNT','% OF TOTAL'], sectorTableRows);

    // Municipality table (top Occidental Mindoro only for brevity in narrative)
    var munTableRows = OCC_MUN.concat(ORI_MUN).map(function(m){
      return [m, fmt(munCounts[m]||0), pct(munCounts[m]||0) + '%'];
    });
    if (outsideMindoroCount > 0) munTableRows.push(['OUTSIDE MINDORO', fmt(outsideMindoroCount), pct(outsideMindoroCount) + '%']);
    if (noMunCount > 0) munTableRows.push(['NOT SPECIFIED', fmt(noMunCount), pct(noMunCount) + '%']);
    var munTable = buildTable(['MUNICIPALITY','COUNT','% OF TOTAL'], munTableRows);

    // Year table
    var yrTableRows = [];
    for (var yy4 = START_YEAR; yy4 <= thisYear; yy4++) {
      yrTableRows.push([yy4, fmt(yrCounts[yy4]||0), pct(yrCounts[yy4]||0) + '%']);
    }
    if (noDateCount > 0) yrTableRows.push(['NO DATE RECORDED', fmt(noDateCount), pct(noDateCount) + '%']);
    var yrTable = buildTable(['YEAR','COUNT','% OF TOTAL'], yrTableRows);

    // Unit table
    var unitTableRows = KNOWN_UNITS.filter(function(u){ return unitCounts[u] > 0; }).map(function(u){
      return [u, fmt(unitCounts[u]), pct(unitCounts[u]) + '%'];
    });
    if (noUnitCount > 0) unitTableRows.push(['NOT SPECIFIED', fmt(noUnitCount), pct(noUnitCount) + '%']);
    var unitTable = buildTable(['REFERRING UNIT','COUNT','% OF TOTAL'], unitTableRows);

    // ══════════════════════════════════════════════════════════
    // ASSEMBLE BODY
    // ══════════════════════════════════════════════════════════
    var body =
      '<h1>FORMER REBEL DATABASE MANAGEMENT AND JAPIC REPOSITORY SYSTEM</h1>' +
      '<p class="sub-title">PROVINCE OF OCCIDENTAL MINDORO</p>' +
      '<p class="sub-title">NARRATIVE DASHBOARD SUMMARY REPORT</p>' +
      '<p class="meta">Date of Report: ' + reportDate + ' &nbsp;|&nbsp; Generated by: ' + printedBy + ' &nbsp;|&nbsp; Printed: ' + printed + '</p>' +
      '<hr/>' +

      '<h2>I. EXECUTIVE SUMMARY</h2>' +
      execSummary + statBoxRow +

      '<h2>II. MEMBERSHIP PROFILE</h2>' +
      memberPara + memTable +

      '<h2>III. REFERRING UNITS</h2>' +
      unitPara + unitTable +

      '<h2>IV. SURRENDER TIMELINE</h2>' +
      yrPara + yrTable +

      '<h2>V. GEOGRAPHIC DISTRIBUTION</h2>' +
      geoPara + munTable +

      '<h2>VI. TRIBAL GROUP / ETHNICITY</h2>' +
      tribalPara + tribalTable +

      '<h2>VII. AGE DISTRIBUTION</h2>' +
      agePara + ageTable +

      '<h2>VIII. SECTOR CLASSIFICATION</h2>' +
      sectorPara + sectorTable +

      '<h2>IX. 4Ps BENEFICIARIES</h2>' +
      fourPsPara +

      '<h2>X. REINTEGRATION AND ASSISTANCE</h2>' +
      asstPara + asstTable +

      '<h2>XI. JAPIC CERTIFICATE STATUS</h2>' +
      japicPara +

      '<h2>XII. DATA QUALITY</h2>' +
      dataPara +

      '<div class="footer">' +
        'This report was system-generated from the FR Database Management and JAPIC Repository System. &nbsp;|&nbsp; ' +
        'CONFIDENTIAL &mdash; FOR AUTHORIZED PERSONNEL ONLY &nbsp;|&nbsp; PSWDO &bull; Province of Occidental Mindoro' +
      '</div>';

    if (mode === 'download') {
      // Build the full self-contained HTML string (same for both paths)
      var styles   = NARRATIVE_REPORT_STYLES + CONFIDENTIAL_WATERMARK_STYLE;
      var fullHtml =
        '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<title>FR Narrative Report</title>' +
        '<style>' + styles + '</style></head>' +
        '<body><div class="confidential-watermark">CONFIDENTIAL</div>' +
        body +
        '</body></html>';

      if (window.electronAPI && window.electronAPI.printNarrativePDF) {
        // ── Electron path: use printToPDF via IPC → native Save dialog ──
        showToast('PREPARING PDF...', 'info');
        window.electronAPI.printNarrativePDF(fullHtml)
          .then(function(result) {
            if (result && result.success) {
              showToast('NARRATIVE REPORT SAVED AS PDF', 'success');
            } else if (result && result.reason === 'cancelled') {
              showToast('PDF SAVE CANCELLED', 'info');
            } else {
              showToast('PDF ERROR: ' + (result ? result.reason : 'UNKNOWN'), 'error');
            }
          })
          .catch(function(err) {
            showToast('PDF ERROR: ' + err.message, 'error');
          });
      } else {
        // ── Browser fallback: download as .html ──────────────────────────
        var blob    = new Blob([fullHtml], { type: 'text/html' });
        var url     = URL.createObjectURL(blob);
        var a       = document.createElement('a');
        a.href      = url;
        a.download  = 'FR_NARRATIVE_REPORT_' + new Date().toISOString().slice(0, 10) + '.html';
        a.click();
        setTimeout(function() { URL.revokeObjectURL(url); }, 3000);
        showToast('NARRATIVE REPORT DOWNLOADED (HTML)', 'success');
      }
    } else {
      openPrintDocument('FR Narrative Dashboard Report', body, NARRATIVE_REPORT_STYLES + CONFIDENTIAL_WATERMARK_STYLE);
      showToast('NARRATIVE REPORT GENERATED', 'success');
    }
}

function generateNarrativeReport() {
  if (allRecordsCache.length) _runNarrative(allRecordsCache, 'print');
  else dbGetAll().then(function(records){ allRecordsCache = records; _runNarrative(records, 'print'); })
    .catch(function(err){ showToast('ERROR: ' + err.message, 'error'); });
}

function downloadNarrativeReport() {
  if (allRecordsCache.length) _runNarrative(allRecordsCache, 'download');
  else dbGetAll().then(function(records){ allRecordsCache = records; _runNarrative(records, 'download'); })
    .catch(function(err){ showToast('ERROR: ' + err.message, 'error'); });
}

// -- POWERPOINT REPORT GENERATOR (EXECUTIVE SUMMARY BASED) ---
function generatePptxReport() {
  function run(records) {
    if (!records.length) { showToast('NO RECORDS TO GENERATE PPTX', 'info'); return; }
    showToast('GENERATING PRESENTATION...', 'info');

    // ── Reuse the exact same stat computations as _runNarrative ──
    var total        = records.length;
    var male         = records.filter(function(r){ return r.sex==='MALE'; }).length;
    var female       = records.filter(function(r){ return r.sex==='FEMALE'; }).length;
    var regularNpa   = records.filter(function(r){ return r.membershipType==='REGULAR NPA'; }).length;
    var milisyang    = records.filter(function(r){ return r.membershipType==='MILISYANG BAYAN'; }).length;
    var noMemType    = total - regularNpa - milisyang;
    var cannotLocate = records.filter(function(r){ return r.recordStatus==='CANNOT BE LOCATED'; }).length;
    var deceased     = records.filter(function(r){ return r.recordStatus==='DECEASED'; }).length;
    var incarcerated = records.filter(function(r){ return r.recordStatus==='INCARCERATED'; }).length;
    var activeCount  = total - cannotLocate - deceased - incarcerated;
    var withJapic    = records.filter(function(r){ return r.japic&&(r.japic.url||r.japic.dataUrl||r.japic.fileName); }).length;
    var noJapic      = total - withJapic;
    var withEclip    = records.filter(function(r){ return (r.assistance||[]).indexOf('E-CLIP')!==-1; }).length;
    var notQualEclip = records.filter(function(r){ return (r.assistance||[]).indexOf('NOT QUALIFIED FOR E-CLIP')!==-1; }).length;
    var noEclipCount = records.filter(function(r){ var a=r.assistance||[]; return a.indexOf('E-CLIP')===-1&&a.indexOf('NOT QUALIFIED FOR E-CLIP')===-1; }).length;
    var noAssist     = records.filter(function(r){ return !r.assistance||r.assistance.length===0; }).length;
    var withPhil     = records.filter(function(r){ return (r.assistance||[]).indexOf('PHILHEALTH')!==-1; }).length;
    var fourPsYes    = records.filter(function(r){ return r.fourPs==='YES'; }).length;
    var fourPsNo     = records.filter(function(r){ return r.fourPs==='NO'; }).length;
    var fourPsNone   = total - fourPsYes - fourPsNo;
    var pendingYes   = records.filter(function(r){ return r.pendingCase==='YES'; }).length;
    var incomplete   = records.filter(function(r){ return getMissingFieldsGlobal(r).length>0; }).length;
    var totalBenef   = records.filter(function(r){ return r.assistance&&r.assistance.length>0; }).length;

    function pct(n){ return total>0?((n/total)*100).toFixed(1):'0.0'; }
    function fmt(n){ return Number(n).toLocaleString(); }

    var reportDate  = new Date().toLocaleDateString('en-PH',{year:'numeric',month:'long',day:'numeric'});
    var generatedBy = currentUser ? currentUser.username+' ('+currentUser.role+')' : 'UNKNOWN';

    // ── Assistance ───────────────────────────────────────────
    var ASST_TYPES = ['E-CLIP','NOT QUALIFIED FOR E-CLIP','FEA REMUNERATION','LIVELIHOOD',
      'MEDICAL','EDUCATIONAL','ISSUANCE OF CREDENTIALS','PHILHEALTH',
      'ISSUANCE OF SAFE CONDUCT PASS','APPLIED FOR AMNESTY','OTHERS'];
    var asstCounts = {}; ASST_TYPES.forEach(function(t){ asstCounts[t]=0; });
    records.forEach(function(r){
      (r.assistance||[]).forEach(function(a){
        var k=a.indexOf('OTHERS')===0?'OTHERS':a; if(asstCounts[k]!==undefined)asstCounts[k]++;
      });
    });
    var topAsst = ASST_TYPES.filter(function(t){ return t!=='NOT QUALIFIED FOR E-CLIP'; })
      .sort(function(a,b){ return asstCounts[b]-asstCounts[a]; }).slice(0,3)
      .filter(function(t){ return asstCounts[t]>0; });

    // ── Tribal ───────────────────────────────────────────────
    var TRIBAL_TYPES = TRIBAL_GROUP_TYPES.slice();
    var tribalCounts = {}; TRIBAL_TYPES.forEach(function(t){ tribalCounts[t]=0; });
    records.forEach(function(r){ var k=normalizeTribalGroup(r.tribalGroup); if(k&&tribalCounts[k]!==undefined)tribalCounts[k]++; });
    var withTribal  = TRIBAL_TYPES.reduce(function(s,t){ return s+tribalCounts[t]; },0);
    var ipCount     = TRIBAL_TYPES.filter(function(t){ return t!=='NO TRIBAL GROUP'; }).reduce(function(s,t){ return s+tribalCounts[t]; },0);
    var nonIpCount  = tribalCounts['NO TRIBAL GROUP'];
    var noTribalData= total - withTribal;
    var largestTribal = TRIBAL_TYPES.filter(function(t){ return t!=='NO TRIBAL GROUP'; })
      .sort(function(a,b){ return tribalCounts[b]-tribalCounts[a]; })[0];

    // ── Age ──────────────────────────────────────────────────
    var BRACKETS=[{label:'18 & BELOW',min:0,max:18},{label:'19-24',min:19,max:24},
      {label:'25-30',min:25,max:30},{label:'31-40',min:31,max:40},
      {label:'41-59',min:41,max:59},{label:'60 & ABOVE',min:60,max:999}];
    var ageCounts=BRACKETS.map(function(){ return 0; }), withAge=0;
    records.forEach(function(r){
      var age=parseInt(calcAgeFromDob(r.dob)); if(isNaN(age))return; withAge++;
      for(var i=0;i<BRACKETS.length;i++){ if(age>=BRACKETS[i].min&&age<=BRACKETS[i].max){ageCounts[i]++;break;} }
    });
    var peakAgeIdx = ageCounts.indexOf(Math.max.apply(null,ageCounts));
    var noAgeCount = total - withAge;

    // ── Sectors ──────────────────────────────────────────────
    var SECTORS=['FARMER','FISHERFOLK','WOMEN','PWD','CHILDREN AND YOUTH',
      'SENIOR CITIZEN','SOLO PARENT','INDIGENOUS PEOPLE','URBAN POOR','OTHERS'];
    var secCounts={}; SECTORS.forEach(function(s){ secCounts[s]=0; });
    records.forEach(function(r){
      (r.sector||[]).forEach(function(s){
        if(s==='FARMER/FISHERFOLK'){secCounts['FARMER']++;secCounts['FISHERFOLK']++;return;}
        var k=s.indexOf('OTHERS')===0?'OTHERS':s; if(secCounts[k]!==undefined)secCounts[k]++;
      });
    });
    var topSectors = SECTORS.slice().sort(function(a,b){ return secCounts[b]-secCounts[a]; }).slice(0,3);

    // ── Municipality ─────────────────────────────────────────
    var munCounts={}, noMunCount=0, outsideMindoroCount=0, mapsaCount=0, samaricaCount=0;
    records.forEach(function(r){
      if(r.addressProvince==='OUTSIDE MINDORO'){outsideMindoroCount++;return;}
      var m=r.addressMunicipality||'';
      if(m) munCounts[m]=(munCounts[m]||0)+1; else noMunCount++;
      var area=classifyAddressArea(r);
      if(area==='MAPSA')mapsaCount++; else if(area==='SAMARICA')samaricaCount++;
    });
    var topMun = Object.keys(munCounts).sort(function(a,b){ return munCounts[b]-munCounts[a]; }).slice(0,3);

    // ── Units ────────────────────────────────────────────────
    var unitCounts={}, noUnitCount=0;
    records.forEach(function(r){
      var u=r.referringUnit||''; if(!u){noUnitCount++;return;}
      var k=u.indexOf('OTHERS')===0?'OTHERS':u; unitCounts[k]=(unitCounts[k]||0)+1;
    });
    var topUnits = Object.keys(unitCounts).sort(function(a,b){ return unitCounts[b]-unitCounts[a]; }).slice(0,3);

    // ── Surrender timeline ───────────────────────────────────
    var START_YEAR=2016, thisYear=new Date().getFullYear();
    var yrCounts={}, noDateCount=0, peakYear=START_YEAR, peakYearCount=0;
    for(var yy=START_YEAR;yy<=thisYear;yy++) yrCounts[yy]=0;
    records.forEach(function(r){
      if(!r.dateSurrendered){noDateCount++;return;}
      var yr=new Date(r.dateSurrendered).getFullYear(); yrCounts[yr]=(yrCounts[yr]||0)+1;
    });
    for(var yy2=START_YEAR;yy2<=thisYear;yy2++){
      if((yrCounts[yy2]||0)>peakYearCount){peakYearCount=yrCounts[yy2];peakYear=yy2;}
    }
    var recentYrs=[];
    for(var yy3=thisYear;yy3>=Math.max(START_YEAR,thisYear-2);yy3--) recentYrs.push(yy3);
    var recentText=recentYrs.filter(function(y){return(yrCounts[y]||0)>0;})
      .map(function(y){return y+' ('+( yrCounts[y]||0)+')';}).join(', ');

    // ══════════════════════════════════════════════════════════
    // PptxGenJS setup
    // ══════════════════════════════════════════════════════════
    var pptx         = new PptxGenJS();
    pptx.layout      = 'LAYOUT_WIDE';   // 13.33" × 7.5"
    pptx.author      = 'FRDB System';
    pptx.title       = 'FR Dashboard Executive Summary';
    pptx.subject     = 'Former Rebel Database — Executive Summary Report';

    // ── Design tokens ────────────────────────────────────────
    var C = {
      bg:     '0D1117', card:   '161B22', accent: '1F6FEB',
      text:   'E6EDF3', sub:    '8B949E', border: '30363D',
      green:  '3FB950', red:    'F85149', yell:   'D29922',
      purp:   'A371F7', dim:    '21262D', stripe: '0D2340'
    };
    var FONT = 'Segoe UI';

    // ── Shared helpers ───────────────────────────────────────
    function bg(slide){ slide.background = { fill: C.bg }; }

    function header(slide, sectionNum, title) {
      // Left accent stripe
      slide.addShape(pptx.ShapeType.rect,
        { x:0, y:0, w:0.08, h:7.5, fill:{ color:C.accent } });
      // Section number pill
      slide.addShape(pptx.ShapeType.roundRect,
        { x:0.22, y:0.2, w:0.5, h:0.5, fill:{ color:C.accent }, rectRadius:0.06 });
      slide.addText(String(sectionNum),
        { x:0.22, y:0.2, w:0.5, h:0.5, fontSize:16, bold:true, color:C.text, fontFace:FONT, align:'center', valign:'middle' });
      // Title
      slide.addText(title,
        { x:0.88, y:0.22, w:12.2, h:0.46, fontSize:20, bold:true, color:C.text, fontFace:FONT, charSpacing:1.5, valign:'middle' });
      // Divider
      slide.addShape(pptx.ShapeType.line,
        { x:0.22, y:0.76, w:12.9, h:0, line:{ color:C.border, width:1 } });
    }

    function footer(slide, n) {
      slide.addShape(pptx.ShapeType.rect,
        { x:0, y:7.32, w:13.33, h:0.18, fill:{ color:C.dim } });
      slide.addText(
        'FRDB — PROVINCE OF OCCIDENTAL MINDORO  |  CONFIDENTIAL  |  '+reportDate+'  |  '+generatedBy,
        { x:0.22, y:7.33, w:12.5, h:0.16, fontSize:5.5, color:'6E7681', fontFace:FONT });
      slide.addText(String(n)+' / 14',
        { x:12.8, y:7.33, w:0.4, h:0.16, fontSize:5.5, color:'6E7681', fontFace:FONT, align:'right' });
    }

    // Stat box — coloured number + label
    function stat(slide, x, y, w, h, val, lbl, col) {
      slide.addShape(pptx.ShapeType.roundRect,
        { x:x, y:y, w:w, h:h, fill:{ color:C.card }, line:{ color:C.border, width:0.75 }, rectRadius:0.07 });
      slide.addText(String(val),
        { x:x, y:y+0.04, w:w, h:h*0.55, fontSize:Math.min(30, Math.max(18, 26-String(val).length*1.5)),
          bold:true, color:col||C.accent, fontFace:FONT, align:'center', valign:'middle' });
      slide.addText(lbl,
        { x:x+0.04, y:y+h*0.58, w:w-0.08, h:h*0.38,
          fontSize:6.5, color:C.sub, fontFace:FONT, align:'center', charSpacing:0.5, wrap:true });
    }

    // Narrative text block (the "prose" from the executive summary)
    function prose(slide, x, y, w, h, text) {
      slide.addShape(pptx.ShapeType.roundRect,
        { x:x, y:y, w:w, h:h, fill:{ color:C.stripe }, line:{ color:C.accent, width:0.75 }, rectRadius:0.07 });
      slide.addText(text,
        { x:x+0.15, y:y+0.1, w:w-0.3, h:h-0.2,
          fontSize:10.5, color:C.text, fontFace:FONT, valign:'top',
          paraSpaceAfter:4, lineSpacingMultiple:1.3 });
    }

    // Horizontal mini-bar row
    function barRow(slide, x, y, w, label, value, maxVal, col) {
      var barMaxW = w - 2.2;
      var fillW   = maxVal > 0 ? Math.max((value/maxVal)*barMaxW, value>0?0.05:0) : 0;
      slide.addText(label,
        { x:x, y:y, w:1.6, h:0.28, fontSize:7.5, color:C.sub, fontFace:FONT, align:'right', valign:'middle' });
      slide.addShape(pptx.ShapeType.roundRect,
        { x:x+1.65, y:y+0.04, w:barMaxW, h:0.2, fill:{ color:C.dim }, line:{ color:C.border, width:0.5 }, rectRadius:0.03 });
      if(fillW > 0) {
        slide.addShape(pptx.ShapeType.roundRect,
          { x:x+1.65, y:y+0.04, w:fillW, h:0.2, fill:{ color:col||C.accent }, line:{ color:col||C.accent, width:0 }, rectRadius:0.03 });
      }
      slide.addText(String(value)+' ('+pct(value)+'%)',
        { x:x+1.65+fillW+0.06, y:y, w:0.7, h:0.28, fontSize:7, bold:true, color:col||C.accent, fontFace:FONT, valign:'middle' });
    }

    // Section label (small caps above a chart area)
    function sectionLabel(slide, x, y, txt) {
      slide.addText(txt,
        { x:x, y:y, w:12.5, h:0.25, fontSize:7.5, bold:true, color:C.sub, fontFace:FONT, charSpacing:2 });
    }

    // ══════════════════════════════════════════════════════════
    // SLIDE 1 — COVER
    // ══════════════════════════════════════════════════════════
    var sl = pptx.addSlide();
    sl.background = { fill: C.bg };
    sl.addShape(pptx.ShapeType.rect,  { x:0, y:0,    w:13.33, h:0.12, fill:{ color:C.accent } });
    sl.addShape(pptx.ShapeType.rect,  { x:0, y:0.12, w:0.08,  h:7.38, fill:{ color:C.accent } });
    sl.addText('FORMER REBEL DATABASE', { x:0.3, y:1.3,  w:12.8, h:0.9, fontSize:38, bold:true, color:C.text,   fontFace:FONT, align:'center', charSpacing:3 });
    sl.addText('Management and JAPIC Repository System', { x:0.3, y:2.1, w:12.8, h:0.45, fontSize:16, color:C.sub, fontFace:FONT, align:'center' });
    sl.addShape(pptx.ShapeType.rect,  { x:3.8, y:2.7, w:5.7, h:0.05, fill:{ color:C.accent } });
    sl.addText('EXECUTIVE SUMMARY REPORT', { x:0.3, y:2.85, w:12.8, h:0.45, fontSize:14, bold:true, color:C.accent, fontFace:FONT, align:'center', charSpacing:4 });
    sl.addText('Province of Occidental Mindoro', { x:0.3, y:3.4,  w:12.8, h:0.32, fontSize:11, color:C.sub, fontFace:FONT, align:'center', italic:true });
    sl.addText(String(total), { x:4.8, y:4.1, w:3.7, h:1.2, fontSize:80, bold:true, color:C.accent, fontFace:FONT, align:'center' });
    sl.addText('REGISTERED FORMER REBELS', { x:4.8, y:5.2, w:3.7, h:0.3, fontSize:9, color:C.sub, fontFace:FONT, align:'center', charSpacing:2 });
    sl.addText('As of '+reportDate+'  |  Generated by: '+generatedBy, { x:0.3, y:6.95, w:12.8, h:0.22, fontSize:8, color:'6E7681', fontFace:FONT, align:'center', italic:true });
    sl.addText('CONFIDENTIAL — FOR AUTHORIZED PERSONNEL ONLY', { x:0.3, y:7.22, w:12.8, h:0.18, fontSize:6.5, color:'6E7681', fontFace:FONT, align:'center', charSpacing:1 });

    // ══════════════════════════════════════════════════════════
    // SLIDE 2 — I. EXECUTIVE SUMMARY (overview)
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'I', 'EXECUTIVE SUMMARY');
    // Prose block
    var execText =
      'As of '+reportDate+', the FRDB maintains a total of '+fmt(total)+' registered former rebel records. '+
      fmt(male)+' ('+pct(male)+'%) are male and '+fmt(female)+' ('+pct(female)+'%) are female. '+
      'The majority ('+pct(activeCount)+'%) remain active in the reintegration program, while '+
      fmt(cannotLocate)+' ('+pct(cannotLocate)+'%) cannot be located, '+
      fmt(deceased)+' ('+pct(deceased)+'%) are deceased, and '+
      fmt(incarcerated)+' ('+pct(incarcerated)+'%) are incarcerated.';
    prose(sl, 0.22, 0.9, 13.0, 1.5, execText);
    // 8 key stat cards in two rows
    var cW=2.85, cH=1.3, cG=0.18, row1y=2.55, row2y=row1y+cH+0.14;
    stat(sl, 0.22,             row1y, cW, cH, total,       'TOTAL RECORDS',      C.accent);
    stat(sl, 0.22+cW+cG,       row1y, cW, cH, male,        'MALE',               '58A6FF');
    stat(sl, 0.22+(cW+cG)*2,   row1y, cW, cH, female,      'FEMALE',             'F778BA');
    stat(sl, 0.22+(cW+cG)*3,   row1y, cW, cH, activeCount, 'ACTIVE',             C.green);
    stat(sl, 0.22,             row2y, cW, cH, cannotLocate,'CANNOT BE LOCATED',  C.yell);
    stat(sl, 0.22+cW+cG,       row2y, cW, cH, deceased,    'DECEASED',           C.red);
    stat(sl, 0.22+(cW+cG)*2,   row2y, cW, cH, incarcerated,'INCARCERATED',       C.purp);
    stat(sl, 0.22+(cW+cG)*3,   row2y, cW, cH, pendingYes,  'PENDING CASE',       C.yell);
    footer(sl, 2);

    // ══════════════════════════════════════════════════════════
    // SLIDE 3 — II. MEMBERSHIP PROFILE
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'II', 'MEMBERSHIP PROFILE');
    var memText =
      fmt(regularNpa)+' ('+pct(regularNpa)+'%) were Regular NPA members and '+
      fmt(milisyang)+' ('+pct(milisyang)+'%) belonged to the Milisyang Bayan. '+
      (noMemType>0 ? 'The remaining '+fmt(noMemType)+' ('+pct(noMemType)+'%) have no membership type specified.' : 'All records have a membership type on file.')+' '+
      (pendingYes>0 ? fmt(pendingYes)+' ('+pct(pendingYes)+'%) have a pending legal case.' : 'No pending cases recorded.');
    prose(sl, 0.22, 0.9, 13.0, 1.3, memText);
    // Stat boxes
    stat(sl, 0.22,           2.35, 3.9, 1.6, regularNpa, 'REGULAR NPA',    C.red);
    stat(sl, 4.32,           2.35, 3.9, 1.6, milisyang,  'MILISYANG BAYAN',C.yell);
    stat(sl, 8.42,           2.35, 2.3, 1.6, noMemType,  'NOT SPECIFIED',  C.sub);
    stat(sl, 10.92,          2.35, 2.18, 1.6, pendingYes, 'PENDING CASE',  C.yell);
    // Bar chart
    sectionLabel(sl, 0.22, 4.12, 'MEMBERSHIP BREAKDOWN');
    var maxMem = Math.max(regularNpa, milisyang, noMemType, 1);
    barRow(sl, 0.22, 4.42, 9.5, 'REGULAR NPA',    regularNpa, maxMem, C.red);
    barRow(sl, 0.22, 4.76, 9.5, 'MILISYANG BAYAN',milisyang,  maxMem, C.yell);
    barRow(sl, 0.22, 5.10, 9.5, 'NOT SPECIFIED',  noMemType,  maxMem, C.sub);
    footer(sl, 3);

    // ══════════════════════════════════════════════════════════
    // SLIDE 4 — III. REFERRING UNITS
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'III', 'REFERRING UNITS');
    var topUnitText = topUnits.length
      ? topUnits.map(function(u){ return u+' ('+unitCounts[u]+')'; }).join(', ')
      : 'not yet recorded';
    var unitText =
      'Former rebels were referred primarily by: '+topUnitText+'. '+
      (noUnitCount>0 ? fmt(noUnitCount)+' ('+pct(noUnitCount)+'%) have no referring unit on record.' : 'All registrants have a referring unit on file.');
    prose(sl, 0.22, 0.9, 13.0, 1.2, unitText);
    // Top unit bars
    sectionLabel(sl, 0.22, 2.25, 'TOP REFERRING UNITS BY COUNT');
    var allUnitKeys = Object.keys(unitCounts).sort(function(a,b){ return unitCounts[b]-unitCounts[a]; }).slice(0,8);
    var maxUnit = allUnitKeys.length ? unitCounts[allUnitKeys[0]] : 1;
    var uy = 2.55;
    allUnitKeys.forEach(function(u) {
      var shortU = u.replace('Infantry','Inf.').replace('Battalion','Bn').replace('Brigade','Bde').replace(/ "/g,' "');
      barRow(sl, 0.22, uy, 12.8, shortU, unitCounts[u], maxUnit, C.yell);
      uy += 0.34;
    });
    // Not specified note
    if (noUnitCount > 0) {
      sl.addText('Not specified: '+fmt(noUnitCount)+' ('+pct(noUnitCount)+'%)',
        { x:0.22, y:uy+0.05, w:6, h:0.25, fontSize:8, color:C.sub, fontFace:FONT, italic:true });
    }
    footer(sl, 4);

    // ══════════════════════════════════════════════════════════
    // SLIDE 5 — IV. SURRENDER TIMELINE
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'IV', 'SURRENDER TIMELINE ('+START_YEAR+'–'+thisYear+')');
    var yrText =
      'Surrender records span from '+START_YEAR+' to '+thisYear+'. '+
      'The peak year is '+peakYear+' with '+fmt(peakYearCount)+' ('+pct(peakYearCount)+'%) surrenderees. '+
      (recentText ? 'Recent years: '+recentText+'. ' : '')+
      (noDateCount>0 ? fmt(noDateCount)+' ('+pct(noDateCount)+'%) have no surrender date on record.' : 'All registrants have a surrender date on file.');
    prose(sl, 0.22, 0.9, 13.0, 1.2, yrText);
    // Year bars
    sectionLabel(sl, 0.22, 2.25, 'SURRENDEREES PER YEAR');
    var maxYr = 1;
    for(var yy4=START_YEAR;yy4<=thisYear;yy4++) if((yrCounts[yy4]||0)>maxYr) maxYr=yrCounts[yy4];
    var yBarY = 2.52;
    for(var yy5=START_YEAR;yy5<=thisYear;yy5++){
      barRow(sl, 0.22, yBarY, 12.8, String(yy5), yrCounts[yy5]||0, maxYr, C.accent);
      yBarY += 0.31;
    }
    footer(sl, 5);

    // ══════════════════════════════════════════════════════════
    // SLIDE 6 — V. GEOGRAPHIC DISTRIBUTION
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'V', 'GEOGRAPHIC DISTRIBUTION');
    var munTopText = topMun.length
      ? topMun.map(function(m){ return m+' ('+(munCounts[m]||0)+')'; }).join(', ')
      : 'not yet recorded';
    var geoText =
      'Most registrants reside within Occidental Mindoro. '+
      'Top municipalities: '+munTopText+'. '+
      (mapsaCount>0 ? fmt(mapsaCount)+' ('+pct(mapsaCount)+'%) from MAPSA. ' : '')+
      (samaricaCount>0 ? fmt(samaricaCount)+' ('+pct(samaricaCount)+'%) from SAMARICA. ' : '')+
      (outsideMindoroCount>0 ? fmt(outsideMindoroCount)+' ('+pct(outsideMindoroCount)+'%) from outside Mindoro. ' : '')+
      (noMunCount>0 ? fmt(noMunCount)+' ('+pct(noMunCount)+'%) have no municipality recorded.' : '');
    prose(sl, 0.22, 0.9, 13.0, 1.35, geoText);
    // Area summary stats
    stat(sl, 0.22,  2.4, 3.0, 1.3, mapsaCount,          'MAPSA AREA',              C.green);
    stat(sl, 3.42,  2.4, 3.0, 1.3, samaricaCount,       'SAMARICA AREA',           '388BFD');
    stat(sl, 6.62,  2.4, 3.0, 1.3, outsideMindoroCount, 'OUTSIDE MINDORO',         C.yell);
    stat(sl, 9.82,  2.4, 3.0, 1.3, noMunCount,          'NO MUNICIPALITY ON FILE', C.red);
    // Top municipality bars
    sectionLabel(sl, 0.22, 3.9, 'TOP MUNICIPALITIES');
    var allMunKeys = Object.keys(munCounts).sort(function(a,b){ return munCounts[b]-munCounts[a]; }).slice(0,8);
    var maxMun = allMunKeys.length ? munCounts[allMunKeys[0]] : 1;
    var muBarY = 4.17;
    allMunKeys.forEach(function(m){
      barRow(sl, 0.22, muBarY, 12.8, m, munCounts[m], maxMun, '388BFD');
      muBarY += 0.34;
    });
    footer(sl, 6);

    // ══════════════════════════════════════════════════════════
    // SLIDE 7 — VI. TRIBAL GROUP / ETHNICITY
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'VI', 'TRIBAL GROUP / ETHNICITY');
    var tribalText =
      fmt(ipCount)+' ('+(withTribal>0?pct(ipCount):'0.0')+'%) belong to an IP tribal group, while '+
      fmt(nonIpCount)+' ('+pct(nonIpCount)+'%) have no tribal affiliation. '+
      (noTribalData>0 ? fmt(noTribalData)+' ('+pct(noTribalData)+'%) have no tribal data on file. ' : '')+
      (largestTribal&&tribalCounts[largestTribal]>0
        ? 'Largest IP group: '+largestTribal+' with '+fmt(tribalCounts[largestTribal])+' ('+pct(tribalCounts[largestTribal])+'%).' : '');
    prose(sl, 0.22, 0.9, 13.0, 1.25, tribalText);
    // IP vs Non-IP stats
    stat(sl, 0.22,  2.3, 4.1, 1.3, ipCount,     'INDIGENOUS PEOPLE (IP)', C.green);
    stat(sl, 4.52,  2.3, 4.1, 1.3, nonIpCount,  'NON-IP',                 '6E7681');
    stat(sl, 8.82,  2.3, 4.1, 1.3, noTribalData,'NOT SPECIFIED',          C.sub);
    // Tribal group bars
    sectionLabel(sl, 0.22, 3.78, 'TRIBAL GROUP BREAKDOWN');
    var maxTri = Math.max.apply(null, TRIBAL_TYPES.map(function(t){ return tribalCounts[t]; }).concat([1]));
    var triY = 4.05;
    TRIBAL_TYPES.forEach(function(t){
      barRow(sl, 0.22, triY, 12.8, t, tribalCounts[t], maxTri, C.green);
      triY += 0.31;
    });
    footer(sl, 7);

    // ══════════════════════════════════════════════════════════
    // SLIDE 8 — VII. AGE DISTRIBUTION
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'VII', 'AGE DISTRIBUTION');
    var ageText =
      'Age data available for '+fmt(withAge)+' of '+fmt(total)+' registrants. '+
      'Most populous bracket: '+BRACKETS[peakAgeIdx].label+' with '+fmt(ageCounts[peakAgeIdx])+
      ' ('+(withAge>0?((ageCounts[peakAgeIdx]/withAge)*100).toFixed(1):'0.0')+'% of those with recorded ages). '+
      (noAgeCount>0 ? fmt(noAgeCount)+' registrants have no date of birth on file.' : 'All registrants have a date of birth on file.');
    prose(sl, 0.22, 0.9, 13.0, 1.2, ageText);
    stat(sl, 0.22, 2.25, 3.0, 1.3, withAge,    'WITH AGE DATA',  C.accent);
    stat(sl, 3.42, 2.25, 3.0, 1.3, noAgeCount, 'NO AGE DATA',    C.red);
    stat(sl, 6.62, 2.25, 3.0, 1.3, BRACKETS[peakAgeIdx].label, 'PEAK BRACKET', C.green);
    stat(sl, 9.82, 2.25, 3.0, 1.3, ageCounts[peakAgeIdx], 'COUNT IN PEAK', C.green);
    sectionLabel(sl, 0.22, 3.72, 'AGE BRACKET DISTRIBUTION');
    var maxAge = Math.max.apply(null, ageCounts.concat([1]));
    var agY = 3.99;
    BRACKETS.forEach(function(b, i){
      barRow(sl, 0.22, agY, 12.8, b.label, ageCounts[i], maxAge, '388BFD');
      agY += 0.4;
    });
    footer(sl, 8);

    // ══════════════════════════════════════════════════════════
    // SLIDE 9 — VIII. SECTOR CLASSIFICATION
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'VIII', 'SECTOR CLASSIFICATION');
    var secText =
      'The most represented sectors are '+
      topSectors.map(function(s){ return s+' ('+fmt(secCounts[s])+')'; }).join(', ')+
      '. This reflects the predominantly rural and agricultural background of the FR population.';
    prose(sl, 0.22, 0.9, 13.0, 1.1, secText);
    sectionLabel(sl, 0.22, 2.15, 'ALL SECTORS');
    var maxSec = Math.max.apply(null, SECTORS.map(function(s){ return secCounts[s]; }).concat([1]));
    var secY = 2.42;
    SECTORS.forEach(function(s){
      barRow(sl, 0.22, secY, 12.8, s, secCounts[s], maxSec, C.green);
      secY += 0.37;
    });
    footer(sl, 9);

    // ══════════════════════════════════════════════════════════
    // SLIDE 10 — IX. 4Ps BENEFICIARIES
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'IX', '4Ps BENEFICIARIES');
    var fourPsText =
      fmt(fourPsYes)+' ('+pct(fourPsYes)+'%) are 4Ps beneficiaries, while '+
      fmt(fourPsNo)+' ('+pct(fourPsNo)+'%) are not. '+
      (fourPsNone>0 ? '4Ps status of '+fmt(fourPsNone)+' ('+pct(fourPsNone)+'%) is not yet recorded.' : '');
    prose(sl, 0.22, 0.9, 13.0, 1.1, fourPsText);
    stat(sl, 0.22, 2.15, 4.1, 1.5, fourPsYes,  '4Ps BENEFICIARIES', C.green);
    stat(sl, 4.52, 2.15, 4.1, 1.5, fourPsNo,   'NON-4Ps',           C.red);
    stat(sl, 8.82, 2.15, 4.1, 1.5, fourPsNone, 'NOT SPECIFIED',     C.sub);
    sectionLabel(sl, 0.22, 3.85, '4Ps STATUS BREAKDOWN');
    var max4ps = Math.max(fourPsYes, fourPsNo, fourPsNone, 1);
    barRow(sl, 0.22, 4.12, 12.8, 'YES (4Ps BENEFICIARY)', fourPsYes,  max4ps, C.green);
    barRow(sl, 0.22, 4.50, 12.8, 'NO (NON-4Ps)',          fourPsNo,   max4ps, C.red);
    barRow(sl, 0.22, 4.88, 12.8, 'NOT SPECIFIED',         fourPsNone, max4ps, C.sub);
    footer(sl, 10);

    // ══════════════════════════════════════════════════════════
    // SLIDE 11 — X. REINTEGRATION & ASSISTANCE
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'X', 'REINTEGRATION & ASSISTANCE');
    var asstText =
      fmt(totalBenef)+' ('+pct(totalBenef)+'%) received at least one form of assistance. '+
      (topAsst.length ? 'Top programs: '+topAsst.map(function(t){ return t+' ('+asstCounts[t]+')'; }).join(', ')+'. ' : '')+
      fmt(withEclip)+' ('+pct(withEclip)+'%) received E-CLIP; '+
      fmt(notQualEclip)+' ('+pct(notQualEclip)+'%) are not qualified; '+
      fmt(noEclipCount)+' ('+pct(noEclipCount)+'%) not yet assessed. '+
      (noAssist>0 ? fmt(noAssist)+' ('+pct(noAssist)+'%) have NO assistance on record — requires immediate follow-up.' : 'All registrants have at least one assistance recorded.');
    prose(sl, 0.22, 0.9, 13.0, 1.45, asstText);
    // Key assistance stats
    stat(sl, 0.22,  2.5, 2.85, 1.2, totalBenef,   'WITH ANY ASSISTANCE',         C.accent);
    stat(sl, 3.27,  2.5, 2.85, 1.2, withEclip,    'WITH E-CLIP',                 C.green);
    stat(sl, 6.32,  2.5, 2.85, 1.2, notQualEclip, 'NOT QUALIFIED FOR E-CLIP',    C.yell);
    stat(sl, 9.37,  2.5, 2.85, 1.2, noAssist,     'NO ASSISTANCE ON RECORD',     C.red);
    // PhilHealth note
    stat(sl, 0.22,  3.88, 2.85, 1.15, withPhil,  'WITH PHILHEALTH',   C.green);
    stat(sl, 3.27,  3.88, 2.85, 1.15, total-withPhil, 'WITHOUT PHILHEALTH', C.red);
    // All assistance bars
    sectionLabel(sl, 6.62, 3.88, 'ALL ASSISTANCE TYPES');
    var maxAsst = Math.max.apply(null, ASST_TYPES.map(function(t){ return asstCounts[t]; }).concat([1]));
    var asY = 4.15;
    ASST_TYPES.forEach(function(t){
      var shortT = t.replace('ISSUANCE OF ','').replace('APPLIED FOR ','');
      barRow(sl, 6.62, asY, 6.6, shortT, asstCounts[t], maxAsst, C.accent);
      asY += 0.29;
    });
    footer(sl, 11);

    // ══════════════════════════════════════════════════════════
    // SLIDE 12 — XI. JAPIC CERTIFICATE STATUS
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'XI', 'JAPIC CERTIFICATE STATUS');
    var japicText =
      fmt(withJapic)+' ('+pct(withJapic)+'%) have a JAPIC certificate on file. '+
      fmt(noJapic)+' ('+pct(noJapic)+'%) still lack a JAPIC certificate, requiring follow-up from referring units.';
    prose(sl, 0.22, 0.9, 13.0, 1.1, japicText);
    stat(sl, 0.22,  2.2, 6.2, 2.2, withJapic, 'WITH JAPIC CERTIFICATE',    C.green);
    stat(sl, 6.72,  2.2, 6.2, 2.2, noJapic,   'WITHOUT JAPIC CERTIFICATE', C.red);
    var maxJapic = Math.max(withJapic, noJapic, 1);
    sectionLabel(sl, 0.22, 4.6, 'JAPIC FILING STATUS');
    barRow(sl, 0.22, 4.87, 12.8, 'WITH JAPIC',    withJapic, maxJapic, C.green);
    barRow(sl, 0.22, 5.25, 12.8, 'WITHOUT JAPIC', noJapic,   maxJapic, C.red);
    footer(sl, 12);

    // ══════════════════════════════════════════════════════════
    // SLIDE 13 — XII. DATA QUALITY
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    header(sl, 'XII', 'DATA QUALITY');

    // ── Compute field-level missing counts ───────────────────
    var ALL_FIELDS = [
      'LAST NAME','FIRST NAME','MIDDLE NAME','SEX','CIVIL STATUS','RELIGION',
      'MEDICAL CONDITION','4Ps','ADDRESS','BARANGAY','MUNICIPALITY','PROVINCE',
      'TRIBAL GROUP','SECTOR','UNIT','POSITION','MEMBERSHIP TYPE',
      'AREA OF OPERATION','YEARS IN MOVEMENT','DATE SURRENDERED',
      'PENDING CASE','REFERRING UNIT'
    ];
    var fieldMissCounts = {};
    ALL_FIELDS.forEach(function(f){ fieldMissCounts[f] = 0; });
    records.forEach(function(r){
      getMissingFieldsGlobal(r).forEach(function(f){
        if (fieldMissCounts[f] !== undefined) fieldMissCounts[f]++;
        else fieldMissCounts[f] = 1;
      });
    });
    // Sort by most missing, take top 10
    var topMissingFields = ALL_FIELDS.slice()
      .filter(function(f){ return fieldMissCounts[f] > 0; })
      .sort(function(a,b){ return fieldMissCounts[b] - fieldMissCounts[a]; })
      .slice(0, 10);

    var completeCount = total - incomplete;
    var completePct   = total > 0 ? ((completeCount/total)*100).toFixed(1) : '0.0';

    // ── Prose ────────────────────────────────────────────────
    var dataText =
      fmt(incomplete)+' ('+pct(incomplete)+'%) profiles are missing one or more required fields. '+
      fmt(completeCount)+' ('+completePct+'%) profiles are fully complete. '+
      'Immediate data clean-up is recommended to ensure accurate reporting and eligibility assessment.';
    prose(sl, 0.22, 0.9, 13.0, 1.0, dataText);

    // ── Completeness progress bar ────────────────────────────
    var pbY = 2.05, pbX = 0.22, pbW = 13.0, pbH = 0.32;
    var fillFrac = total > 0 ? completeCount / total : 0;
    // Track
    sl.addShape(pptx.ShapeType.roundRect,
      { x:pbX, y:pbY, w:pbW, h:pbH,
        fill:{ color:C.dim }, line:{ color:C.border, width:0.5 }, rectRadius:0.06 });
    // Fill (green = complete)
    if (fillFrac > 0) {
      sl.addShape(pptx.ShapeType.roundRect,
        { x:pbX, y:pbY, w:pbW * fillFrac, h:pbH,
          fill:{ color:C.green }, line:{ color:C.green, width:0 }, rectRadius:0.06 });
    }
    // Fill (red = incomplete, stacked right)
    if (fillFrac < 1) {
      sl.addShape(pptx.ShapeType.roundRect,
        { x:pbX + pbW * fillFrac, y:pbY, w:pbW * (1 - fillFrac), h:pbH,
          fill:{ color:C.red }, line:{ color:C.red, width:0 }, rectRadius:0.06 });
    }
    sl.addText(completePct+'% COMPLETE',
      { x:pbX+0.1, y:pbY, w:pbW*fillFrac - 0.1, h:pbH,
        fontSize:8, bold:true, color:C.bg, fontFace:FONT, valign:'middle' });
    sl.addText(pct(incomplete)+'% INCOMPLETE',
      { x:pbX + pbW*fillFrac + 0.1, y:pbY, w:pbW*(1-fillFrac) - 0.1, h:pbH,
        fontSize:8, bold:true, color:C.bg, fontFace:FONT, valign:'middle', align:'right' });

    // ── Alert stat cards (top row) ───────────────────────────
    var alerts = [
      { v:incomplete,   l:'INCOMPLETE PROFILES',  c:C.red  },
      { v:noJapic,      l:'NO JAPIC ON FILE',      c:C.yell },
      { v:noEclipCount, l:'NO E-CLIP',             c:C.yell },
      { v:noAssist,     l:'NO ASSISTANCE',         c:C.red  },
      { v:cannotLocate, l:'CANNOT BE LOCATED',     c:C.yell },
      { v:deceased,     l:'DECEASED',              c:C.red  },
      { v:incarcerated, l:'INCARCERATED',          c:C.purp },
      { v:pendingYes,   l:'PENDING CASE',          c:C.purp }
    ];
    var aW = 2.97, aH = 1.2, aG = 0.18;
    alerts.forEach(function(a, i){
      var col = i % 4, row = Math.floor(i / 4);
      var ax  = 0.22 + col * (aW + aG);
      var ay  = 2.52 + row * (aH + 0.14);
      stat(sl, ax, ay, aW, aH, a.v, a.l, a.c);
    });

    // ── Most missing fields bar chart ────────────────────────
    sectionLabel(sl, 0.22, 5.08, 'MOST COMMONLY MISSING FIELDS (TOP '+topMissingFields.length+')');
    if (topMissingFields.length === 0) {
      sl.addText('✓  ALL REQUIRED FIELDS ARE COMPLETE ACROSS ALL PROFILES',
        { x:0.22, y:5.35, w:13.0, h:0.4,
          fontSize:11, bold:true, color:C.green, fontFace:FONT, align:'center', valign:'middle' });
    } else {
      var maxMissing = fieldMissCounts[topMissingFields[0]] || 1;
      // Two columns of bars to fit 10 fields in the space
      var colWidth   = 6.3;
      var colGap     = 0.25;
      var bStartY    = 5.35;
      var bRowH      = 0.3;
      var half       = Math.ceil(topMissingFields.length / 2);
      topMissingFields.forEach(function(f, i) {
        var col  = Math.floor(i / half);
        var row  = i % half;
        var bx   = 0.22 + col * (colWidth + colGap);
        var by   = bStartY + row * bRowH;
        barRow(sl, bx, by, colWidth, f, fieldMissCounts[f], maxMissing, C.red);
      });
    }
    footer(sl, 13);

    // ══════════════════════════════════════════════════════════
    // SLIDE 14 — CLOSING / KEY TAKEAWAYS
    // ══════════════════════════════════════════════════════════
    sl = pptx.addSlide(); bg(sl);
    sl.addShape(pptx.ShapeType.rect, { x:0, y:0, w:13.33, h:0.12, fill:{ color:C.accent } });
    sl.addShape(pptx.ShapeType.rect, { x:0, y:0.12, w:0.08, h:7.38, fill:{ color:C.accent } });
    sl.addText('KEY TAKEAWAYS', { x:0.3, y:0.65, w:12.8, h:0.55, fontSize:24, bold:true, color:C.accent, fontFace:FONT, align:'center', charSpacing:4 });
    sl.addShape(pptx.ShapeType.line, { x:1.5, y:1.28, w:10.3, h:0, line:{ color:C.border, width:1 } });
    var takeaways = [
      fmt(total)+' registered FRs | '+fmt(male)+' male ('+pct(male)+'%) | '+fmt(female)+' female ('+pct(female)+'%)',
      fmt(regularNpa)+' Regular NPA ('+pct(regularNpa)+'%) | '+fmt(milisyang)+' Milisyang Bayan ('+pct(milisyang)+'%)',
      fmt(withJapic)+' with JAPIC ('+pct(withJapic)+'%) | '+fmt(withEclip)+' with E-CLIP ('+pct(withEclip)+'%)',
      'Peak surrender year: '+peakYear+' with '+fmt(peakYearCount)+' surrenderees ('+pct(peakYearCount)+'%)',
      fmt(ipCount)+' Indigenous People ('+pct(ipCount)+'%) | Largest group: '+(largestTribal||'—')+' ('+fmt(tribalCounts[largestTribal]||0)+')',
      fmt(fourPsYes)+' 4Ps beneficiaries ('+pct(fourPsYes)+'%) | '+fmt(withPhil)+' with PhilHealth ('+pct(withPhil)+'%)',
      fmt(totalBenef)+' with any assistance ('+pct(totalBenef)+'%) | '+fmt(noAssist)+' with NO assistance ('+pct(noAssist)+'%)',
      fmt(incomplete)+' incomplete profiles ('+pct(incomplete)+'%) | '+fmt(noJapic)+' without JAPIC ('+pct(noJapic)+'%)'
    ];
    takeaways.forEach(function(line, i){
      sl.addShape(pptx.ShapeType.roundRect,
        { x:0.55, y:1.42+i*0.66, w:12.2, h:0.58, fill:{ color:i%2===0?C.card:C.dim }, line:{ color:C.border, width:0.5 }, rectRadius:0.05 });
      sl.addText('◆  '+line,
        { x:0.75, y:1.42+i*0.66, w:11.8, h:0.58, fontSize:9.5, color:i%2===0?C.text:C.sub, fontFace:FONT, valign:'middle' });
    });
    sl.addText('As of '+reportDate+'  |  '+generatedBy+'  |  CONFIDENTIAL',
      { x:0.3, y:7.18, w:12.8, h:0.2, fontSize:7, color:'6E7681', fontFace:FONT, align:'center', italic:true });
    footer(sl, 14);

    // ── Download ─────────────────────────────────────────────
    var dateStr  = new Date().toISOString().slice(0, 10);
    var filename = 'FR_EXECUTIVE_SUMMARY_'+dateStr;
    pptx.writeFile({ fileName: filename })
      .then(function(){ showToast('PRESENTATION DOWNLOADED — '+filename+'.pptx', 'success'); })
      .catch(function(err){ showToast('PPTX ERROR: '+err.message, 'error'); });
  }

  if (allRecordsCache.length) run(allRecordsCache);
  else dbGetAll().then(function(records){ allRecordsCache = records; run(records); })
    .catch(function(err){ showToast('ERROR: '+err.message, 'error'); });
}


// -- BOOT (Firebase Auth state) -------------------------------
auth.onAuthStateChanged(function(user) {
  if (user) {
    if (!currentUser) {
      // Determine role by email - only admin@frdb.local is ADMIN
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
      // One-time migrations: only run once per device, not on every login
      var migKey = 'frdb-migrations-done-v2';
      if (!localStorage.getItem(migKey)) {
        migrateCivilStatus();
        migrateDefaults();
        localStorage.setItem(migKey, '1');
      }
    }
  }
});
