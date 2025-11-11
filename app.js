// ---------- wait for firestore helpers to appear (non-blocking/failsafe) ----------
function waitForFirestoreReady(timeout = 6000) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function poll() {
      if (typeof window.db !== 'undefined'
          && typeof window.getDoc === 'function'
          && typeof window.doc === 'function'
          && typeof window.deleteDoc === 'function') {
        return resolve(true);
      }
      if (Date.now() - start > timeout) return resolve(false);
      setTimeout(poll, 120);
    })();
  });
}
window._firestoreReadyPromise = waitForFirestoreReady(6000);
window._firestoreReadyPromise.then(ok => {
  if (!ok) console.warn('Firestore not available or getDoc/doc not imported - falling back to local storage');
  else console.log('Firestore helpers ready.');
});




async function saveToFirestore(collectionName, id, data, localKey=null) {
  try {
    if (localKey) write(localKey, data); // keep offline copy
    await setDoc(doc(db, collectionName, id), data);
    console.log(`✅ Firestore saved: ${collectionName}/${id}`);
    return true;
  } catch (err) {
    console.warn("⚠️ Firestore save failed, local only", err);
    return false;
  }
}
// ----------------- Question save helper -----------------
// Place this right after saveToFirestore(...) in app.js
async function saveQuestion(q) {
  if (!q || !q.id) q.id = uid();

  // update or add in local questions array
  const idx = questions.findIndex(x => x.id === q.id);
  if (idx >= 0) {
    questions[idx] = q;
  } else {
    questions.push(q);
  }

  // persist locally
  write(K_QS, questions);

  // persist to Firestore (best-effort)
  try {
    await saveToFirestore("questions", q.id, q, K_QS);
    console.log("✅ Question saved to Firestore:", q.id);
  } catch (err) {
    console.warn("⚠️ Failed to save question to Firestore (local saved):", err);
  }

  // refresh UI if renderQuestionsList exists
  if (typeof renderQuestionsList === "function") renderQuestionsList();
}
window.saveQuestion = saveQuestion; // expose globally if admin UI needs it

// ----------------- deleteQuestion helper -----------------
// ----------------- deleteQuestion helper (async & waits for firestore) -----------------
async function deleteQuestion(id) {
  if (!id) return alert('No question id provided.');
  if (!confirm('Delete this question? This will remove it locally and attempt to remove from Firestore.')) return;

  try {
    // 1) Remove locally
    questions = (Array.isArray(questions) ? questions : []).filter(q => q.id !== id);

    // 2) Persist to localStorage
    try { write(K_QS, questions); } catch (e) { console.warn('Could not write localStorage after delete:', e); }

    // 3) Attempt Firestore delete (best-effort)
    try {
      const ready = await (window._firestoreReadyPromise || Promise.resolve(false));
      if (ready && typeof deleteDoc === 'function' && typeof doc === 'function' && typeof db !== 'undefined') {
        await deleteDoc(doc(db, 'questions', id));
        console.log('✅ Firestore: deleted questions/' + id);
      } else {
        console.warn('Firestore helpers not ready — skipped Firestore delete.');
      }
    } catch (err) {
      console.warn('⚠️ Firestore delete failed (check rules/permissions):', err);
      alert('⚠️ Deleted locally but failed to delete from Firestore (see console). Check Firestore rules or console errors.');
    }

    // 4) Refresh UI
    if (typeof renderQuestionsList === 'function') renderQuestionsList();
    else location.reload();

  } catch (e) {
    console.error('deleteQuestion error:', e);
    alert('Failed to delete question (see console).');
  }
}
window.deleteQuestion = deleteQuestion;


/* -------------------------
   Storage keys & defaults
   ------------------------- */
const K_USERS = 'offline_mcq_users_v1';
const K_QS = 'offline_mcq_qs_v1';
const K_RESULTS = 'offline_mcq_results_v1';
const K_ADMIN = 'offline_mcq_admin_v1';

const MASTER_ADMIN = { username: 'admin', password: 'exam123' };
const K_SETTINGS = 'offline_mcq_settings_v1';

/* Helpers */
const $ = s => document.querySelector(s);
const $all = s => Array.from(document.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2,9);
const read = (k,def) => { try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } }
const write = (k,v) => localStorage.setItem(k, JSON.stringify(v));
const download = (filename, content, type='text/plain') => {
  const blob = new Blob([content], {type});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);
};
// Escape HTML to show tags as plain text
// Safe escapeHTML: always coerce input to string before replacing
function escapeHTML(input) {
  if (input === null || input === undefined) return '';
  // If it's an object, stringify it so we don't break; numbers are converted to strings too
  const str = (typeof input === 'string') ? input : (typeof input === 'object' ? JSON.stringify(input) : String(input));
  return str.replace(/[&<>"'`=\/]/g, function (s) {
    return ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '/': '&#x2F;',
      '`': '&#x60;',
      '=': '&#x3D;'
    })[s];
  });
}
window.escapeHTML = escapeHTML; // expose globally if other code expects it

// Text encoder/decoder
const enc = new TextEncoder();
const dec = new TextDecoder();

// Fixed secret key (you can also ask admin for password to generate this)
const SECRET_KEY = "exam-secret-key-123"; 

// Derive AES key from secret string
async function getKey() {
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(SECRET_KEY), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("exam-salt"), iterations: 1000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptData(obj) {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify(obj));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv: Array.from(iv), data: btoa(String.fromCharCode(...new Uint8Array(encrypted))) };
}

async function decryptData(encObj) {
  const key = await getKey();
  const iv = new Uint8Array(encObj.iv);
  const data = Uint8Array.from(atob(encObj.data), c => c.charCodeAt(0));
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(dec.decode(decrypted));
}


/* Load or seed data */
let users = read(K_USERS, []);
let questions = read(K_QS, []);
let results = read(K_RESULTS, []);
let adminCred = read(K_ADMIN, null);
let settings = read(K_SETTINGS, { 
  durationMin: 20, 
  customMsg: "📢 Welcome to your exam! Stay calm, focus, and do your best!",
  shuffle: false,
  allowAfterTime: false,
  logo: "",            // ✅ no default logo
  author: "",          // ✅ blank
  college: "",         // ✅ blank
  subject: "",         // ✅ blank
  subjectCode: "",     // ✅ blank
  fullMarks: 0,        // ✅ blank
  counts: {
    Synopsis: 0,
    "Minor Practical": 0,
    "Major Practical": 0,
    Viva: 0
  }
});
let screenShareEnabled = false;

if(!adminCred) write(K_ADMIN,
                     MASTER_ADMIN);

if(questions.length === 0){
  // seed sample questions
  questions = [
    { id: uid(), question: 'HTML stands for?', options: ['Hyperlinks Text Markup','Home Tool Markup','Hyper Text Markup Language','Hyperlinking Text Markdown'], answer: 2, marks: 1, category: 'Synopsis' },
    { id: uid(), question: 'Which tag defines paragraph?', options: ['<p>','<para>','<pg>','<par>'], answer: 0, marks: 1, category: 'Minor Practical' },
    { id: uid(), question: 'Which method adds to array end?', options: ['push','pop','shift','unshift'], answer: 0, marks: 2, category: 'Major Practical' },
    { id: uid(), question: 'Does localStorage persist after browser restart?', options: ['Yes','No','Sometimes','Depends'], answer: 0, marks: 1, category: 'Viva' }
  ];
  write(K_QS, questions);
}
function downloadBackup() {
  const backup = {
    users,
    questions,
    results,
    settings,
    adminCred
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "exam_full_backup.json";
  a.click();
}

// ----------------- Improved importFullBackup -----------------
async function importFullBackup(file) {
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const backup = JSON.parse(e.target.result);

      // update in-memory and localStorage
      users = backup.users || [];
      questions = backup.questions || [];
      results = backup.results || [];

      // Merge settings safely (keeps existing defaults if missing)
      settings = {
        ...settings,
        durationMin: backup.settings?.durationMin ?? settings.durationMin,
        customMsg: backup.settings?.customMsg ?? settings.customMsg,
        shuffle: backup.settings?.shuffle ?? settings.shuffle,
        allowAfterTime: backup.settings?.allowAfterTime ?? settings.allowAfterTime,
        logo: backup.settings?.logo ?? settings.logo,
        author: backup.settings?.author ?? settings.author,
        college: backup.settings?.college ?? settings.college,
        subject: backup.settings?.subject ?? settings.subject,
        subjectCode: backup.settings?.subjectCode ?? settings.subjectCode,
        fullMarks: backup.settings?.fullMarks ?? settings.fullMarks,
        counts: {
          Synopsis: backup.settings?.counts?.Synopsis ?? settings.counts?.Synopsis ?? 0,
          "Minor Practical": backup.settings?.counts?.["Minor Practical"] ?? settings.counts?.["Minor Practical"] ?? 0,
          "Major Practical": backup.settings?.counts?.["Major Practical"] ?? settings.counts?.["Major Practical"] ?? 0,
          Viva: backup.settings?.counts?.Viva ?? settings.counts?.Viva ?? 0
        },
        totalQs: backup.settings?.totalQs ?? settings.totalQs // if present
      };

      adminCred = backup.adminCred || MASTER_ADMIN;

      // persist locally
      write(K_USERS, users);
      write(K_QS, questions);
      write(K_RESULTS, results);
      write(K_SETTINGS, settings);
      write(K_ADMIN, adminCred);

      // Persist questions to Firestore in bulk (best-effort)
      // IMPORTANT: this will write each question doc under collection "questions"
      const failList = [];
      for (const q of questions) {
        try {
          // ensure id exists
          if (!q.id) q.id = uid();
          await saveToFirestore("questions", q.id, q, K_QS);
        } catch (err) {
          console.warn("Failed to save question to Firestore:", q.id, err);
          failList.push(q.id || JSON.stringify(q).slice(0,40));
        }
      }

      alert(`✅ Full backup restored! Firestore failures: ${failList.length}`);
      // refresh all admin UI
      if (typeof renderQuestionsList === "function") renderQuestionsList();
      if (typeof renderUsersAdmin === "function") renderUsersAdmin();
      if (typeof renderResults === "function") renderResults();
      if (typeof renderSettingsAdmin === "function") renderSettingsAdmin();
    } catch (err) {
      alert("❌ Invalid backup file");
      console.error(err);
    }
  };
  reader.readAsText(file);
}
window.importFullBackup = importFullBackup;


function updateBackup() {
  const backup = {
    users,
    questions,
    results,
    settings,
    adminCred
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "exam_full_backup.json"; // same name every time
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href), 1000);

  alert("✅ Backup updated! Please replace the old file when saving.");
}

/* UI: show sections (updated to support 'home' fullscreen) */
function showSection(id){
  // hide the home view and app wrap by default
  const homeEl = document.getElementById('home');
  const wrapEl = document.querySelector('.wrap');

  if(id === 'home') {
    if(homeEl) homeEl.classList.remove('hidden');
    if(wrapEl) wrapEl.classList.add('hidden');
    return;
  }

  // show the main app wrap and hide home
  if(homeEl) homeEl.classList.add('hidden');
  if(wrapEl) wrapEl.classList.remove('hidden');

  // hide internal sections inside the app
  ['user','import','adminLogin','adminPanel'].forEach(s => { const el = document.getElementById(s); if(!el) return; el.classList.add('hidden'); });
  const target = document.getElementById(id);
  if(target) target.classList.remove('hidden');

  if(id === 'adminPanel') {
    renderQuestionsList();
    renderUsersAdmin();
    renderResults();
  }
}
 if (typeof initVisitorSession === "function") {
    try { initVisitorSession(); } catch(e) { console.warn("initVisitorSession failed", e); }
  }
  // Wire home buttons to existing flows
document.addEventListener('DOMContentLoaded', ()=> {
  // Start the app showing the Home view
  if(typeof showSection === 'function') showSection('home');

  const adminBtn = document.getElementById('homeAdminBtn');
  if(adminBtn) adminBtn.addEventListener('click', ()=> showSection('adminLogin'));

  const loginBtn = document.getElementById('homeLoginBtn');
  if(loginBtn) loginBtn.addEventListener('click', async ()=> {
    // copy values from home inputs to the existing user form and call login
    const u = document.getElementById('homeUsername').value.trim();
    const p = document.getElementById('homePassword').value;
    if(!u || !p) return alert('Enter username and password');

    // fill the existing user form so all logic (photo, resume checks) works as before
    document.getElementById('userName').value = u;
    document.getElementById('userPass').value = p;

    // show user section (so any UI messages appear), then call your existing handler
    showSection('user');

    // call the existing user login handler (if you use the resume version, call that instead)
    if(typeof handleUserLogin === 'function') {
      // small delay so UI switches before heavy work
      setTimeout(()=> handleUserLogin(), 120);
    } else if(typeof handleUserLogin_withResume === 'function') {
      setTimeout(()=> handleUserLogin_withResume(), 120);
    } else {
      alert('Login handler not found – ensure handleUserLogin exists.');
    }
  });

    // --- Import backup wiring ---
 // remove or replace the existing importFileInput wiring
// const importFileInput = document.getElementById('importFileInput');
// ...
// importFullBackup(file);

// Instead, wire the backup-specific input (you already have one in index.html with id="importBackupFile")
// === Import wiring: Question-file input (impQFile) already wired via onchange in index.html ===
// No JS needed for impQFile — importQuestionsFile(event) will run directly from the input onchange.

// === Ensure backup import input is wired to full-backup handler ===
// If your index.html has a backup import input, ensure it has an id like "importBackupFile".
// This JS wires it safely to importFullBackup(file) and prevents accidental overlap.

document.addEventListener('DOMContentLoaded', () => {
  const importBackupInput = document.getElementById('importBackupFile'); // backup/import-all input (if present)
  if (importBackupInput) {
    importBackupInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.json')) {
        alert('Please select a .json backup file');
        importBackupInput.value = '';
        return;
      }
      if (!confirm('Importing will overwrite local users, questions, results and settings. Proceed?')) {
        importBackupInput.value = '';
        return;
      }
      importFullBackup(file);
      importBackupInput.value = ''; // reset after use
    });
  }

  // remove any stray listener for importFileInput if present
  const stray = document.getElementById('importFileInput');
  if (stray) {
    // If you intentionally had this element elsewhere, consider renaming or removing it.
    // We'll neutralize its onchange to avoid conflicts.
    stray.onchange = null;
  }
});


// CAMERA permission preview helpers (put inside DOMContentLoaded)
let _homeCameraStream = null;

async function startHomeCamera() {
  try {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      alert('Camera API not available in this browser.');
      return;
    }

    // Ask for camera (video) permission
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    _homeCameraStream = stream;

    const video = document.getElementById('homeCameraPreview');
    const container = document.getElementById('cameraPreviewContainer');
    const stopBtn = document.getElementById('stopCameraBtn');
    if (video) {
      // show preview
      video.srcObject = stream;
      container.style.display = 'block';
      stopBtn.classList.remove('hidden');
      document.getElementById('enableCameraBtn').classList.add('hidden');
    }

    // Optional: remember user choice for this browser session (not required)
    try { localStorage.setItem('cameraGranted', '1'); } catch(e){}

  } catch (err) {
    console.warn('Camera permission denied or error:', err);
    if (err && err.name === 'NotAllowedError') {
      alert('Camera permission denied. You can enable it from browser settings.');
    } else {
      alert('Could not access camera: ' + (err && err.message ? err.message : err));
    }
  }
}

function stopHomeCamera() {
  try {
    // stop all tracks
    if (_homeCameraStream) {
      _homeCameraStream.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
      _homeCameraStream = null;
    }
    // hide preview & toggle buttons
    const video = document.getElementById('homeCameraPreview');
    if (video) {
      try { video.srcObject = null; } catch(e){}
    }
    const container = document.getElementById('cameraPreviewContainer');
    const stopBtn = document.getElementById('stopCameraBtn');
    if (container) container.style.display = 'none';
    if (stopBtn) stopBtn.classList.add('hidden');
    const enableBtn = document.getElementById('enableCameraBtn');
    if (enableBtn) enableBtn.classList.remove('hidden');

    try { localStorage.removeItem('cameraGranted'); } catch(e){}
  } catch (e) {
    console.warn('stopHomeCamera error', e);
  }
}

// Wiring: Add listeners to the buttons (inside DOMContentLoaded)
const enableBtn = document.getElementById('enableCameraBtn');
if (enableBtn) {
  enableBtn.addEventListener('click', (e) => {
    e.preventDefault();
    startHomeCamera();
  });
}

const stopBtn = document.getElementById('stopCameraBtn');
if (stopBtn) stopBtn.addEventListener('click', (e) => { e.preventDefault(); stopHomeCamera(); });

  
const enableSSBtn = document.getElementById('enableScreenShareBtn');
if (enableSSBtn) enableSSBtn.addEventListener('click', (e)=>{ 
  e.preventDefault(); 
  startHomeScreenShare(); 
});

const stopSSBtn = document.getElementById('stopScreenShareBtn');
if (stopSSBtn) stopSSBtn.addEventListener('click', (e)=>{ 
  e.preventDefault(); 
  stopHomeScreenShare(); 
 
});
  
// Optional: stop camera when user navigates to the user section (so preview doesn't keep running)
const originalShowSection = showSection;
window.showSection = function(id) {
  // stop camera if leaving home
  if (id !== 'home') {
    stopHomeCamera();
  }
  // call existing showSection (preserve behavior)
  return originalShowSection(id);
};

  // Enter key on home password should trigger login
  document.getElementById('homePassword').addEventListener('keydown', (e)=>{ if(e.key === 'Enter') document.getElementById('homeLoginBtn').click(); });
   // ✅ Paste toggle-collapse code here
  const nav = document.getElementById('questionNav');
  const toggleBtn = document.getElementById('qnavToggleBtn');
  if (nav && toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      nav.classList.toggle('collapsed');
      toggleBtn.textContent = nav.classList.contains('collapsed') ? '+' : '−';
    });
  }
});


// SCREEN SHARE helpers
let _homeScreenStream = null;

async function startHomeScreenShare() {
  try {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      alert('Screen sharing API not available in this browser.');
      return;
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    _homeScreenStream = stream;
    screenShareEnabled = true;   // ✅ mark as enabled

    const video = document.getElementById('homeScreenSharePreview');
    const container = document.getElementById('screenSharePreviewContainer');
    const stopBtn = document.getElementById('stopScreenShareBtn');
    if (video) {
      video.srcObject = stream;
      container.style.display = 'block';
      stopBtn.classList.remove('hidden');
      document.getElementById('enableScreenShareBtn').classList.add('hidden');
    }

    // Auto-stop if user ends from browser toolbar
    stream.getVideoTracks()[0].addEventListener('ended', stopHomeScreenShare);

  } catch (err) {
    console.warn('Screen share denied or error:', err);
    alert('Could not start screen share: ' + (err && err.message ? err.message : err));
  }
}

function stopHomeScreenShare() {
  try {
    if (_homeScreenStream) {
      _homeScreenStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
      _homeScreenStream = null;
    }
    screenShareEnabled = false;   // ✅ reset flag
    const video = document.getElementById('homeScreenSharePreview');
    if (video) video.srcObject = null;
    document.getElementById('screenSharePreviewContainer').style.display = 'none';
    document.getElementById('stopScreenShareBtn').classList.add('hidden');
    document.getElementById('enableScreenShareBtn').classList.remove('hidden');
  } catch (e) {
    console.warn('stopHomeScreenShare error', e);
  }
}

/* ---------- USER FLOW ---------- */

/* convert File -> base64 data URL */
function fileToDataURL(file){ return new Promise(res => { const fr = new FileReader(); fr.onload = ()=> res(fr.result); fr.readAsDataURL(file); }); }

async function getResultsArray() {
  // If memory already has a usable array, return it
  if (Array.isArray(results)) return results;

  // Try localStorage (encrypted)
  const stored = read(K_RESULTS, null);
  if (stored) {
    try {
      const arr = await decryptData(stored);
      if (Array.isArray(arr)) {
        results = arr;       // keep in memory as array
        return results;
      }
    } catch (e) {
      console.warn("Could not decrypt local results", e);
    }
  }

  // Try Firestore (encrypted bundle at results/all)
  try {
    const snap = await getDoc(doc(db, "results", "all"));
    if (snap.exists()) {
      const enc = snap.data().data;
      const arr = await decryptData(enc);
      if (Array.isArray(arr)) {
        results = arr;
        return results;
      }
    }
  } catch (e) {
    console.warn("Could not load results from Firestore", e);
  }

  // Fallback: empty
  results = [];
  return results;
}

/* ---------------- EXAM RUNTIME (fullscreen) ---------------- */

let EXAM = {
  paper: [],      // array of questions (copied)
  state: null,    // {username,answers:{qId:choice},flags:{qId:true},startedAt,remainingMs,submitted}
  timerId: null,
  cur: 0,
  cfg: { durationMin: 30, total: null, shuffle: false } // default
};

function buildPaper(qbank, shuffle){
  let selected = [];

  // group by category
  const byCategory = {
    Synopsis: qbank.filter(q => q.category === "Synopsis"),
    "Minor Practical": qbank.filter(q => q.category === "Minor Practical"),
    "Major Practical": qbank.filter(q => q.category === "Major Practical"),
    Viva: qbank.filter(q => q.category === "Viva")
  };

  // helper to pick random questions
  function pickRandom(arr, count){
    const copy = arr.slice();
    const chosen = [];
    for (let i = 0; i < count && copy.length > 0; i++) {
      const idx = Math.floor(Math.random() * copy.length);
      chosen.push(copy.splice(idx,1)[0]);
    }
    return chosen;
  }

  // pick based on settings.counts
  for (let cat in settings.counts){
    if (byCategory[cat]) {
      selected = selected.concat(pickRandom(byCategory[cat], settings.counts[cat]));
    }
  }

  // shuffle overall exam if enabled
  if (shuffle) {
    for (let i = selected.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [selected[i], selected[j]] = [selected[j], selected[i]];
    }
  }

  return selected.map(q => ({
    id: q.id,
    question: q.question,
    options: q.options,
    answer: q.answer,
    marks: q.marks,
    category: q.category
  }));
}

async function startExam(user){
  enterFullscreen(document.documentElement); // force fullscreen

  // --- Use Firestore settings as source of truth
  EXAM.cfg.total   = settings.totalQs || questions.length;
  EXAM.cfg.shuffle = !!settings.shuffle;
  const durationMin = Number(settings.durationMin ?? 30);
  EXAM.cfg.durationMin = durationMin;

  console.log(`⏳ Starting exam with duration: ${EXAM.cfg.durationMin} minutes`);

  document.getElementById("examMsg").textContent = settings.customMsg || "";
  document.getElementById("examCharacterName").textContent = user.fullName || user.username;

  EXAM.paper = buildPaper(questions, EXAM.cfg.shuffle);

  const durationMs = Math.max(1, durationMin) * 60_000;

  // Fresh exam state: everyone starts with the SAME duration
  EXAM.state = {
    username: user.username,
    answers: {},
    flags: {},
    startedAt: Date.now(),
    durationMs: durationMs,
    remainingMs: durationMs,  // ← set baseline
    submitted: false
  };
  EXAM.cur = 0;

  // --- Optional resume logic (only if you WANT it)
  // Add a checkbox in admin to set settings.resumeEnabled if you need this behavior.
  if (settings.resumeEnabled === true) {
    const resume = await loadTimer(user.username); // should return { remainingMs } or null
    if (resume && typeof resume.remainingMs === "number") {
      // Clamp to [0, durationMs] to avoid weird values
      const clamped = Math.min(Math.max(0, resume.remainingMs), durationMs);
      if (clamped > 0 && clamped < durationMs) {
        EXAM.state.remainingMs = clamped;
        console.log(`↩ Resuming with ${Math.round(clamped/60000)} min left`);
      }
    }
  }

  // Show fullscreen modal
  $('#examFullscreen').style.display = 'flex';
  $('#fsPhoto').src = user.photo || '';
  $('#fsName').textContent = user.fullName || user.username;

 paintQuestion();
 if (screenShareEnabled) {
  startExamStream(user.username);
}

startTimer();
await saveSessionToFirestore(user.username, EXAM.state, EXAM.paper);
startPeriodicSessionSave();
}

async function loadTimer(username) {
  try {
    const snap = await getDoc(doc(db, "timers", username));
    if (snap.exists()) {
      const saved = snap.data();
      if (EXAM.state) {
        EXAM.state.remainingMs = saved.remainingMs;
      }
      console.log("⏳ Restored timer for", username, saved.remainingMs);
    }
  } catch (err) {
    console.error("⚠️ Failed to load timer:", err);
  }
}

/* ----------------------------
   Resume & refresh/close limit
   ---------------------------- */

/*
  sessions/{username} doc shape:
  {
    remainingMs: Number,
    updatedAt: Number,
    resumes: Number,        // number of times the user closed/refresh-resumed
    startedAt: Number,
    cur: Number,
    paperIds: [qId,...],
    answers: { qId: choice, ... },
    flags: { qId:true, ... }
  }
*/

// Save session state to Firestore (merge)
// helper: get public IP (cached so we don't call API every save)
let cachedIP = null;
async function getUserIP() {
  if (cachedIP) return cachedIP;
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    cachedIP = data.ip;
    return cachedIP;
  } catch (e) {
    console.warn("⚠️ Failed to fetch IP", e);
    cachedIP = "unknown";
    return cachedIP;
  }
}

async function saveSessionToFirestore(username, state = null, paper = null) {
  if (!username) return false;
  try {
    // ✅ Ensure IP is fetched once per user session
    if (!EXAM.state.ip) {
      EXAM.state.ip = await getUserIP();
    }

    // Build payload: lightweight snapshot to reconstruct session
    const payload = {
      remainingMs: state?.remainingMs ?? EXAM.state?.remainingMs ?? 0,
      updatedAt: Date.now(),
      startedAt: state?.startedAt ?? EXAM.state?.startedAt ?? Date.now(),
      cur: state?.cur ?? EXAM.cur ?? 0,
      paperIds: paper ? paper.map(p => p.id) : (EXAM.paper ? EXAM.paper.map(p => p.id) : []),
      answers: state?.answers ?? EXAM.state?.answers ?? {},
      flags: state?.flags ?? EXAM.state?.flags ?? {},
      locked: (state && state.hasOwnProperty('locked'))
          ? !!state.locked
          : (!state?.submitted && !!(typeof examPaused !== 'undefined' && examPaused)),
      ip: EXAM.state.ip || "unknown"   // ✅ add IP here
    };

    // Optional unlock metadata
    if (state?.unlockedBy) payload.unlockedBy = state.unlockedBy;
    if (state?.unlockedAt) payload.unlockedAt = state.unlockedAt;

    await setDoc(doc(db, "sessions", username), payload, { merge: true });
    return true;
  } catch (err) {
    console.warn("⚠️ Could not save session:", err);
    return false;
  }
}

// --- heartbeat helpers (paste near other global helpers) ---
function startSessionHeartbeat(sessionId, intervalMs = 20000) {
  if (!sessionId) {
    console.warn('startSessionHeartbeat: no sessionId provided');
    return () => {};
  }
  if (typeof setDoc !== 'function' || typeof doc !== 'function' || typeof db === 'undefined') {
    console.warn('startSessionHeartbeat: Firestore helpers not available');
    return () => {};
  }
  const key = `hb_${sessionId}`;
  if (window[key]) return window[key].stop; // already running
  const writeNow = () => {
    try {
      setDoc(doc(db, "sessions", sessionId), { updatedAt: Date.now() }, { merge: true })
        .catch(()=>{});
    } catch (err) {}
  };
  writeNow();
  const id = setInterval(writeNow, intervalMs);
  const stopper = () => {
    clearInterval(id);
    try { delete window[key]; } catch(e){}
  };
  window[key] = { id, stop: stopper };
  return stopper;
}

function stopSessionHeartbeat(sessionId) {
  const key = `hb_${sessionId}`;
  if (window[key] && typeof window[key].stop === 'function') {
    window[key].stop();
  }
}


// Increment resume counter atomically (client-side simple approach)
async function incrementSessionResumeCount(username) {
  if (!username) return;
  try {
    const ref = doc(db, "sessions", username);
    // read existing
    const snap = await getDoc(ref);
    let current = 0;
    if (snap.exists()) {
      const d = snap.data();
      current = Number(d.resumes || 0);
    }
    const updated = current + 1;
    await setDoc(ref, { resumes: updated, updatedAt: Date.now() }, { merge: true });
    // console.log("↩ Resumes for", username, "->", updated);
    return updated;
  } catch (err) {
    console.warn("⚠️ Failed to increment resume count:", err);
    return null;
  }
}

// Load full session doc and return object (or null)
async function loadSessionDoc(username) {
  if (!username) return null;
  try {
    const snap = await getDoc(doc(db, "sessions", username));
    if (!snap.exists()) return null;
    return snap.data();
  } catch (err) {
    console.warn("⚠️ Failed to load session doc:", err);
    return null;
  }
}

/* Hook into unload/refresh so we save current state and increment resume counter.
   This will run when user refreshes or closes page. We use navigator.sendBeacon if
   available for more reliable background sending; otherwise fall back to async setDoc.
*/
window.addEventListener("beforeunload", async (ev) => {
  // If exam in progress and not submitted, save session and increment counter
  if (EXAM.state && !EXAM.state.submitted) {
    try {
      // first save the lightweight session
      await saveSessionToFirestore(EXAM.state.username);
      // increment resume counter (best-effort)
      // Don't `await` increment when using sendBeacon; work best-effort
      incrementSessionResumeCount(EXAM.state.username);
    } catch (err) {
      console.warn("⚠️ beforeunload save error", err);
    }
  }
  // no need to prevent unload
});

// also save periodically (every 10s) so we can resume with up-to-date state
let RESUME_SAVE_INTERVAL = null;
function startPeriodicSessionSave() {
  if (RESUME_SAVE_INTERVAL) clearInterval(RESUME_SAVE_INTERVAL);
  RESUME_SAVE_INTERVAL = setInterval(() => {
    if (EXAM.state && !EXAM.state.submitted) {
      saveSessionToFirestore(EXAM.state.username);
    }
  }, 10_000);
}
function stopPeriodicSessionSave() {
  if (RESUME_SAVE_INTERVAL) { clearInterval(RESUME_SAVE_INTERVAL); RESUME_SAVE_INTERVAL = null; }
}

/* Check whether user has exceeded max resume allowed (2)
   Returns true if allowed to start/resume, false if blocked.
*/
async function checkResumeLimitAllowed(username) {
  if (!username) return false;
  try {
    const sess = await loadSessionDoc(username);
    const count = (sess && Number(sess.resumes || 0)) || 0;
    const allowedMax = (settings && Number(settings.maxResumes)) || 2;
    return count < allowedMax;
  } catch (err) {
    console.warn("⚠️ checkResumeLimitAllowed failed", err);
    return true; // permissive on error
  }
}

/* Try to restore session for user (if session exists and resumeAllowed)
   This reconstructs EXAM.paper (based on existing question bank) and EXAM.state.
*/
async function tryRestoreSession(user) {
  if (!user || !user.username) return false;
  // Load session doc
  const sess = await loadSessionDoc(user.username);
  if (!sess) return false;

  // If no session.save data, nothing to restore
  if (!Array.isArray(sess.paperIds) || sess.paperIds.length === 0) return false;

  // Build a fresh EXAM.paper in the same order as saved (by IDs)
  const paper = sess.paperIds.map(id => {
    const q = questions.find(x => x.id === id);
    return q ? { id: q.id, question: q.question, options: q.options, answer: q.answer, marks: q.marks, category: q.category } : null;
  }).filter(Boolean);

  if (paper.length === 0) return false;

  // Set EXAM fields
  EXAM.paper = paper;
  EXAM.cur = typeof sess.cur === "number" ? sess.cur : 0;

  // Restore state object (answers / flags / remainingMs)
  EXAM.state = {
    username: user.username,
    answers: sess.answers || {},
    flags: sess.flags || {},
    startedAt: sess.startedAt || Date.now(),
    // Use settings.durationMin as source of truth if present; fallback to EXAM.cfg.durationMin
    durationMs: (Number(settings.durationMin || EXAM.cfg.durationMin) * 60_000) || (sess.remainingMs || 0),
    remainingMs: Number(sess.remainingMs || 0),
    submitted: false
  };

  // clamp remainingMs
  const durationMs = Math.max(1, Number(settings.durationMin || EXAM.cfg.durationMin)) * 60_000;
  EXAM.state.remainingMs = Math.min(Math.max(0, EXAM.state.remainingMs), durationMs);

  // show UI
  $('#examFullscreen').style.display = 'flex';
  $('#fsPhoto').src = user.photo || '';
  $('#fsName').textContent = user.fullName || user.username;
  paintQuestion();

  // start autosave and timers BEFORE attaching watcher so session doc exists
  startPeriodicSessionSave();
  startTimer();

  // --- Attach the session watcher here (after timers & autosave)
  try {
    // If a watcher already exists, stop it first to avoid duplicate listeners
    if (typeof stopSessionWatcher === 'function') {
      try { stopSessionWatcher(); } catch (e) { /* ignore */ }
    }

    if (typeof startSessionWatcher === 'function') {
      startSessionWatcher(EXAM.state.username);
      console.log('✅ startSessionWatcher attached for', EXAM.state.username);
    } else {
      console.warn('startSessionWatcher is not implemented — falling back to polling/fallback if any.');
      // Optionally start a polling fallback if you implemented it:
      if (typeof startPausedSessionPolling === 'function') {
        startPausedSessionPolling(EXAM.state.username, (s) => {
          // if your poller returns state, you can reuse the same unlock handler there
          // Example: if (s && s.locked === false) handleServerUnlock();
        });
      }
    }
  } catch (err) {
    console.warn('Error while attaching session watcher:', err);
  }

  return true;
}

/* ----------------------------
   Integrations: modify start/login flow
   ---------------------------- */

// 1) In handleUserLogin() we should check resume-limit before starting exam.
// Replace the call to startExam(user) with the code below (or modify handleUserLogin):
//  - If user has existing session and allowed -> ask to resume or start new
//  - If resume count >=2 -> block start
//  - If no session -> start normally

/* Example replacement inside handleUserLogin() (replace the `startExam(user)` line):
   -- IMPORTANT: If you already have startExam(user) call, replace it with the snippet below.
*/
async function handleUserLogin_withResume() {
  const username = $('#userName').value.trim();
  const pass = $('#userPass').value;
  const file = document.getElementById('userPhoto').files[0];

  if(!username || !pass) return alert('Enter username and password');

  let user = users.find(u => u.username === username && u.password === pass);
  if(!user){
    if(!file) return alert('New user: upload photo to register');
    const photo = await fileToDataURL(file);
    const fullName = username;
    user = { username, password: pass, photo, fullName };
    users.push(user);
    saveToFirestore("users", user.username, user);
  }

  // check if user already submitted via results
  const arr = await getResultsArray();
  if (arr.some(r => r.username === username)) {
    alert(`⚠️ "${username}" has already attempted the exam.`);
    return;
  }

  // ensure settings loaded
  await loadSettingsFromFirestore();

  // check resume limit
  const allowed = await checkResumeLimitAllowed(username, 2);
  if (!allowed) {
    alert(`⚠️ You have exceeded the maximum number of allowed refresh/close/resume actions (2). Login blocked.`);
    return;
  }

  // try to load session doc
  const sess = await loadSessionDoc(username);
  if (sess && sess.remainingMs && sess.remainingMs > 0) {
    // Ask user whether to resume. (If you prefer auto-resume, skip confirm).
    if (confirm("A saved session was found. Do you want to resume where you left off?")) {
      // restore
      const restored = await tryRestoreSession(user);
      if (restored) {
        // increment resume count — because user is resuming after a close/refresh
        const newCount = await incrementSessionResumeCount(username);
        // let admin know if near limit
        if (newCount >= 2) {
          alert(`⚠️ You have used ${newCount} resume(s). Further resumes will be blocked.`);
        }
        return;
      } else {
        // if restore failed, fallback to fresh start
        startExam(user);
        startPeriodicSessionSave();
        return;
      }
    } else {
      // user chose to start a fresh exam: clear previous session doc and start
      await setDoc(doc(db, "sessions", username), { remainingMs: 0, updatedAt: Date.now(), paperIds: [], answers: {}, flags: {}, resumes: 0 }, { merge: true });
      startExam(user);
      startPeriodicSessionSave();
      return;
    }
  }

  // no session -> start fresh
  startExam(user);
  startPeriodicSessionSave();
}

// Export wrapper so you can swap with existing handleUserLogin
window.handleUserLogin_withResume = handleUserLogin_withResume;

/* ----------------------------
   Integrate with startExam() / submitExam()
   ---------------------------- */

// When startExam(user) is called, we already set EXAM.state and EXAM.paper.
// After building EXAM.paper and EXAM.state inside startExam(), also save initial session:
async function _afterStartExamSaveSession(user) {
  if (!user || !user.username) return;
  // save the paper ids + state
  await saveSessionToFirestore(user.username, EXAM.state, EXAM.paper);
  // ensure periodic saves started
  startPeriodicSessionSave();
}

// Call _afterStartExamSaveSession(EXAM.state.username) near end of startExam()
// (or place one line: await saveSessionToFirestore(user.username); after paintQuestion(); startTimer();)

/* Also on successful final submit, clear the session so they can't resume */
async function _clearSessionAfterSubmit(username) {
  try {
    await setDoc(doc(db, "sessions", username), { remainingMs: 0, updatedAt: Date.now(), paperIds: [], answers: {}, flags: {}, resumes: 0 }, { merge: true });
  } catch (err) {
    console.warn("⚠️ failed to clear session after submit", err);
  }
}

// You should call _clearSessionAfterSubmit(EXAM.state.username) at the end of submitExam() after saving results.


function paintQuestion() {
  const q = EXAM.paper[EXAM.cur];
  if (!q) return;

  // ✅ Question text directly, no leading newline/space
  $('#fsQuestion').innerHTML =
    `${EXAM.cur+1}. (${q.category}) ${escapeHTML(q.question)}`;

  // render options
  const opts = $('#fsOptions'); 
  opts.innerHTML = '';

  q.options.forEach((opt, i) => {
    const d = document.createElement('div');
    d.className = 'fsOpt' + (EXAM.state.answers[q.id] === i ? ' selected' : '');

    // option text
    d.innerHTML = `
      <div style="width:28px;font-weight:800">${String.fromCharCode(65+i)}.</div>
      <div style="flex:1">${escapeHTML(opt)}</div>
    `;

    d.onclick = () => { 
      EXAM.state.answers[q.id] = i; 
      paintQuestion(); 
      updateProgress(); 
    };

    opts.appendChild(d);
  });

  // meta info
  $('#fsMeta').textContent = 
    `Question ${EXAM.cur+1} of ${EXAM.paper.length} • Answered: ${Object.keys(EXAM.state.answers).length}`;
  
  if (EXAM.state.flags[q.id]) {
    $('#fsMeta').textContent += " • ⚑ Flagged";
  }

  updateProgress();
  renderQuestionNav(); // refresh navigation buttons
updateStats();

}

function prevQuestion(){ if(EXAM.cur>0){ EXAM.cur--; paintQuestion(); } }
function nextQuestion(){ if(EXAM.cur < EXAM.paper.length - 1){ EXAM.cur++; paintQuestion(); } }

function toggleFlag(){ const q = EXAM.paper[EXAM.cur]; if(!q) return; EXAM.state.flags[q.id] = !EXAM.state.flags[q.id]; paintQuestion(); }

function updateProgress(){ const answered = Object.keys(EXAM.state.answers).length; const total = EXAM.paper.length; const pct = Math.round((answered/total) * 100); $('#fsProgressFill').style.width = pct + '%'; }

/* NEW: Question navigator */
function renderQuestionNav(){
  const nav = document.getElementById('questionNav');
  nav.innerHTML = '';
  EXAM.paper.forEach((q,i)=>{
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = i+1;
    // mark answered
    if(EXAM.state.answers[q.id] !== undefined) btn.style.background = '#34d399';
    // highlight current
    if(i === EXAM.cur) btn.style.outline = '2px solid #60a5fa';
    btn.onclick = ()=>{ EXAM.cur = i; paintQuestion(); };
    nav.appendChild(btn);
  });
}

/* Timer */
function startTimer() {
  stopTimer();
  const end = Date.now() + EXAM.state.remainingMs;
  updateTimerText();

  EXAM.timerId = setInterval(async () => {
    EXAM.state.remainingMs = end - Date.now();

    if (EXAM.state.remainingMs <= 0) {
      EXAM.state.remainingMs = 0;
      stopTimer();
      if (settings.allowAfterTime) {
        // allow late submission if enabled
      } else {
        submitExam(true);
      }
    }

    // ✅ Update both timer text + progress bar
    updateTimerText();

    // 🔹 Save timer to Firestore every 10s (for resume feature)
    if (
      Math.floor(EXAM.state.remainingMs / 10000) !==
      Math.floor((EXAM.state.remainingMs + 500) / 10000)
    ) {
      try {
        await setDoc(
          doc(db, "timers", EXAM.state.username),
          { remainingMs: EXAM.state.remainingMs, updatedAt: Date.now() },
          { merge: true }
        );
        console.log("⏳ Timer saved for", EXAM.state.username);
      } catch (err) {
        console.warn("⚠️ Could not save timer:", err);
      }
    }
  }, 500);
}

/* Update timer text + progress bar */
function updateTimerText() {
  const ms = Math.max(0, EXAM.state.remainingMs || 0);
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);

  // Timer text
  const timerEl = document.getElementById("fsTimer");
  if (timerEl) {
    timerEl.textContent =
      `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  // Progress bar
  const fill = document.getElementById("timerProgressFill");
  if (fill && EXAM.state.durationMs) {
    const pct = (ms / EXAM.state.durationMs) * 100;
    fill.style.width = pct + "%";

    if (pct > 60) {
      fill.style.background = "linear-gradient(90deg,#34d399,#60a5fa)";
    } else if (pct > 30) {
      fill.style.background = "linear-gradient(90deg,#facc15,#f97316)";
    } else {
      fill.style.background = "linear-gradient(90deg,#f87171,#dc2626)";
    }
  }
}


// ---- Lock / unlock helpers (improved) ----
async function lockExamForUser(reason = '') {
  if (!EXAM.state || !EXAM.state.username) return;
  try {
    EXAM.state.locked = true;
    EXAM.state.lockReason = reason || '';
    // save immediately so admin sees it
    if (typeof saveSessionToFirestore === 'function') {
      await saveSessionToFirestore(EXAM.state.username, EXAM.state, EXAM.paper);
    } else {
      // fallback: write minimal payload
      await setDoc(doc(db, "sessions", EXAM.state.username), {
        locked: true,
        lockReason: EXAM.state.lockReason,
        updatedAt: Date.now()
      }, { merge: true });
    }
  } catch (err) {
    console.warn("lockExamForUser: failed to persist session", err);
  }

  // show lock UI locally (if not shown already)
  try { $('#lockScreen').style.display = 'flex'; } catch(e){}

  // Force refresh admin sessions instantly (if admin is viewing)
  if (window.IS_ADMIN && typeof renderSessionsAdmin === 'function') {
    try { renderSessionsAdmin(); } catch (e) { console.warn(e); }
  }
}

async function unlockExamForUser() {
  if (!EXAM?.state || !EXAM.state.username) return;
  const username = EXAM.state.username;

  // inside unlockExamForUser / unlockExam — use this snippet to replace the save/persist lines
try {
  // update local state first
  EXAM.state.locked = false;
  EXAM.state.lockReason = '';

  const payload = {
    locked: false,
    unlockedBy: (window.ADMIN_NAME || window.currentAdmin || "admin"),
    unlockedAt: Date.now(),
    updatedAt: Date.now()
  };

  // Use object spread — this is valid JS and will merge EXAM.state + payload
  if (typeof saveSessionToFirestore === 'function') {
    await saveSessionToFirestore(username, { ...EXAM.state, ...payload }, EXAM.paper);
  } else {
    await setDoc(doc(db, "sessions", username), payload, { merge: true });
  }
} catch (err) {
  console.warn("unlockExamForUser: failed to persist session", err);
}


  // hide lock UI locally (works whether you use $ or plain DOM)
  try {
    const el = document.getElementById('lockScreen');
    if (el) el.style.display = 'none';
  } catch (e) { /* ignore */ }

  // If this client was the locked user, resume timer/UI
  try {
    if (EXAM && EXAM.state && EXAM.state.username === username) {
      if (examPaused) {
        examPaused = false;
        try { startTimer(); } catch (e) { console.warn("startTimer failed:", e); }
        try { startPeriodicSessionSave(); } catch (e) {}
      }
      EXAM.state.locked = false;
    }
  } catch (e) {
    console.warn("unlockExamForUser: resume UI error", e);
  }

  // Refresh admin view if present
  if (window.IS_ADMIN && typeof renderSessionsAdmin === 'function') {
    try { renderSessionsAdmin(); } catch (e) { console.warn(e); }
  }

  // Stop only the poller fallback (keep realtime watcher active)
  if (typeof stopPausedSessionPolling === 'function') stopPausedSessionPolling();

 
  // Only call stopSessionWatcher() when the exam session ends (submit) or user logs out.
}

// Optional: also lock when tab/window becomes hidden (user switched tab)
document.addEventListener('visibilitychange', async () => {
  try {
    if (document.visibilityState === 'hidden' && EXAM.state && !EXAM.state.submitted) {
      await lockExamForUser('visibility-hidden');
    }
  } catch (e) {
    console.warn('visibilitychange handler error', e);
  }
});
// ---------- Realtime session watcher (more reliable than polling) ----------
let SESSION_UNSUBSCRIBE = null;

function startSessionWatcher(username) {
  try {
    // unsubscribe previous listener if present (safe re-subscribe behavior)
    if (SESSION_UNSUBSCRIBE) {
      try { SESSION_UNSUBSCRIBE(); } catch(e) {}
      SESSION_UNSUBSCRIBE = null;
    }

    if (!username) return;
    const ref = doc(db, "sessions", username);

    // Attach realtime listener and KEEP it active (do NOT unsubscribe inside the callback)
    SESSION_UNSUBSCRIBE = onSnapshot(ref, snap => {
      try {
        if (!snap.exists()) return;
        const s = snap.data();
        console.log("session watcher:", username, s);

        if (s.locked) {
          // When locked: show lock UI and stop timer
          examPaused = true;
          if (typeof stopPausedSessionPolling === 'function') stopPausedSessionPolling();
          if (document.getElementById("lockScreen")) {
            document.getElementById("lockScreen").style.display = "flex";
          }
          if (EXAM && EXAM.timerId) {
            clearInterval(EXAM.timerId);
            EXAM.timerId = null;
          }
          // keep listening for unlock events
          return;
        }

        // When unlocked: resume UI & timer (use server state as source-of-truth)
        // stop poller (compat) and resume user UI
        if (typeof stopPausedSessionPolling === 'function') stopPausedSessionPolling();

        if (document.getElementById("lockScreen")) {
          document.getElementById("lockScreen").style.display = "none";
        }

        // If the local client was paused, resume timer and state
        if (examPaused) {
          examPaused = false;
          // update local EXAM.state so future saves reflect unlocked
          if (EXAM && EXAM.state) EXAM.state.locked = false;

          // attempt to restart timer and periodic saves (your implementations)
          try { startTimer(); } catch (e) { console.warn("startTimer failed:", e); }
          try { startPeriodicSessionSave(); } catch (e) { console.warn("startPeriodicSessionSave failed:", e); }

          console.info("✅ Unlocked by admin — resuming exam.");
        } else {
          // Not paused locally but server says unlocked — ensure local state matches
          if (EXAM && EXAM.state) EXAM.state.locked = false;
        }
        // IMPORTANT: DO NOT unsubscribe here — keep listening for future events
      } catch (err) {
        console.warn("session watcher callback error", err);
      }
    }, err => {
      console.warn("session watcher onSnapshot error:", err);
      // If snapshot repeatedly fails, fall back to poller
      if (typeof startPausedSessionPolling === 'function') startPausedSessionPolling(username);
    });
  } catch (err) {
    console.warn("startSessionWatcher failed:", err);
    if (typeof startPausedSessionPolling === 'function') startPausedSessionPolling(username);
  }
}

function stopSessionWatcher() {
  try {
    if (SESSION_UNSUBSCRIBE) { SESSION_UNSUBSCRIBE(); SESSION_UNSUBSCRIBE = null; }
  } catch (e) { /* ignore */ }
}

function stopTimer(){ if(EXAM.timerId){ clearInterval(EXAM.timerId); EXAM.timerId = null; } }
function updateTimerText(){ const ms = Math.max(0, EXAM.state.remainingMs); $('#fsTimer').textContent = msToTime(ms); }
function msToTime(ms){ const s = Math.floor(ms/1000); const hh = String(Math.floor(s/3600)).padStart(2,'0'); const mm = String(Math.floor((s%3600)/60)).padStart(2,'0'); const ss = String(s%60).padStart(2,'0'); return `${hh}:${mm}:${ss}`; }

/* Submit exam: calculate marks, per-section scores, save results, show percent & progress bar only */
function renderQuestionNav(){
  const nav = document.getElementById('questionNav');
  nav.innerHTML = '';
  EXAM.paper.forEach((q,i)=>{
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = i+1;
    if(EXAM.state.answers[q.id] !== undefined) {
  btn.style.background = '#34d399'; // green if answered
}
if(EXAM.state.flags[q.id]) {
  btn.style.border = '2px solid orange'; // orange border for flagged
}
if(i === EXAM.cur) {
  btn.style.outline = '2px solid #60a5fa'; // blue outline for current
}

    btn.onclick = ()=>{ EXAM.cur = i; paintQuestion(); };
    nav.appendChild(btn);
  });
}

async function submitExam(auto = false) {
  if (!auto && !confirm('Submit exam now?')) return;

  // 🔒 Limit attempts (max 1 per user)
  const MAX_ATTEMPTS = 1;
  const arr = await getResultsArray();
  const userAttempts = arr.filter(r => r.username === EXAM.state.username);
  if (userAttempts.length >= MAX_ATTEMPTS) {
    alert(`⚠️ User "${EXAM.state.username}" has already attempted the exam ${MAX_ATTEMPTS} time(s).`);
    $('#examFullscreen').style.display = 'none';
    showSection('user');
    return;
  }

  stopTimer();

  // --- scoring logic (unchanged) ---
  const paper = EXAM.paper;
  let totalMarks = 0, earned = 0;
  const sectionScores = { 'Synopsis': 0, 'Minor Practical': 0, 'Major Practical': 0, 'Viva': 0 };

  paper.forEach(q => {
    totalMarks += (q.marks || 1);
    const chosen = EXAM.state.answers[q.id];
    if (q.category === "Major Practical") {
      if (chosen === 0) { earned += q.marks; sectionScores[q.category] += q.marks; }
      else if (chosen === 1) { const val = Math.round(q.marks * 0.75); earned += val; sectionScores[q.category] += val; }
      else if (chosen === 2) { const val = Math.round(q.marks * 0.5); earned += val; sectionScores[q.category] += val; }
    } else {
      if (chosen === q.answer) {
        earned += (q.marks || 1);
        sectionScores[q.category] = (sectionScores[q.category] || 0) + (q.marks || 1);
      }
    }
  });

  earned = Math.round(earned);
  Object.keys(sectionScores).forEach(k => { sectionScores[k] = Math.round(sectionScores[k]); });
  const percent = Math.round((earned / Math.max(1, totalMarks)) * 100);

  // 🔹 Save results securely
  try {
    let currentResults = Array.isArray(results) ? results : [];
    const record = {
      username: EXAM.state.username,
      totalScorePercent: percent,
      sectionScores,
      timestamp: Date.now()
    };
    currentResults.push(record);

    const encryptedResults = await encryptData(currentResults);
    write(K_RESULTS, encryptedResults);
    try { await setDoc(doc(db, "results", "all"), { data: encryptedResults }); } catch {}

    results = currentResults;
    if (typeof renderResults === 'function') renderResults();
    download(`results_${EXAM.state.username}_${Date.now()}.json`, JSON.stringify(encryptedResults, null, 2), 'application/json');
  } catch (err) {
    console.error("❌ Error while saving results:", err);
  }

  // ✅ Prevent lock or pause after submission
  EXAM.state.submitted = true;
  EXAM.state.locked = false;
  EXAM.state.unlockedBy = "system";
  EXAM.state.unlockedAt = Date.now();

  // 🛑 Stop any watchers or autosaves
  try {
    if (typeof stopSessionWatcher === 'function') stopSessionWatcher(EXAM.state.username);
  } catch (e) { console.warn('stopSessionWatcher failed', e); }
  stopPeriodicSessionSave();
  stopSessionHeartbeat(EXAM.state.username);
  stopExamStream();

  // ✅ Save final unlocked state (do NOT delete session)
  await saveSessionToFirestore(EXAM.state.username, EXAM.state, EXAM.paper);

  // (optional) clear local cache only
  try { localStorage.removeItem("exam_session_" + EXAM.state.username); } catch(e){}

  // 🎉 Show final score
  $('#fsQuestion').innerHTML = `
    <div style="text-align:center;font-size:22px;font-weight:900">
      Your Score: ${percent}%
    </div>
    <div id="redirectMsg" style="text-align:center;margin-top:10px;font-size:14px;color:var(--muted)">
      Redirecting in 5s...
    </div>
  `;
  $('#fsOptions').innerHTML = `<div class="progress-bar"><div class="progress-fill" style="width:${percent}%"></div></div>`;
  document.querySelectorAll('.fsFooter').forEach(el => el.style.display = 'flex');

  let secs = 5;
  const msgEl = document.getElementById('redirectMsg');
  const countdown = setInterval(() => {
    secs--;
    msgEl.textContent = secs > 0 ? `Redirecting in ${secs}s...` : '';
    if (secs <= 0) {
      clearInterval(countdown);
      $('#examFullscreen').style.display = 'none';
      showSection('user');
    }
  }, 1000);
}


/* Close fullscreen and return to main page (reload to refresh admin view) */
function closeFullscreen() { 
  stopTimer(); 
  $('#examFullscreen').style.display = 'none'; 
  location.reload(); 
}

/* ---------- ADMIN: login, CRUD, import/export, results ---------- */

function handleAdminLogin(){
  const pass = $('#adminPass').value;
  const stored = read(K_ADMIN, null);

  if(stored && stored.password === pass){ 
    enterAdmin(); 
    renderAdminAnnouncementsLive();   // 🔑 start live announcements in admin panel
    return; 
  }
  if(pass === MASTER_ADMIN.password){ 
    enterAdmin(); 
    renderAdminAnnouncementsLive();   // 🔑 same for master admin
    return; 
  }
  alert('Invalid admin password');
}


function enterAdmin(){
  // show admin panel
  showSection('adminPanel');

  // mark admin state and enable the sessions UI (only visible to admins)
  window.IS_ADMIN = true;
  if (typeof enableAdminSessionsUI === 'function') {
    enableAdminSessionsUI(true);
  } else {
    console.warn('enableAdminSessionsUI not found - ensure helper is loaded');
  }

  // render admin content
  renderQuestionsList();
  renderUsersAdmin();
  renderResults();
  renderSettingsAdmin();
}

/* Call this when admin logs out / clicks Back */
function logoutAdmin() {
  // clear admin state and hide admin-only UI
  window.IS_ADMIN = false;
  if (typeof enableAdminSessionsUI === 'function') {
    enableAdminSessionsUI(false);
  }
  // show the default user/home section
  showSection('user'); // or 'home' depending on your flow
}

/* Questions CRUD in admin */
let editingId = null;
/* ---------- Save Question ---------- */
async function saveQuestion() {
  const text = $('#qText').value.trim();
  const opts = [$('#qA').value.trim(), $('#qB').value.trim(), $('#qC').value.trim(), $('#qD').value.trim()];
  const ans = parseInt($('#qAnswer').value) || 0;
  const marks = parseInt($('#qMarks').value) || 1;
  const category = $('#qCategory').value;

  if (!text || opts.some(o => !o)) {
    alert('⚠️ Fill question and all 4 options');
    return;
  }

  const q = {
    id: editingId || uid(),
    question: text,
    options: opts,
    answer: ans,
    marks,
    category
  };

  if (editingId) {
    questions = questions.map(x => x.id === q.id ? q : x);
    editingId = null;
  } else {
    questions.push(q);
  }

  write(K_QS, questions);

  try {
   await setDoc(doc(db, "questions", q.id), q);
await loadQuestionsFromFirestore();  // ✅ reload latest from Firestore
renderQuestionsList();


    console.log(`✅ Firestore saved: questions/${q.id}`);
    alert("✅ Question saved to Firebase + localStorage!");
  } catch (err) {
    console.error("❌ Firestore error:", err);
    alert("⚠️ Question saved offline only.\nError: " + err.message);
  }

  clearQuestionForm();
  renderQuestionsList();
}

function clearQuestionForm(){ editingId = null; $('#qText').value=''; $('#qA').value=''; $('#qB').value=''; $('#qC').value=''; $('#qD').value=''; $('#qMarks').value=1; $('#qAnswer').value='0'; $('#qCategory').value='Synopsis'; }
function cancelEdit(){ clearQuestionForm(); }
function renderQuestionsList() {
  const out = $('#questionsList'); 
  out.innerHTML = '';
  if (questions.length === 0) { 
    out.innerHTML = '<div class="small">No questions yet.</div>'; 
    return; 
  }

  questions.forEach((q, i) => {
    const wrapper = document.createElement('div'); 
    wrapper.className = 'list-item';

    const textDiv = document.createElement('div');
    textDiv.style.flex = '1';

    textDiv.innerHTML = `
      <b>${i+1}. [${q.category}]</b>
      <div class="admin-question-text">${escapeHTML(q.question)}</div>
      <div class="small">A) ${escapeHTML(q.options[0])} 
      • B) ${escapeHTML(q.options[1])} 
      • C) ${escapeHTML(q.options[2])} 
      • D) ${escapeHTML(q.options[3])}</div>
      <div class="small">Marks: ${q.marks}</div>
    `;

    const editBtn = document.createElement('button'); 
    editBtn.className = 'btn'; 
    editBtn.textContent = 'Edit'; 
    editBtn.onclick = () => { loadQuestionToForm(q.id); };

    const delBtn = document.createElement('button'); 
    delBtn.className = 'btn danger'; 
    delBtn.textContent = 'Delete'; 
    delBtn.onclick = () => deleteQuestion(q.id);

    wrapper.appendChild(textDiv);
    wrapper.appendChild(editBtn);
    wrapper.appendChild(delBtn);

    out.appendChild(wrapper);
  });
}

function loadQuestionToForm(id){
  const q = questions.find(x=>x.id===id); if(!q) return;
  editingId = q.id;
  $('#qText').value = q.question; $('#qA').value=q.options[0]; $('#qB').value=q.options[1]; $('#qC').value=q.options[2]; $('#qD').value=q.options[3];
  $('#qAnswer').value = String(q.answer); $('#qMarks').value = String(q.marks); $('#qCategory').value = q.category;

}
// Replace existing clearAllQuestions() with this:
async function clearAllQuestions(){
  if(!confirm('Delete ALL questions? This will remove local copy AND try to remove all questions from Firestore. This cannot be undone.')) return;

  // 1) Clear local copy & UI immediately
  questions = [];
  try { write(K_QS, questions); } catch(e){ console.warn('Could not update localStorage after clearing questions:', e); }
  try { renderQuestionsList(); } catch(e){ console.warn('renderQuestionsList error', e); }

  // 2) Try to remove from Firestore (best-effort)
  try {
    // ensure firestore helpers are ready
    const ready = await (window._firestoreReadyPromise || Promise.resolve(false));
    if (!ready || typeof collection === 'undefined' || typeof getDocs === 'undefined' || typeof db === 'undefined') {
      console.warn('Firestore not ready or helpers missing - skipped remote delete.');
      alert('Local questions cleared. Firestore not available — remote delete skipped.');
      return;
    }

    // fetch all question docs
    const colRef = collection(db, 'questions');
    const snap = await getDocs(colRef);
    if (snap.empty) {
      console.log('No remote questions found - nothing to delete.');
      alert('All questions cleared locally. No remote questions found.');
      return;
    }

    // Use batch delete in chunks of 500 (Firestore limit)
    const docs = [];
    snap.forEach(docSnap => docs.push(docSnap));
    const BATCH_SIZE = 500;
    let deleted = 0;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const chunk = docs.slice(i, i + BATCH_SIZE);
      // prefer writeBatch if available
      if (typeof writeBatch === 'function') {
        const batch = writeBatch(db);
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
        deleted += chunk.length;
        console.log(`Batch deleted ${chunk.length} docs (${deleted}/${docs.length})`);
      } else {
        // fallback: deleteDoc one-by-one
        for (const d of chunk) {
          await deleteDoc(doc(db, 'questions', d.id));
          deleted++;
        }
        console.log(`Individually deleted ${chunk.length} docs (${deleted}/${docs.length})`);
      }
    }

    alert(`All questions removed locally. Attempted remote delete and removed ${deleted} remote documents (check console).`);
    // final re-render
    if (typeof renderQuestionsList === 'function') renderQuestionsList();

  } catch (err) {
    console.error('clearAllQuestions: Firestore delete error', err);
    // common cause: security rules / insufficient permissions
    alert('Questions cleared locally, but remote delete failed. See console for details (likely Firestore rules / permissions).');
  }
}


/* ---------------- USERS ADMIN ---------------- */
async function toDataURL(file){ 
  return new Promise(res => { 
    const fr = new FileReader(); 
    fr.onload = ()=> res(fr.result); 
    fr.readAsDataURL(file); 
  }); 
}

/* ---------- Create / Update User ---------- */
async function adminCreateUser(){
  const u = $('#adminNewUser').value.trim(); 
  const fName = $('#adminNewFull').value.trim();
  const p = $('#adminNewPass').value; 
  const f = $('#adminNewPhoto').files[0];

  if(!u || !p) return alert('⚠️ Username & password required');

  const photo = f ? await toDataURL(f) : '';
  const obj = { username: u, fullName: fName, password: p, photo };

  const idx = users.findIndex(x=>x.username===u);
  if(idx >= 0) {
    // update existing
    if(photo) obj.photo = photo; else obj.photo = users[idx].photo;
    users[idx] = obj;
  } else {
    users.push(obj);
  }

  // Save offline
  write(K_USERS, users);
  renderUsersAdmin();

  // Save online (Firestore)
  try {
    await setDoc(doc(db, "users", obj.username), obj);
    console.log(`✅ Firestore saved: users/${obj.username}`);
    alert(`✅ User "${obj.username}" saved to Firebase + localStorage!`);
  } catch (err) {
    console.error("❌ Firestore error (users):", err);
    alert(`⚠️ User "${obj.username}" saved offline only.\nError: ${err.message}`);
  }

  // clear form
  $('#adminNewUser').value='';
  $('#adminNewFull').value='';
  $('#adminNewPass').value='';
  $('#adminNewPhoto').value='';
}

function adminEditUser(i){
  const u = users[i];
  $('#adminNewUser').value = u.username;
  $('#adminNewFull').value = u.fullName || '';
  $('#adminNewPass').value = u.password;
  // photo left blank so admin can choose new one
}
async function adminDeleteUser(i) {
  if (!confirm("Delete this user?")) return;

  try {
    const u = users[i];

    // Remove locally first
    users.splice(i, 1);
    write(K_USERS, users);
    renderUsersAdmin();

    // Remove from Firestore as well
    if (typeof deleteDoc === "function" && typeof doc === "function" && typeof db !== "undefined") {
      try {
        await deleteDoc(doc(db, "users", u.username));
        console.log("✅ Firestore: deleted users/" + u.username);
      } catch (err) {
        console.warn("⚠️ Firestore user delete failed:", err);
        alert("User deleted locally but Firestore delete failed. Check console and Firestore rules.");
      }
    } else {
      console.warn("Firestore not available — skipped Firestore delete.");
    }
  } catch (err) {
    console.error("adminDeleteUser error:", err);
    alert("Something went wrong while deleting the user. See console.");
  }
}


function renderUsersAdmin(){
  const box = $('#adminUsersList');
  box.innerHTML = '';
  users.forEach((u, i) => {
    const div = document.createElement('div');
    div.className = 'userRow';
    div.innerHTML = `
      <img src="${u.photo || ''}" class="userPhoto">
      <span><b>${u.fullName || ''}</b> (${u.username})</span>
      <button onclick="adminEditUser(${i})">Edit</button>
      <button onclick="adminDeleteUser(${i})">Delete</button>
    `;
    box.appendChild(div);
  });
}
async function renderSessionsAdmin() {
  try {
    const snap = await getDocs(collection(db, "sessions"));
    const out = document.getElementById("sessionsList");
    if (!out) return;

    // Collect docs, keep only valid data, normalize remainingMs to Number
    const arr = snap.docs
      .map(d => {
        const data = d.data();
        if (!data) return null;
        return {
          id: d.id,
          remainingMs: Number(data.remainingMs ?? 0),
          submitted: !!data.submitted,
          // copy other fields if needed: ...data
          ...data
        };
      })
      .filter(Boolean)
      // only active, not yet submitted sessions
      .filter(s => s.remainingMs > 0 && !s.submitted)
      // sort by remaining time ascending (soonest to finish first)
      .sort((a, b) => a.remainingMs - b.remainingMs);

    out.innerHTML = "";

    if (arr.length === 0) {
      out.innerHTML = `<div class="small">No one is giving exam</div>`;
      return;
    }

    // Use a fragment for better performance on many items
    const frag = document.createDocumentFragment();

    arr.forEach(s => {
      const div = document.createElement("div");
      div.className = "list-item";

      // left column: id + minutes left — use textContent to avoid XSS
      const left = document.createElement("div");
      left.style.flex = "1";

      const idEl = document.createElement("b");
      idEl.textContent = s.id;

      const mins = Math.max(0, Math.round((s.remainingMs || 0) / 60000));
      const small = document.createElement("span");
      small.className = "small";
      small.textContent = ` • ${mins} min left`;

      left.appendChild(idEl);
      left.appendChild(small);

      // watch button (safer than inline onclick string)
      const btn = document.createElement("button");
      btn.className = "btn brand";
      btn.type = "button";
      btn.textContent = "👀 Watch";
      btn.addEventListener("click", () => {
        if (typeof watchLiveSession === "function") {
          watchLiveSession(s.id);
        } else {
          console.warn("watchLiveSession is not defined");
        }
      });

      div.appendChild(left);
      div.appendChild(btn);

      frag.appendChild(div);
    });

    out.appendChild(frag);

  } catch (err) {
    console.warn("renderSessionsAdmin error", err);
    // show a visible message in UI so admins know something went wrong
    const out = document.getElementById("sessionsList");
    if (out) out.innerHTML = `<div class="small">Error loading sessions (see console)</div>`;
  }
}
window.renderSessionsAdmin = renderSessionsAdmin;

function watchLiveSession(username) {
  alert("🔴 Opening live feed for " + username);
  // For now just show their remote video (if streamed)
  const remote = document.getElementById("remoteVideo");
  if (remote) {
    remote.style.display = "block";
    remote.scrollIntoView({ behavior: "smooth" });
  }
  // TODO: hook this to actual WebRTC/Zoom stream if integrated
}
window.watchLiveSession = watchLiveSession;


function adminClearUsers(){ if(!confirm('Delete ALL users?')) return; users = []; write(K_USERS, users); renderUsersAdmin(); }

/* Results admin */
// Replace existing renderResults() with this improved version
async function renderResults() {
  const out = $('#resultsArea');
  out.innerHTML = '<div class="small">Loading latest results…</div>';

  // Helper to render decrypted array to table
  function renderTable(decrypted) {
    if (!Array.isArray(decrypted) || decrypted.length === 0) {
      out.innerHTML = '<div class="small">No results yet</div>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>User</th><th>Total %</th><th>Synopsis</th><th>Minor Practical</th><th>Major Practical</th><th>Viva</th><th>Time</th></tr>';
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    decrypted.forEach(r => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.username || ''}</td>
        <td>${r.totalScorePercent ?? ''}</td>
        <td>${(r.sectionScores && r.sectionScores['Synopsis']) || 0}</td>
        <td>${(r.sectionScores && r.sectionScores['Minor Practical']) || 0}</td>
        <td>${(r.sectionScores && r.sectionScores['Major Practical']) || 0}</td>
        <td>${(r.sectionScores && r.sectionScores['Viva']) || 0}</td>
        <td>${r.timestamp ? new Date(r.timestamp).toLocaleString() : ''}</td>
      `;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    out.innerHTML = '';
    out.appendChild(table);
  }

  // 1) Try Firestore first (if initialized)
  try {
    // ensure db, getDoc and doc are available (imported)
    if (typeof db === 'undefined' || typeof getDoc !== 'function' || typeof doc !== 'function') {
      console.warn('Firestore not available or getDoc/doc not imported — falling back to local storage');
      throw new Error('firestore-not-ready');
    }

    const docRef = doc(db, "results", "all");
    const snap = await getDoc(docRef);

    if (snap && snap.exists && typeof snap.exists === 'function' ? snap.exists() : false) {
      const snapData = snap.data();
      const enc = snapData && snapData.data;
      if (enc) {
        try {
          const decrypted = await decryptData(enc);
          // update local storage and in-memory variable
          const encryptedLocal = await encryptData(decrypted);
          write(K_RESULTS, encryptedLocal);
          results = decrypted;
          console.log("✅ Loaded results from Firestore and updated local storage");
          renderTable(decrypted);
          return;
        } catch (err) {
          console.warn("⚠️ Could not decrypt Firestore results:", err);
          // continue to fallback below
        }
      } else {
        console.log("ℹ️ Firestore doc exists but has no `.data` field (results/all).");
      }
    } else {
      console.log("ℹ️ No results found in Firestore (results/all)");
    }
  } catch (err) {
    // Inspect error but continue to local storage fallback
    if (err && err.message !== 'firestore-not-ready') {
      console.warn("⚠️ Firestore read failed (renderResults):", err);
    }
  }

  // 2) Fallback: use local storage K_RESULTS
  let stored = read(K_RESULTS, null);
  if (!stored) {
    out.innerHTML = '<div class="small">No results yet</div>';
    return;
  }
  try {
    const decrypted = await decryptData(stored);
    results = decrypted;
    renderTable(decrypted);
    console.log("✅ Loaded results from local storage");
  } catch (err) {
    out.innerHTML = '<div class="small danger">⚠️ Failed to decrypt results</div>';
    console.error("renderResults decrypt error:", err);
  }
}

/* ---------------------------
   Show Live Sessions only after Admin login
--------------------------- */
// Minimal implementation — adjust field mapping to your app
async function loadResultsFromFirestore() {
  try {
    console.log("loadResultsFromFirestore -> fetching results...");
    const snap = await getDocs(collection(db, "results"));
    const results = [];
    snap.forEach(d => {
      const obj = d.data();
      obj._id = d.id;
      results.push(obj);
    });

    // Save to local storage (your app expects this)
    localStorage.setItem("results", JSON.stringify(results));
    console.log("✅ Loaded results from Firestore and updated local storage");
    return results;
  } catch (err) {
    console.error("loadResultsFromFirestore error:", err);
    throw err;
  }
}
// Realtime listener helpers for sessions (start/stop)
let SESSIONS_ONSNAP_UNSUB = null;

function startSessionsRealtimeListener() {
  try {
    if (typeof onSnapshot !== 'function' || typeof collection !== 'function' || typeof db === 'undefined') {
      console.warn('startSessionsRealtimeListener: Firestore helpers not available');
      return;
    }
    if (SESSIONS_ONSNAP_UNSUB) return; // already started

    const colRef = collection(db, "sessions");
    SESSIONS_ONSNAP_UNSUB = onSnapshot(colRef, snap => {
      if (typeof renderSessionsAdmin === 'function') {
        // call but don't block the listener — handle promise errors
        Promise.resolve().then(() => renderSessionsAdmin()).catch(e => console.warn('renderSessionsAdmin error', e));
      }
    }, err => {
      console.warn('sessions onSnapshot error:', err);
    });

    console.log('✅ Sessions realtime listener started');
  } catch (err) {
    console.warn('startSessionsRealtimeListener error:', err);
  }
}

function stopSessionsRealtimeListener() {
  try {
    if (SESSIONS_ONSNAP_UNSUB) {
      SESSIONS_ONSNAP_UNSUB();
      SESSIONS_ONSNAP_UNSUB = null;
      console.log('✅ Sessions realtime listener stopped');
    }
  } catch (err) {
    console.warn('stopSessionsRealtimeListener error:', err);
  }
}

// Expose to window in case other code calls it via global name
if (typeof window !== 'undefined') {
  window.startSessionsRealtimeListener = startSessionsRealtimeListener;
  window.stopSessionsRealtimeListener = stopSessionsRealtimeListener;
}

  
function enableAdminSessionsUI(enable = true) {
  const card = document.getElementById('adminSessionsCard');
  if (!card) return;

  if (enable) {
    card.style.display = 'block';

    // start realtime listener (preferred) — this will call renderSessionsAdmin() on changes
    startSessionsRealtimeListener();

    // initial render
    renderSessionsAdmin().catch(err => console.warn('renderSessionsAdmin error', err));

    // keep legacy auto-refresh checkbox behavior as fallback
    const cb = document.getElementById('adminAutoRefreshSessions');
    if (cb && cb.checked && !SESSIONS_AUTO_REFRESH_ID) {
      SESSIONS_AUTO_REFRESH_ID = setInterval(renderSessionsAdmin, 5000);
    }
  } else {
    card.style.display = 'none';

    // stop real-time listener when admin hides the sessions UI
    stopSessionsRealtimeListener();

    if (SESSIONS_AUTO_REFRESH_ID) {
      clearInterval(SESSIONS_AUTO_REFRESH_ID);
      SESSIONS_AUTO_REFRESH_ID = null;
    }
  }
}


// ------------------ Admin: Live sessions viewer ------------------

let SESSIONS_AUTO_REFRESH_ID = null;

async function fetchAllSessionsFromFirestore() {
  try {
    const col = collection(db, "sessions");
    const snap = await getDocs(col);
    const sessions = [];
    snap.forEach(d => sessions.push({ id: d.id, ...d.data() }));
    // sort by updatedAt desc
    sessions.sort((a,b) => (b.updatedAt||0) - (a.updatedAt||0));
    return sessions;
  } catch (err) {
    console.error("❌ Failed to fetch sessions:", err);
    return [];
  }
}

function formatTimeAgo(ts) {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  const sec = Math.floor(diff/1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec/60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min/60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ts).toLocaleString();
}

/* ----------------------
   Admin: enable resume helper
   ---------------------- */
async function adminEnableResume(sessionId) {
  if (!sessionId) return alert('No session id provided');
  if (!confirm(`Allow "${sessionId}" to resume the exam? This will reset their resume counter and unlock their session.`)) return;
  try {
    const payload = {
      resumes: 0,
      locked: false,
      unlockedAt: Date.now(),
      updatedAt: Date.now()
    };

    if (typeof db !== 'undefined' && typeof doc === 'function' && (typeof setDoc === 'function' || typeof updateDoc === 'function')) {
      const ref = doc(db, "sessions", sessionId);
      if (typeof setDoc === 'function') {
        await setDoc(ref, payload, { merge: true });
      } else {
        await updateDoc(ref, payload);
      }
    } else if (typeof updateSession === 'function') {
      await updateSession(sessionId, payload);
    } else {
      console.warn('adminEnableResume: No backend helpers found; no server update performed.');
      alert('No backend update performed (see console).');
    }

    alert(`✅ Resume enabled for "${sessionId}".`);
    if (typeof renderSessionsAdmin === 'function') {
      try { renderSessionsAdmin(); } catch(e){ console.warn(e); }
    }
  } catch (err) {
    console.error('adminEnableResume error', err);
    alert('❌ Failed to enable resume (see console).');
  }
}
window.adminEnableResume = adminEnableResume;

// ----------------------
// Single clean live-count badge helper
// ----------------------
function updateLiveCountBadge(sessionsArr) {
  try {
    const THRESHOLD_MS = 15 * 1000;
    const now = Date.now();

    const liveCount = (sessionsArr || []).filter(sess => {
      const t = Number(sess.updatedAt || sess.lastSeen || sess.ts || sess.timestamp || 0);
      return t && (now - t) < THRESHOLD_MS;
    }).length;

    let card = document.getElementById('adminSessionsCard')
            || document.getElementById('sessionsArea')
            || document.getElementById('adminSessionsList')
            || document.body;
    if (!card) return;

    let titleEl = card.querySelector('.sessions-title');
    if (!titleEl) {
      titleEl = document.createElement('h3');
      titleEl.className = 'sessions-title';
      titleEl.style.margin = '8px 0';
      titleEl.style.fontSize = '16px';
      titleEl.style.fontWeight = '700';
      card.insertBefore(titleEl, card.firstChild);
    }

    titleEl.textContent = `Live Sessions — Who is giving exam? (${liveCount} live)`;
  } catch (e) {
    console.warn('updateLiveCountBadge error', e);
  }
}


// ----------------------
// renderSessionsAdmin (full replacement)
// ----------------------
async function renderSessionsAdmin() {
  const out = document.getElementById('adminSessionsList') || document.getElementById('sessionsArea') || document.body;
  out.innerHTML = '<div class="small">Loading sessions…</div>';

  // safe helpers / fallbacks
  const localUsers = (typeof users !== 'undefined' && Array.isArray(users)) ? users : [];
  const fetchSessions = (typeof fetchAllSessionsFromFirestore === 'function') ? fetchAllSessionsFromFirestore : async () => {
    try {
      if (typeof getDocs === 'function' && typeof collection === 'function' && typeof db !== 'undefined') {
        const snap = await getDocs(collection(db, "sessions"));
        const arr = [];
        snap.forEach(d => {
          const obj = (typeof d.data === 'function') ? d.data() : (d.data || {});
          obj.id = d.id;
          arr.push(obj);
        });
        return arr;
      }
    } catch (e) {
      console.warn("fallback fetchSessions error", e);
    }
    return [];
  };

  const safeMsToTime = (typeof msToTime === 'function') ? msToTime : (ms => {
    if (!ms) return '0:00:00';
    const s = Math.max(0, Math.floor(ms/1000));
    const hh = Math.floor(s/3600); const mm = Math.floor((s%3600)/60); const ss = s%60;
    return `${hh}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  });

  const safeFormatTimeAgo = (typeof formatTimeAgo === 'function') ? formatTimeAgo : (ts => {
    const t = Number(ts) || 0;
    if (!t) return '-';
    const diff = Date.now() - t;
    const sec = Math.floor(diff/1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec/60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min/60);
    if (hr < 24) return `${hr}h ago`;
    return new Date(t).toLocaleString();
  });

  const safeEscape = (typeof escapeHTML === 'function') ? escapeHTML : (s => {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"'`=\/]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',"/":'&#x2F;', "`":'&#x60;','=':'&#x3D;'}[c]));
  });

  const localTsToMillis = (typeof tsToMillis === 'function') ? tsToMillis : (ts => {
    if (!ts) return 0;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (ts && typeof ts.seconds === 'number') return (Number(ts.seconds) * 1000) + Math.floor((ts.nanoseconds || 0)/1e6);
    return Number(ts) || 0;
  });

  const THRESHOLD = 15 * 1000;
  const now = Date.now();

  // fetch sessions
  let sessions = [];
  try {
    sessions = await fetchSessions();
    // update title / live count
    try { if (typeof updateLiveCountBadge === 'function') updateLiveCountBadge(sessions); } catch(e){ console.warn(e); }
  } catch (err) {
    console.error("renderSessionsAdmin: failed to fetch sessions", err);
    out.innerHTML = '<div class="small danger">Failed to load sessions (see console)</div>';
    return;
  }

  if (!sessions || sessions.length === 0) {
    out.innerHTML = '<div class="small">No active sessions found.</div>';
    return;
  }

  // build UI
  out.innerHTML = '';
  sessions.forEach(sess => {
    // normalize session id & fields
    const sessId = sess.id || sess._id || sess.sessionId || sess.userId || sess.username || 'unknown';
    const usernameKey = sess.username || sess.user || sess.name || '';
    const user = localUsers.find(u => (u.username && (u.username === sessId || u.username === usernameKey)))
               || { username: usernameKey || sessId, fullName: sess.fullName || sess.displayName || usernameKey || sessId, photo: '' };

    const lastUpdateMs = localTsToMillis(sess.updatedAt || sess.lastSeen || sess.ts || sess.timestamp || 0);
    const online = !!lastUpdateMs && ((now - lastUpdateMs) < THRESHOLD);
    const statusHTML = online ? `<span style="color:#34d399;font-weight:700">🟢 Online</span>` : `<span style="color:#f87171;font-weight:700">🔴 Offline</span>`;

    // wrapper row
    const wrapper = document.createElement('div');
    wrapper.className = 'list-item';
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.justifyContent = 'space-between';
    wrapper.style.padding = '8px 6px';
    wrapper.style.borderBottom = '1px solid rgba(255,255,255,0.04)';

    // left: photo + name + status
    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.gap = '10px';
    left.style.alignItems = 'center';
    left.style.flex = '1';

    const img = document.createElement('img');
    img.src = user.photo || '';
    img.className = 'userPhoto';
    img.style.width = '48px';
    img.style.height = '48px';
    img.style.borderRadius = '8px';
    img.style.objectFit = 'cover';

    const meta = document.createElement('div');
    meta.style.display = 'flex';
    meta.style.flexDirection = 'column';
    meta.innerHTML = `<div style="font-weight:800">${safeEscape(user.fullName || user.username || sessId)} ${statusHTML}</div>
                      <div class="small">${safeEscape(sess.username || sessId)} • ${Array.isArray(sess.paperIds) ? sess.paperIds.length : '-'} q • resumed ${safeEscape(sess.resumes || 0)} time(s)</div>`;

    left.appendChild(img);
    left.appendChild(meta);

    // middle: exam status + IP + times
    const mid = document.createElement('div');
    mid.className = 'small';
    mid.style.minWidth = '220px';
    mid.style.textAlign = 'center';
    mid.innerHTML = `<div>Remaining: ${safeMsToTime(Number(sess.remainingMs || 0))}</div>
                     <div style="margin-top:4px">${sess.startedAt ? new Date(localTsToMillis(sess.startedAt)).toLocaleString() : '-'}</div>
                     <div style="margin-top:4px;color:var(--muted)">${safeFormatTimeAgo(sess.updatedAt)}</div>
                     <div style="margin-top:4px">IP: ${safeEscape(sess.ip || 'unknown')}</div>`;

    // right: actions
    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.alignItems = 'center';

    function makeBtn(text, cls, onClick) {
      const b = document.createElement('button');
      b.className = cls || 'btn';
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', onClick);
      return b;
    }

    const viewBtn = makeBtn('View', 'btn', () => (typeof adminViewSession === 'function' ? adminViewSession(sessId) : alert('View not available')));
    const clearBtn = makeBtn('Clear', 'btn', () => (typeof adminForceClearSession === 'function' ? adminForceClearSession(sessId) : alert('Clear not available')));
    const deleteBtn = makeBtn('Delete', 'btn danger', () => (typeof adminDeleteSession === 'function' ? adminDeleteSession(sessId) : alert('Delete not available')));
    const screenBtn = makeBtn('View Screen', 'btn warn', () => (typeof viewUserScreen === 'function' ? viewUserScreen(sessId) : alert('View Screen not available')));

    actions.appendChild(screenBtn);
    actions.appendChild(viewBtn);
    actions.appendChild(clearBtn);
    actions.appendChild(deleteBtn);

    // locked badge + unlock
    if (sess.locked) {
      const lockedBadge = document.createElement('span');
      lockedBadge.className = 'badge';
      lockedBadge.style.marginLeft = '8px';
      lockedBadge.style.background = '#f87171';
      lockedBadge.style.color = 'white';
      lockedBadge.textContent = 'Locked';
      actions.appendChild(lockedBadge);

      const unlockBtn = makeBtn('Unlock', 'btn brand', () => (typeof adminUnlockSession === 'function' ? adminUnlockSession(sessId) : alert('Unlock not available')));
      actions.appendChild(unlockBtn);
    }

    // Enable Resume button when resumes >= max or locked
    const resumeCount = Number(sess.resumes || 0);
    const maxR = Number((typeof settings !== 'undefined' && settings.maxResumes) ? settings.maxResumes : 2);
    if (resumeCount >= maxR || !!sess.locked) {
      const enableBtn = makeBtn('Enable Resume', 'btn', () => adminEnableResume(sessId));
      actions.appendChild(enableBtn);
    }

    // assemble row
    wrapper.appendChild(left);
    wrapper.appendChild(mid);
    wrapper.appendChild(actions);
    out.appendChild(wrapper);
  });

  // refreshBadges inside renderSessionsAdmin so `out` is in scope
  function refreshBadges() {
    try {
      const items = Array.from(out.querySelectorAll('.list-item'));
      const nowLocal = Date.now();
      // placeholder: you can add per-item DOM checks here to mark Online/Offline in realtime
      items.forEach(item => {
        // For example, you could read a data-updated attribute if you store it, e.g.:
        // const t = Number(item.dataset.updatedAt || 0);
        // if (t && (nowLocal - t) < 15000) { ... }
      });
    } catch (e) {
      // ignore if out not available
    }
  }
  // call refresh once (UI shows correct state on initial render because we used "now")
  refreshBadges();

} // end renderSessionsAdmin

// expose to global scope for any inline uses
window.renderSessionsAdmin = renderSessionsAdmin;




// View session detail (simple modal-like alert or console), you can expand to fancy modal
async function adminViewSession(sessionId) {
  try {
    const snap = await getDoc(doc(db, "sessions", sessionId));
    if (!snap.exists()) return alert("No session data found.");
    const s = snap.data();
    let msg = `Session for ${sessionId}\nStarted: ${s.startedAt ? new Date(s.startedAt).toLocaleString() : '-'}\nUpdated: ${s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '-'}\nRemainingMs: ${s.remainingMs}\nResumes: ${s.resumes || 0}\nCurrent Q index: ${s.cur}\nAnswers: ${JSON.stringify(s.answers || {}, null, 2)}\nFlags: ${JSON.stringify(s.flags || {}, null, 2)}\nPaper IDs: ${JSON.stringify(s.paperIds || [], null, 2)}`;
    // show in a scrollable window (new tab)
    const w = window.open();
    w.document.title = `Session: ${sessionId}`;
    w.document.body.style.background = '#071428';
    w.document.body.style.color = '#e6eef8';
    const pre = w.document.createElement('pre');
    pre.textContent = msg;
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.padding = '12px';
    w.document.body.appendChild(pre);
  } catch (err) {
    console.error(err);
    alert('Failed to load session (see console).');
  }
}

// Force clear a session (admin action) — deletes the session doc so user can't resume
async function adminForceClearSession(sessionId) {
  if (!confirm(`Clear session for "${sessionId}"? This will remove their saved progress and prevent resume.`)) return;
  try {
    await setDoc(doc(db, "sessions", sessionId), { remainingMs: 0, updatedAt: Date.now(), paperIds: [], answers: {}, flags: {}, resumes: 0 }, { merge: true });
    // optionally remove doc: use deleteDoc(doc(db,"sessions",sessionId)) if you prefer
    alert("Session cleared.");
    renderSessionsAdmin();
  } catch (err) {
    console.error(err);
    alert("Failed to clear session (see console).");
  }
}
// Permanently delete a saved session doc (admin action)
async function adminDeleteSession(sessionId) {
  if (!confirm(`Permanently DELETE session for "${sessionId}"? This cannot be undone.`)) return;
  try {
    await deleteDoc(doc(db, "sessions", sessionId));
    alert("Session deleted.");
    renderSessionsAdmin();
  } catch (err) {
    console.error("adminDeleteSession error:", err);
    alert("Failed to delete session (see console).");
  }
}
window.adminDeleteSession = adminDeleteSession; // expose globally for inline onclicks

// Clear all sessions (danger)
async function clearAllSessions() {
  if (!confirm('Clear ALL sessions? This will remove all saved progress.')) return;
  // caution: Firestore web SDK doesn't support batch delete of unknown docs easily client-side.
  // we'll list sessions and clear individually (best-effort)
  try {
    const sessions = await fetchAllSessionsFromFirestore();
    for (const s of sessions) {
      await setDoc(doc(db, "sessions", s.id), { remainingMs: 0, updatedAt: Date.now(), paperIds: [], answers: {}, flags: {}, resumes: 0 }, { merge: true });
    }
    alert('All sessions cleared (best-effort).');
    renderSessionsAdmin();
  } catch (err) {
    console.error(err);
    alert('Failed to clear sessions (see console).');
  }
}
  // Admin: remote-unlock a student's session (clears the locked flag)
async function adminUnlockSession(sessionId) {
  if (!confirm(`Unlock session for "${sessionId}"? This will allow the student to resume.`)) return;
  try {
    await setDoc(doc(db, "sessions", sessionId), { locked: false, unlockedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
    alert("Session unlocked.");
    renderSessionsAdmin();
  } catch (err) {
    console.error(err);
    alert("Failed to unlock session (see console).");
  }
}
window.adminUnlockSession = adminUnlockSession; // expose globally for the inline onclick

// Auto-refresh toggle handler: call render every 5s when checked
// DOM ready: wire auto-refresh toggle + admin proctor buttons
// DOM ready: wire auto-refresh toggle + admin proctor buttons
document.addEventListener('DOMContentLoaded', () => {
  // --- Auto-refresh toggle ---
  try {
    const cb = document.getElementById('adminAutoRefreshSessions');
    if (cb) {
      if (typeof SESSIONS_AUTO_REFRESH_ID === 'undefined') window.SESSIONS_AUTO_REFRESH_ID = null;
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (window.SESSIONS_AUTO_REFRESH_ID) clearInterval(window.SESSIONS_AUTO_REFRESH_ID);
          window.SESSIONS_AUTO_REFRESH_ID = setInterval(() => {
            try { renderSessionsAdmin(); } catch(e) { console.warn('renderSessionsAdmin error', e); }
          }, 5000);
        } else {
          if (window.SESSIONS_AUTO_REFRESH_ID) {
            clearInterval(window.SESSIONS_AUTO_REFRESH_ID);
            window.SESSIONS_AUTO_REFRESH_ID = null;
          }
        }
      });
    }
  } catch (e) {
    console.warn('Auto-refresh toggle wiring failed:', e);
  }

  // --- Wire admin proctor buttons ---
  try {
    const sBtn = document.getElementById('adminWatchStartBtn');
    const pBtn = document.getElementById('adminWatchStopBtn');
    if (sBtn) sBtn.addEventListener('click', () => adminStartWatch());
    if (pBtn) pBtn.addEventListener('click', () => adminStopWatch());
  } catch (e) {
    console.warn('Admin proctor button wiring failed:', e);
  }

  // --- Optional: session-row click to auto-fill username + watch ---
  try {
    document.querySelectorAll && document.querySelectorAll('.session-row[data-username]').forEach(el => {
      el.addEventListener('click', () => {
        const u = el.getAttribute('data-username');
        const input = document.getElementById('adminWatchUsername');
        if (input) input.value = u;
        setTimeout(() => adminStartWatch(u), 120);
      });
    });
  } catch (e) { /* ignore */ }

});

// Admin: enable resume for a specific user (clear resume count + unlock)
async function adminEnableResume(sessionId) {
  if (!confirm(`Allow "${sessionId}" to resume the exam? This will reset their resume counter and unlock their session.`)) return;
  try {
    // Set resumes=0 and unlocked flags so the user can resume
    await setDoc(doc(db, "sessions", sessionId), {
      resumes: 0,
      locked: false,
      unlockedAt: Date.now(),
      updatedAt: Date.now()
    }, { merge: true });

    alert(`✅ Resume enabled for "${sessionId}".`);
    // refresh admin list so UI updates immediately
    if (typeof renderSessionsAdmin === 'function') renderSessionsAdmin().catch(e => console.warn(e));
  } catch (err) {
    console.error('adminEnableResume error', err);
    alert('❌ Failed to enable resume (see console).');
  }
}
window.adminEnableResume = adminEnableResume;

 // Admin: start watching a user's screen/camera stream via screenSignals/{username}
let _adminPC = null;
let _adminUnsubs = [];

async function adminStartWatch(usernameOverride) {
  // try to read username from param or UI
  const username = (usernameOverride && usernameOverride.trim()) || (document.getElementById('adminWatchUsername') && document.getElementById('adminWatchUsername').value.trim());
  const statusEl = document.getElementById('adminWatchStatus');
  if (!username) {
    if (statusEl) statusEl.textContent = 'Enter username to watch.';
    return;
  }
  if (statusEl) statusEl.textContent = `Attempting to watch ${username}...`;

  try {
    // cleanup any existing
    adminStopWatch();

    const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
    const pc = new RTCPeerConnection(RTC_CONFIG);
    _adminPC = pc;

    // attach remote tracks to adminRemoteVideo
    const remoteVideo = document.getElementById('adminRemoteVideo');
    const remoteStream = new MediaStream();
    if (remoteVideo) remoteVideo.srcObject = remoteStream;

    pc.ontrack = (ev) => {
      // add incoming tracks to the remote stream
      ev.streams.forEach(s => {
        s.getTracks().forEach(t => remoteStream.addTrack(t));
      });
    };

    // send our ICE candidates to screenSignals/{username}/answerCandidates
    const callDoc = doc(collection(db, "screenSignals"), username);
    const answerCandidatesCol = collection(callDoc, "answerCandidates");
    pc.onicecandidate = event => {
      if (event.candidate) {
        try {
          addDoc(answerCandidatesCol, event.candidate.toJSON()).catch(e => {
            console.warn("addDoc(answerCandidates) failed:", e);
          });
        } catch (e) {
          console.warn("Failed to write admin candidate:", e);
        }
      }
    };

    // read the offer doc and respond
    const offerRef = callDoc;
    const offerSnap = await getDoc(offerRef);
    if (!offerSnap.exists()) {
      if (statusEl) statusEl.textContent = 'No active offer found for that username (user not streaming). Listening...';
      // still attach onSnapshot to wait for future offer
    }

    // subscribe to offer doc changes — when offer appears, setRemoteDescription & create+send answer
    const unsubOffer = onSnapshot(offerRef, async snap => {
      if (!snap.exists) return;
      const data = snap.data();
      if (!data || !data.offer) return;
      const offer = data.offer;
      try {
        // set remote (user's) offer
        await pc.setRemoteDescription(new RTCSessionDescription({ type: offer.type, sdp: offer.sdp }));
        console.log("✅ Admin setRemoteDescription (offer)");

        // create answer and set local
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // write answer into same doc
        await setDoc(offerRef, { answer: { type: answer.type, sdp: answer.sdp, createdAt: Date.now() } }, { merge: true });

        if (statusEl) statusEl.textContent = `Watching ${username} — answer sent.`;
      } catch (err) {
        console.warn("adminOffer handling failed", err);
        if (statusEl) statusEl.textContent = 'Failed to respond to offer: see console.';
      }
    }, err => {
      console.warn("offer onSnapshot err:", err);
    });

    // listen for user's ICE candidates (they write to offerCandidates)
    const userCandsCol = collection(callDoc, "offerCandidates");
    const unsubUserCands = onSnapshot(userCandsCol, snap => {
      snap.docChanges().forEach(async change => {
        if (change.type === 'added') {
          const d = change.doc.data();
          if (d) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(d));
            } catch (e) { console.warn("addIceCandidate(admin) failed:", e); }
          }
        }
      });
    });

    _adminUnsubs.push(unsubOffer, unsubUserCands);

    if (statusEl) statusEl.textContent = `Listening for offer / candidates for ${username}...`;
  } catch (err) {
    console.error("adminStartWatch failed:", err);
    const statusEl = document.getElementById('adminWatchStatus');
    if (statusEl) statusEl.textContent = 'Failed to start watch — see console.';
  }
}

function adminStopWatch() {
  try {
    if (_adminPC) {
      // stop incoming tracks
      const receivers = _adminPC.getReceivers ? _adminPC.getReceivers() : [];
      receivers.forEach(r => { try { if (r.track) r.track.stop(); } catch(e){} });
      try { _adminPC.close(); } catch(e) {}
      _adminPC = null;
    }
    // unsubscribe snapshot listeners
    _adminUnsubs.forEach(u => { try { if (typeof u === 'function') u(); } catch(e){} });
    _adminUnsubs = [];
    const rv = document.getElementById('adminRemoteVideo'); if (rv) rv.srcObject = null;
    const st = document.getElementById('adminWatchStatus'); if (st) st.textContent = 'Stopped.';
  } catch (e) {
    console.warn("adminStopWatch error:", e);
  }
}

// Expose for console/testing / UI hooks
window.adminStartWatch = adminStartWatch;
window.adminStopWatch = adminStopWatch;
window.startExamStream = startExamStream;
window.stopExamStream = stopExamStream;
function clearResults(){ if(!confirm('Clear all results?')) return; results = []; write(K_RESULTS, results); renderResults(); }
/* Exam Settings */
/* ---------- Save Exam Settings ---------- */
async function saveExamSettings() {
  const dur = parseInt($('#adminDuration').value) || 30;
  const msg = $('#adminCustomMsg').value || "📢 Welcome to your exam! Stay calm, focus, and do your best!";
  const shuffle = $('#adminShuffle').checked;
  const allowAfterTime = $('#adminAllowAfterTime').checked;

  const logoFile = document.getElementById('adminLogo').files[0];
  const logo = logoFile ? await toDataURL(logoFile) : (settings.logo || "");

  // new resume settings
  const resumeEnabled = !!document.getElementById('adminResumeEnabled').checked;
  const maxResumes = Math.max(0, parseInt(document.getElementById('adminMaxResumes').value) || 2);

  const settingsObj = {
    durationMin: dur,
    customMsg: msg,
    shuffle,
    allowAfterTime,
    logo,
    author: document.getElementById('adminAuthor').value || "",
    college: document.getElementById('adminCollege').value || "",
    subject: document.getElementById('adminSubject').value || "",
    subjectCode: document.getElementById('adminSubjectCode').value || "",
    fullMarks: parseInt(document.getElementById('adminFullMarks').value) || 0,
    // resume fields
    resumeEnabled,
    maxResumes,
    counts: {
      Synopsis: parseInt($('#adminCountSynopsis').value) || 0,
      "Minor Practical": parseInt($('#adminCountMinor').value) || 0,
      "Major Practical": parseInt($('#adminCountMajor').value) || 0,
      Viva: parseInt($('#adminCountViva').value) || 0
    }
  };

  // update global and persist
  settings = settingsObj;
  write(K_SETTINGS, settings);

  try {
    await setDoc(doc(db, "settings", "exam"), settingsObj);
    await loadSettingsFromFirestore(); // reload remote copy
    console.log("✅ Firestore saved: settings/exam", settingsObj);
    alert("✅ Exam settings saved to Firebase + localStorage!");
  } catch (err) {
    console.error("❌ Firestore error (settings):", err);
    alert("⚠️ Exam settings saved offline only.\nError: " + err.message);
  }

  // update UI
  renderSettingsAdmin();
  renderExamHeader();
}


function renderSettingsAdmin() {
  // default fallback
  if (!settings || typeof settings !== "object") {
    settings = {
      durationMin: 30,
      customMsg: "",
      shuffle: false,
      allowAfterTime: false,
      logo: "",
      author: "",
      college: "",
      subject: "",
      subjectCode: "",
      fullMarks: "",
      resumeEnabled: false,
      maxResumes: 2,
      counts: { Synopsis: 0, "Minor Practical": 0, "Major Practical": 0, Viva: 0 }
    };
  }

  // Timer & exam settings
  document.getElementById('adminDuration').value = settings.durationMin || "";
  document.getElementById('adminCustomMsg').value = settings.customMsg || "";
  document.getElementById('adminShuffle').checked = !!settings.shuffle;
  document.getElementById('adminAllowAfterTime').checked = !!settings.allowAfterTime;

  // resume UI
  const resumeEl = document.getElementById('adminResumeEnabled');
  if (resumeEl) resumeEl.checked = !!settings.resumeEnabled;
  const maxR = document.getElementById('adminMaxResumes');
  if (maxR) maxR.value = typeof settings.maxResumes === 'number' ? settings.maxResumes : (settings.maxResumes || 2);

  // Extra fields
  document.getElementById('adminAuthor').value = settings.author || "";
  document.getElementById('adminCollege').value = settings.college || "";
  document.getElementById('adminSubject').value = settings.subject || "";
  document.getElementById('adminSubjectCode').value = settings.subjectCode || "";
  document.getElementById('adminFullMarks').value = settings.fullMarks || "";

  // Counts
  document.getElementById('adminCountSynopsis').value = settings.counts?.Synopsis || "";
  document.getElementById('adminCountMinor').value = settings.counts?.["Minor Practical"] || "";
  document.getElementById('adminCountMajor').value = settings.counts?.["Major Practical"] || "";
  document.getElementById('adminCountViva').value = settings.counts?.Viva || "";

  // Logo preview reset
  const logoInput = document.getElementById("adminLogo");
  if (logoInput) logoInput.value = "";
  const preview = document.getElementById("logoPreview");
  if (preview) {
    if (settings.logo) {
      preview.src = settings.logo;
      preview.style.display = "block";
    } else {
      preview.style.display = "none";
      preview.src = "";
    }
  }

  updateQuestionPreview();
}


function renderExamHeader() {
  const header = document.getElementById('examHeader');
  let html = "";

  // ✅ Show logo at the top
  if (settings.logo) {
    html += `<img src="${settings.logo}" alt="Logo" style="max-height:80px; margin-bottom:8px;">`;
  }

  html += `<div>Online MCQ Examination System</div>`;

  if (settings.author) html += `<div>Made by: ${escapeHTML(settings.author)}</div>`;
  if (settings.college) html += `<div>${escapeHTML(settings.college)}</div>`;
  if (settings.subject) html += `<div>Subject: ${escapeHTML(settings.subject)}</div>`;
  if (settings.subjectCode) html += `<div>Code: ${escapeHTML(settings.subjectCode)}</div>`;
  if (settings.fullMarks) html += `<div>Total Marks: ${settings.fullMarks}</div>`;

  header.innerHTML = html;
}

  // ... your existing functions ...

  function resetSettings() {
    if (confirm("⚠️ This will clear all saved settings (Logo, Author, College, Subject, etc.) and reset them to blank.\n\nDo you want to continue?")) {
      // Clear localStorage
      localStorage.removeItem("offline_mcq_settings_v1");

      // Reset in-memory settings
      settings = {
        durationMin: 30,
        customMsg: "",
        shuffle: false,
        allowAfterTime: false,
        logo: "",
        author: "",
        college: "",
        subject: "",
        subjectCode: "",
        fullMarks: "",
        counts: { Synopsis: 0, "Minor Practical": 0, "Major Practical": 0, Viva: 0 }
      };

      // Clear logo file input
      const logoInput = document.getElementById("adminLogo");
      if (logoInput) logoInput.value = "";

      // Clear logo preview
      const preview = document.getElementById("logoPreview");
      if (preview) {
        preview.src = "";
        preview.style.display = "none";
      }

      // Re-render admin panel
      renderSettingsAdmin();

      alert("✅ Settings have been reset. All fields are now blank.");
    }
  }





/* Export results CSV */
function exportResultsCSV(){
  if(results.length === 0) return alert('No results to export');
  const rows = [['username','totalPercent','synopsis','minor_practical','major_practical','viva','timestamp']];
  results.forEach(r => rows.push([r.username, r.totalScorePercent, r.sectionScores['Synopsis']||0, r.sectionScores['Minor Practical']||0, r.sectionScores['Major Practical']||0, r.sectionScores['Viva']||0, new Date(r.timestamp).toISOString()]));
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  download('results.csv', csv, 'text/csv');
}

/* ---------- Import / Export functions ---------- */

function triggerImportUsers(){ $('#impUsersFile').click(); }
function triggerImportQuestions(){ $('#impQFile').click(); }

function importUsersFile(e){
  const f = e.target.files[0]; if(!f) return;
  const fr = new FileReader();
  fr.onload = ()=> {
    try {
      const arr = JSON.parse(fr.result);
      if(!Array.isArray(arr)) throw 'bad';
      // expect objects with username,password,photo (photo optional base64)
      users = arr.map(u => ({ username: u.username, password: u.password, photo: u.photo || '' }));
      write(K_USERS, users); alert('Users imported'); renderUsersAdmin();
    } catch (err) { console.error(err); alert('Invalid users JSON'); }
  };
  fr.readAsText(f);
  e.target.value = '';
}
function importQuestionsFile(e){
  const f = e.target.files[0];
  if(!f) return;
  const fr = new FileReader();
  fr.onload = ()=> {
    try {
      const arr = JSON.parse(fr.result);
      if(!Array.isArray(arr)) throw 'bad';
      questions = arr.map(q => ({
        id: q.id || uid(),
        question: q.question || '',
        options: q.options || (q.optionsJSON ? JSON.parse(q.optionsJSON) : ['','','','']),
        answer: (typeof q.answer === 'number') ? q.answer : parseInt(q.answer) || 0,
        marks: parseInt(q.marks) || 1,
        category: q.category || 'Synopsis'
      }));
      write(K_QS, questions);
      alert('Questions imported locally. Click "Save imported to Firebase" to push them to Firestore.');
      renderQuestionsList();
      const sbtn = document.getElementById('saveImportedBtn');
      if (sbtn) sbtn.disabled = false;
    } catch(err){
      console.error(err);
      alert('Invalid questions JSON');
    }
  };
  fr.readAsText(f);
  e.target.value = '';
}

// ---------------- Save imported questions to Firestore ----------------
async function saveImportedQuestionsToFirestore() {
  if (!Array.isArray(questions) || questions.length === 0) {
    return alert('No imported questions to save.');
  }

  // Ensure Firestore helpers are ready
  const ready = await (window._firestoreReadyPromise || Promise.resolve(false));
  if (!ready || typeof setDoc !== 'function' || typeof doc !== 'function' || typeof db === 'undefined') {
    return alert('Firestore not ready or not available. Check Firebase initialization.');
  }

  // Disable button while saving
  const saveBtn = document.getElementById('saveImportedBtn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }

  let success = 0;
  const failed = [];

  for (const q of questions) {
    try {
      if (!q.id) q.id = uid();
      // write the full question doc
      await setDoc(doc(db, 'questions', q.id), q);
      success++;
    } catch (err) {
      console.error('Failed to save question to Firestore:', q.id, err);
      failed.push({ id: q.id, error: err && err.message ? err.message : String(err) });
    }
  }

  // Attempt to refresh remote cache / UI
  try { if (typeof loadQuestionsFromFirestore === 'function') await loadQuestionsFromFirestore(); } catch(e){ console.warn('loadQuestionsFromFirestore failed', e); }

  // Re-enable button and show result
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save imported to Firebase';
  }

  alert(`Saved ${success} questions to Firestore. Failed: ${failed.length}`);
  if (failed.length) console.warn('Failed saves:', failed);

  // Refresh UI
  if (typeof renderQuestionsList === 'function') renderQuestionsList();
}
window.saveImportedQuestionsToFirestore = saveImportedQuestionsToFirestore;


function exportUsers(){ download('users.json', JSON.stringify(users, null, 2), 'application/json'); }
function exportQuestions(){ download('questions.json', JSON.stringify(questions, null, 2), 'application/json'); }

function exportResultsJSON(){
  if(results.length === 0) return alert('No results to export');
  download('results.json', JSON.stringify(results, null, 2), 'application/json');
}

function exportResultsCSV(){
  if(results.length === 0) return alert('No results to export');
  const rows = [['username','totalPercent','synopsis','minor','major','viva','timestamp']];
  results.forEach(r => rows.push([
    r.username,
    r.totalScorePercent,
    r.sectionScores['Synopsis']||0,
    r.sectionScores['Minor Practical']||0,
    r.sectionScores['Major Practical']||0,
    r.sectionScores['Viva']||0,
    new Date(r.timestamp).toISOString()
  ]));
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  download('results.csv', csv, 'text/csv');
}

async function importResultsFile(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  let allImported = [];

  try {
    for (const file of files) {
      // read file text
      const text = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(new Error(`Failed to read ${file.name}`));
        fr.onload = () => resolve(fr.result);
        fr.readAsText(file);
      });

      // parse JSON
      let imported;
      try {
        imported = JSON.parse(text);
      } catch (err) {
        console.error("Invalid JSON in", file.name, err);
        alert(`❌ Invalid JSON in ${file.name}`);
        continue; // skip this file
      }

      // decrypt parsed data
      try {
        const decrypted = await decryptData(imported);
        if (Array.isArray(decrypted)) {
          allImported = allImported.concat(decrypted);
        } else {
          allImported.push(decrypted);
        }
      } catch (err) {
        console.error("Failed to decrypt file", file.name, err);
        alert(`❌ Failed to decrypt ${file.name}`);
        continue; // skip this file
      }
    }

    // Re-encrypt merged results before saving
    const encryptedResults = await encryptData(allImported);
    write(K_RESULTS, encryptedResults);
    results = allImported;

    alert(`✅ Imported ${files.length} results file(s) successfully!`);
    renderResults();
  } catch (err) {
    console.error("Import failed", err);
    alert('❌ Import failed. See console for details.');
  } finally {
    // reset file input even on error
    e.target.value = "";
  }
}


function exportSettings() {
  if (!settings) return alert("No exam settings to export");
  download('exam_settings.json', JSON.stringify(settings, null, 2), 'application/json');
}

function triggerImportSettings() {
  document.getElementById('impSettingsFile').click();
}

function importSettingsFile(e) {
  const f = e.target.files[0]; if (!f) return;
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const obj = JSON.parse(fr.result);

      // Merge with defaults and existing settings
      settings = {
  ...settings,
  durationMin: obj.durationMin ?? settings.durationMin ?? 30,
  customMsg: obj.customMsg ?? settings.customMsg ?? "📢 Welcome to your exam! Stay calm, focus, and do your best!",
  shuffle: obj.shuffle ?? settings.shuffle ?? false,
  allowAfterTime: obj.allowAfterTime ?? settings.allowAfterTime ?? false,
  logo: obj.logo ?? settings.logo ?? "",
  author: obj.author ?? settings.author ?? "",
  college: obj.college ?? settings.college ?? "",
  subject: obj.subject ?? settings.subject ?? "",
  subjectCode: obj.subjectCode ?? settings.subjectCode ?? "",
  fullMarks: obj.fullMarks ?? settings.fullMarks ?? 0,
  counts: {
    Synopsis: obj.counts?.Synopsis ?? settings.counts?.Synopsis ?? 0,
    "Minor Practical": obj.counts?.["Minor Practical"] ?? settings.counts?.["Minor Practical"] ?? 0,
    "Major Practical": obj.counts?.["Major Practical"] ?? settings.counts?.["Major Practical"] ?? 0,
    Viva: obj.counts?.Viva ?? settings.counts?.Viva ?? 0
  }
};


      write(K_SETTINGS, settings);
      alert('✅ Exam settings imported!');
      renderSettingsAdmin(); 
    } catch(err) {
      console.error(err);
      alert('❌ Invalid exam settings JSON');
    }
  };
  fr.readAsText(f);
  e.target.value = '';
}

/* ---------- start UI ---------- */
showSection('user');
renderQuestionsList();
renderUsersAdmin();
renderResults();


/* Expose a few for console/debug if needed */
window._data = { users, questions, results };

const character = document.getElementById("examCharacterName");
character.textContent = user.fullName;

// Smooth tracking variables
let mouseX = 0, mouseY = 0;
let charX = 0, charY = 0;
const speed = 0.15; // lower = slower lag, higher = faster

// Update mouse position
document.addEventListener('mousemove', e => {
    mouseX = e.clientX + 15; // offset
    mouseY = e.clientY + 15;
});

// Animation loop
function animate() {
    // Move character towards mouse with easing
    charX += (mouseX - charX) * speed;
    charY += (mouseY - charY) * speed;
    character.style.left = charX + 'px';
    character.style.top = charY + 'px';
    requestAnimationFrame(animate);
}

// Start animation
animate();
const ADMIN_UNLOCK_PASS = "exam123"; // 🔑 change this password
let examPaused = false;

// force fullscreen
function enterFullscreen(el) {
  if (el.requestFullscreen) el.requestFullscreen();
  else if (el.mozRequestFullScreen) el.mozRequestFullScreen();
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  else if (el.msRequestFullscreen) el.msRequestFullscreen();
}

// detect exit fullscreen
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && !EXAM.state?.submitted) {
    pauseExam();
  }
});

async function pauseExam() {
  try {
    examPaused = true;

    // stop the exam timer (defensive)
    if (EXAM && EXAM.timerId) {
      clearInterval(EXAM.timerId);
      EXAM.timerId = null;
    }

    // show lock UI
    const lockNode = document.getElementById("lockScreen");
    if (lockNode) lockNode.style.display = "flex";

    // ensure EXAM.state exists and mark locked explicitly
    if (!EXAM) EXAM = {};
    if (!EXAM.state) EXAM.state = {};
    EXAM.state.locked = true;

    // persist locked state (await so errors are visible in console)
    if (EXAM.state.username) {
      const username = EXAM.state.username;
      try {
        // Use a safe merged object when saving to avoid syntax/runtime errors
        const payload = { ...EXAM.state, locked: true };

        if (typeof saveSessionToFirestore === 'function') {
          await saveSessionToFirestore(username, payload, EXAM.paper);
        } else if (typeof setDoc === 'function' && typeof doc === 'function') {
          // example fallback if you use Firestore low-level apis
          await setDoc(doc(db, "sessions", username), payload, { merge: true });
        } else {
          console.warn("pauseExam: no session save function available; lock state not persisted to server.");
        }

        // stop any poller fallback before starting a new watcher (avoid duplicates)
        if (typeof stopPausedSessionPolling === "function") {
          try { stopPausedSessionPolling(); } catch (e) { /* ignore */ }
        }

        // stop any previous realtime watcher to avoid duplicate subscriptions
        if (typeof stopSessionWatcher === "function") {
          try { stopSessionWatcher(); } catch (e) { /* ignore */ }
        }

        // Prefer realtime watcher; if not available, start poller fallback
        if (typeof startSessionWatcher === "function") {
          try {
            startSessionWatcher(username);
            console.log("pauseExam: started session watcher for", username);
          } catch (e) {
            console.warn("pauseExam: startSessionWatcher threw, starting poller fallback", e);
            if (typeof startPausedSessionPolling === "function") startPausedSessionPolling(username);
          }
        } else if (typeof startPausedSessionPolling === "function") {
          startPausedSessionPolling(username);
          console.log("pauseExam: started paused poller fallback for", username);
        } else {
          console.warn("pauseExam: no watcher or poller available to detect unlocks.");
        }
      } catch (e) {
        console.warn("Failed to persist locked state or start watcher:", e);
      }
    } else {
      console.warn("pauseExam: no EXAM.state.username to save session for; cannot persist lock");
      // If no username, starting a poller/watch isn't useful
    }
  } catch (err) {
    console.warn("pauseExam error:", err);
  }
}

// 🔹 Unlock Exam with Password (improved)
async function unlockExam() {
  if (!EXAM.state || !EXAM.state.username) {
    alert("⚠️ No active exam session found.");
    return;
  }

  const username = EXAM.state.username;
  const input = document.getElementById("unlockPassword");

  // --- 1) Check server-side session first (in case admin already unlocked) ---
  try {
    const snap = await getDoc(doc(db, "sessions", username));
    if (snap && snap.exists()) {
      const s = snap.data();
      if (!s.locked) {
        // Admin already unlocked -> resume locally
        if (typeof stopPausedSessionPolling === 'function') stopPausedSessionPolling();
        if (typeof stopSessionWatcher === 'function') stopSessionWatcher();

        document.getElementById("lockScreen").style.display = "none";
        try { enterFullscreen(document.documentElement); } catch(e) {}
        try { startTimer(); } catch(e) {}
        examPaused = false;
        EXAM.state.locked = false;
        try { startPeriodicSessionSave(); } catch(e) {}

        alert("✅ Unlocked by admin — resuming exam.");
        input.value = "";
        return;
      }
    }
  } catch (e) {
    console.warn("unlockExam: server check failed", e);
    // continue to password fallback
  }

  // --- 2) Password fallback: accept MASTER_ADMIN or student's password ---
  const pass = (input.value || "").trim();
  if (!pass) {
    alert("⚠️ Please enter a password to unlock.");
    return;
  }

  const userRecord = users.find(u => u.username === username);
  const isMaster = (pass === MASTER_ADMIN.password) || (typeof ADMIN_UNLOCK_PASS !== 'undefined' && pass === ADMIN_UNLOCK_PASS);

  const isStudent = userRecord && userRecord.password && (pass === userRecord.password);

  if (!isMaster && !isStudent) {
    alert("❌ Wrong password. Try again or contact admin.");
    input.value = "";
    return;
  }

  // --- 3) Unlock locally and persist to server (best-effort) ---
  try {
    // update local state
    EXAM.state.locked = false;
    EXAM.state.lockReason = "";
    // Save to sessions collection so admin sees the change
    if (typeof saveSessionToFirestore === 'function') {
      await saveSessionToFirestore(username, EXAM.state, EXAM.paper);
      try {
        await setDoc(doc(db, "sessions", username), { locked: false, unlockedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
      } catch(e){ /* non-fatal */ }
    } else {
      await setDoc(doc(db, "sessions", username), { locked: false, unlockedAt: Date.now(), updatedAt: Date.now() }, { merge: true });
    }
  } catch (err) {
    console.warn("unlockExam: failed to persist unlock to server", err);
    // continue anyway (allow user to resume locally)
  }

  // --- 4) Restore UI & timer ---
  if (typeof stopPausedSessionPolling === 'function') stopPausedSessionPolling();
  if (typeof stopSessionWatcher === 'function') stopSessionWatcher();

  document.getElementById("lockScreen").style.display = "none";
  try { enterFullscreen(document.documentElement); } catch(e) {}
  try { startTimer(); } catch(e) {}
  examPaused = false;
  try { startPeriodicSessionSave(); } catch(e) {}

  alert("✅ Unlocked. Resuming exam.");
  input.value = "";
}

// expose if needed by inline onclick
window.unlockExam = unlockExam;

let PAUSE_POLLER_ID = null;
function startPausedSessionPolling(username) {
  if (!username) return;
  // don't start polling if snapshot is active
  if (SESSION_UNSUBSCRIBE) return;
  stopPausedSessionPolling();
  PAUSE_POLLER_ID = setInterval(async () => {
    try {
      const docRef = doc(db, "sessions", username);
      const snap = await getDoc(docRef);
      if (!snap.exists()) return;
      const s = snap.data();
      if (s.locked) {
        if (document.getElementById("lockScreen")) {
          document.getElementById("lockScreen").style.display = "flex";
        }
        examPaused = true;
        clearInterval(EXAM.timerId);
      } else {
        if (document.getElementById("lockScreen")) {
          document.getElementById("lockScreen").style.display = "none";
        }
        if (examPaused) {
          examPaused = false;
          try { startTimer(); } catch(e){}
        }
      }
    } catch (e) {
      console.warn("pause poller error:", e);
    }
  }, 2500);
}

function stopPausedSessionPolling() {
  if (PAUSE_POLLER_ID) {
    clearInterval(PAUSE_POLLER_ID);
    PAUSE_POLLER_ID = null;
  }
}


// And make sure stopPausedSessionPolling() is called when user unlocks locally (in unlockExam)
// -----------------------
// Auto-lock on any "exit" attempt
// -----------------------

// Helper guard: only lock when exam is active and not already submitted/completed
function shouldAutoLock() {
  // adapt these checks to your app state variables
  // - EXAM.running: (true if exam in progress) - replace if you use another flag
  // - EXAM.submitted: (true if exam already submitted)
  // - examPaused: local paused flag
  const running = !!(typeof EXAM !== "undefined" && EXAM && EXAM.running);
  const submitted = !!(typeof EXAM !== "undefined" && EXAM && EXAM.submitted);
  return running && !submitted && !examPaused;
}

// central function to trigger lock behavior
function triggerAutoLock(reason) {
  try {
    console.log("Auto-lock triggered:", reason);
    // if exam already paused/locked, ignore
    if (!shouldAutoLock()) return;
    // call existing pause logic (which should save locked:true and show lock screen)
    // if you used a different name for pause handler, replace pauseExam() accordingly
    if (typeof pauseExam === "function") {
      pauseExam();
    } else {
      // fallback: set local flags + show lock UI + save session
      examPaused = true;
      if (document.getElementById("lockScreen")) document.getElementById("lockScreen").style.display = "flex";
      if (EXAM && EXAM.state && EXAM.state.username) {
        saveSessionToFirestore(EXAM.state.username, { ...EXAM.state, locked: true }, EXAM.paper).catch(e=>console.warn(e));
      }
      startPausedSessionPolling();
    }
  } catch (e) {
    console.error("triggerAutoLock error:", e);
  }
}

// --------------- Event handlers ------------------

// 1) Detect leaving fullscreen (most browsers fire this when user presses ESC, or window loses fullscreen)
document.addEventListener("fullscreenchange", () => {
  // If we left fullscreen and exam is running -> lock
  if (!document.fullscreenElement) {
    triggerAutoLock("fullscreenchange: left fullscreen");
  }
});

// 2) Detect visibility change (tab switch / minimize / lock-screen)
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    triggerAutoLock("visibilitychange: document.hidden");
  }
});

// 3) Window blur — user clicked outside window or switched app (mobile or desktop)
window.addEventListener("blur", () => {
  // small timeout to avoid false positives from brief focus shifts
  setTimeout(() => {
    if (document.hasFocus && !document.hasFocus()) {
      triggerAutoLock("window.blur: lost focus");
    }
  }, 150);
});

// 4) Pagehide / beforeunload — attempts to close or reload
window.addEventListener("pagehide", (e) => {
  // pagehide occurs when navigating away or closing tab
  triggerAutoLock("pagehide");
});

// beforeunload: can't perform async writes reliably, but we still trigger local lock UI
window.addEventListener("beforeunload", (e) => {
  if (!shouldAutoLock()) return;
  // show lock UI and save synchronous minimal state
  try {
    if (EXAM && EXAM.state && EXAM.state.username) {
      // best-effort save; this is synchronous-ish so keep small
      navigator.sendBeacon && typeof navigator.sendBeacon === "function" && (() => {
        try {
          // If you have an API endpoint to save session quickly, use sendBeacon there.
          // Fallback: still call saveSessionToFirestore but it may not complete before unload.
          saveSessionToFirestore(EXAM.state.username, { ...EXAM.state, locked: true }, EXAM.paper).catch(()=>{});
        } catch(e){}
      })();
    }
  } catch(e) {}
  // Custom message not allowed in many browsers; still we can prompt to stop navigation:
  // e.returnValue = "Are you sure you want to leave the exam? Leaving will lock your session.";
  // return e.returnValue;
});

// 5) Optional: Detect long pointer leave (mouse leaving window) — useful for desktops
document.addEventListener("mouseleave", (e) => {
  // only when pointer leaves window viewport at top (possible closing devtools/window)
  if (e.clientY <= 0) {
    // slight debounce
    setTimeout(() => {
      if (!document.fullscreenElement && shouldAutoLock()) triggerAutoLock("mouseleave: top edge");
    }, 120);
  }
});

// --------------- End auto-lock block ------------------
  
function dismissInstructions(){
  document.getElementById("examInstructionsOverlay").style.display = "none";
}

function showInstructions(){
  document.getElementById("examInstructionsOverlay").style.display = "flex";
}
// ------------------------------
// 👇 Attractive Mouse Trail Effect
// ------------------------------
const trailContainer = document.createElement("div");
trailContainer.style.position = "fixed";
trailContainer.style.top = "0";
trailContainer.style.left = "0";
trailContainer.style.width = "100%";
trailContainer.style.height = "100%";
trailContainer.style.pointerEvents = "none";
trailContainer.style.overflow = "hidden";
trailContainer.style.zIndex = "9999";
document.body.appendChild(trailContainer);

document.addEventListener("mousemove", e => {
  const dot = document.createElement("div");
  dot.style.position = "absolute";
  dot.style.width = "12px";
  dot.style.height = "12px";
  dot.style.borderRadius = "50%";
  dot.style.background = `hsl(${Math.random()*360}, 90%, 60%)`; // rainbow colors
  dot.style.left = e.clientX + "px";
  dot.style.top  = e.clientY + "px";
  dot.style.opacity = "1";
  dot.style.transform = "scale(1)";
  dot.style.transition = "opacity 0.8s linear, transform 0.8s ease";

  trailContainer.appendChild(dot);

  // fade & shrink out
  setTimeout(() => {
    dot.style.opacity = "0";
    dot.style.transform = "scale(0.3)";
    setTimeout(() => dot.remove(), 800);
  }, 20);
});

function updateStats() {
  if (!EXAM.state) return;

  const answered = Object.keys(EXAM.state.answers).length;
  const notAnswered = EXAM.paper.length - answered;
  const flagged = Object.keys(EXAM.state.flags).length;

  document.getElementById("answerStats").innerHTML = `
    <span style="color: var(--good)">Answered: ${answered}</span> |
    <span style="color: var(--danger)">Not Answered: ${notAnswered}</span> |
    <span style="color: orange">Flagged: ${flagged}</span>
  `;
}
function updateQuestionPreview(){
  const s = parseInt(document.getElementById('adminCountSynopsis').value) || 0;
  const m = parseInt(document.getElementById('adminCountMinor').value) || 0;
  const maj = parseInt(document.getElementById('adminCountMajor').value) || 0;
  const v = parseInt(document.getElementById('adminCountViva').value) || 0;

  const total = s + m + maj + v;

  document.getElementById('questionPreview').innerText = 
    "Total Questions: " + total;
}
// Auto-import JSON files on startup
async function autoImportJSON() {
  let imported = false;
  try {
    // Try full backup first
    const res = await fetch("exam_full_backup.json");
    if (res.ok) {
      const backup = await res.json();
      users = backup.users || [];
      questions = backup.questions || [];
      results = backup.results || [];
      settings = backup.settings || settings;
      adminCred = backup.adminCred || MASTER_ADMIN;

      write(K_USERS, users);
      write(K_QS, questions);
      write(K_RESULTS, results);
      write(K_SETTINGS, settings);
      write(K_ADMIN, adminCred);

      showImportMessage("✅ Auto-imported exam_full_backup.json successfully!");
      imported = true;
      return;
    }
  } catch {}

  // Try users.json
  try {
    const resUsers = await fetch("users.json");
    if (resUsers.ok) {
      users = await resUsers.json();
      write(K_USERS, users);
      showImportMessage("✅ Auto-imported users.json successfully!");
      imported = true;
    }
  } catch {}

  // Try questions.json
  try {
    const resQs = await fetch("questions.json");
    if (resQs.ok) {
      questions = await resQs.json();
      write(K_QS, questions);
      showImportMessage("✅ Auto-imported questions.json successfully!");
      imported = true;
    }
  } catch {}

  if (!imported) {
    showImportMessage("⚠️ No JSON file found for auto-import.");
  }
}

// 🔹 Helper to display banner message
function showImportMessage(msg) {
  let banner = document.getElementById("examMsg");

  if (!banner) {
    // create banner if it doesn't exist
    banner = document.createElement("div");
    banner.id = "examMsg";
    banner.style.cssText = `
      width: 100%;
      padding: 8px;
      text-align: center;
      font-weight: bold;
      background: #222;
      color: #34d399;
    `;
    document.body.prepend(banner);
  }

  banner.textContent = msg;
  banner.style.display = "block";   // ensure it's visible
}

// Run on startup
window.addEventListener("DOMContentLoaded", () => {
  initApp();
})

async function loadSettingsFromFirestore() {
  try {
    const snap = await getDoc(doc(db, "settings", "exam"));
    if (snap.exists()) {
      settings = snap.data();
      write(K_SETTINGS, settings); // sync offline copy
      console.log("✅ Loaded settings from Firestore:", settings);
    } else {
      console.warn("⚠️ No settings found in Firestore, using offline copy");
      settings = read(K_SETTINGS, {});
    }
  } catch (err) {
    console.error("❌ Firestore load error (settings):", err);
    settings = read(K_SETTINGS, {});
  }
}
  
async function loadQuestionsFromFirestore() {
  try {
    const qs = [];
    const snap = await getDocs(collection(db, "questions"));
    snap.forEach(docSnap => qs.push(docSnap.data()));
    if (qs.length > 0) {
      questions = qs;
      write(K_QS, questions);
      console.log("✅ Loaded questions from Firestore:", questions);
    }
  } catch (err) {
    console.error("❌ Firestore load error (questions):", err);
    questions = read(K_QS, []);
  }
}
  async function loadUsersFromFirestore() {
  try {
    const arr = [];
    const snap = await getDocs(collection(db, "users"));
    snap.forEach(docSnap => arr.push(docSnap.data()));
    if (arr.length > 0) {
      users = arr;
      write(K_USERS, users);
      console.log("✅ Loaded users from Firestore:", users);
    }
  } catch (err) {
    console.error("❌ Firestore load error (users):", err);
    users = read(K_USERS, []);
  }
}

async function loadSettingsFromFirestore() {
  try {
    const snap = await getDoc(doc(db, "settings", "exam"));
    if (snap.exists()) {
      settings = snap.data();                 // ← overwrite fully
      settings.durationMin = Number(settings.durationMin ?? 30);
      write(K_SETTINGS, settings);            // cache for offline only
      console.log("✅ Settings from Firestore:", settings);
    } else {
      console.warn("⚠️ No settings in Firestore; using local cache");
      settings = read(K_SETTINGS, {});
      settings.durationMin = Number(settings.durationMin ?? 30);
    }
  } catch (e) {
    console.error("❌ Settings load error:", e);
    settings = read(K_SETTINGS, {});
    settings.durationMin = Number(settings.durationMin ?? 30);
  }
}
async function initApp() {
  await loadSettingsFromFirestore();
  await loadQuestionsFromFirestore();
  await loadUsersFromFirestore();

  try {
    await loadResultsFromFirestore();
  } catch (err) {
    console.warn("⚠️ Firestore failed, falling back to local results", err);
    results = read(K_RESULTS, []);  // localStorage fallback
  }

  renderSettingsAdmin();
  renderExamHeader();
  renderQuestionsList();
  renderUsersAdmin();
  renderResults();
   startAnnouncementsListenerForStudents();
}

// Robust alias + fallback binding for resume-aware login handler
document.addEventListener('DOMContentLoaded', () => {
  // If the resume-aware handler exists, expose it as the canonical login function.
  if (typeof handleUserLogin_withResume === 'function') {
    window.handleUserLogin = (...args) => handleUserLogin_withResume(...args);
    // Also ensure the named function exists globally (no-op if already there)
    window.handleUserLogin_withResume = handleUserLogin_withResume;
    console.log('✅ handleUserLogin -> handleUserLogin_withResume aliased');
  } else {
    // If missing, create a safe stub that logs and prevents errors
    window.handleUserLogin = (...args) => {
      console.error('⚠️ handleUserLogin_withResume is not defined yet. Check script order.');
      alert('Internal error: login handler not ready. Open console (F12) for details.');
    };
    console.warn('⚠️ handleUserLogin_withResume not found — installed safe stub.');
  }

  // Additionally, attach to common login button IDs if present, to support direct listeners
  const possibleIds = ['loginBtn', 'btnLogin', 'userLogin', 'userLoginBtn'];
  for (const id of possibleIds) {
    const el = document.getElementById(id);
    if (el) {
      el.removeAttribute('onclick'); // remove inline handler (avoid double-calls)
      el.addEventListener('click', (e) => {
        e.preventDefault();
        try { window.handleUserLogin(); } catch (err) { console.error(err); }
      });
      console.log(`🔗 Bound login handler to #${id}`);
      break; // bind to the first found id
    }
  }

  // If your HTML uses <button onclick="handleUserLogin()"> and that still fails,
  // make sure this script runs AFTER that button is parsed (that's why DOMContentLoaded).
});
// Helper: fetch public IP once
async function getUserIP() {
  try {
    const res = await fetch("https://api.ipify.org?format=json");
    const data = await res.json();
    return data.ip;
  } catch (e) {
    console.warn("⚠️ IP fetch failed", e);
    return "unknown";
  }
}

// Setup visitor session
async function initVisitorSession() {
  let visitorId = localStorage.getItem("visitorId");
  if (!visitorId) {
    visitorId = "v_" + Math.random().toString(36).slice(2,9);
    localStorage.setItem("visitorId", visitorId);
  }

  const ip = await getUserIP();

  // Save/update visitor record in Firestore
  await setDoc(doc(db, "visitors", visitorId), {
    ip,
    visitorId,
    createdAt: Date.now(),
    lastSeen: Date.now()
  }, { merge: true });
// ✅ Update lastSeen every 30s to mark visitor as active
setInterval(async () => {
  try {
    await setDoc(doc(db, "visitors", visitorId), {
      lastSeen: Date.now()
    }, { merge: true });
  } catch (e) {
    console.warn("⚠️ Could not update lastSeen", e);
  }
}, 30_000);
  // Start listening for admin messages
  const ref = doc(db, "visitors", visitorId);
  onSnapshot(ref, snap => {
  if (snap.exists()) {
    const data = snap.data();
    // show or hide cleanly
    if (data.message && String(data.message).trim().length > 0) {
      showVisitorMessage(data.message);
    } else {
      hideVisitorMessage();
    }
  } else {
    hideVisitorMessage();
  }
});
  console.log("👤 Visitor session started:", visitorId, ip);
}

document.addEventListener("DOMContentLoaded", () => {
  if (typeof initVisitorSession === "function") {
    initVisitorSession();
  }
});

 // Admin: render Visitors (before login) with View Msgs and Delete
/*
  Patch: renderVisitorsAdmin
  - Adds "Online"/"Offline" badge for visitors (based on lastSeen threshold)
  - Formats "Seen" time using 12-hour clock (e.g. "Oct 2, 2025, 04:15:02 PM")
  - Keeps existing message/reply UI intact

  How to apply:
  - Replace the existing renderVisitorsAdmin() function in app.js with the code below.
  - This snippet depends only on existing helpers (escapeHTML, collection, getDocs, doc, setDoc, onSnapshot).
  - After replacing, open Admin -> Visitors and refresh — visitors with lastSeen within THRESHOLD_MS will show as Online (green).
*/

async function renderVisitorsAdmin() {
  const out = document.getElementById("adminVisitorsList");
  if (!out) return console.warn('renderVisitorsAdmin: #adminVisitorsList not found');
  out.innerHTML = "<div class='small'>Loading visitors…</div>";

  try {
    const snap = await getDocs(collection(db, "visitors"));
    if (!snap || snap.empty) {
      out.innerHTML = "<div class='small'>No visitors yet.</div>";
      return;
    }

    // helper: format timestamp to 12-hour local format
    const formatLastSeen12 = (ms) => {
      if (!ms) return '-';
      try {
        const d = new Date(Number(ms));
        // include date + time with hour12 true
        return d.toLocaleString(undefined, { year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit', hour12: true });
      } catch (e) { return new Date(Number(ms)).toLocaleString(); }
    };

    const THRESHOLD_MS = 35 * 1000; // 35s window to consider "online" (matches visitor heartbeat 30s)
    const now = Date.now();

    out.innerHTML = "";
    snap.forEach(docSnap => {
      const v = (typeof docSnap.data === 'function') ? docSnap.data() : (docSnap.data || {});
      const vid = v.visitorId || docSnap.id;

      const lastSeenMs = Number(v.lastSeen || 0);
      const isOnline = lastSeenMs && ((now - lastSeenMs) < THRESHOLD_MS);
      const statusHTML = isOnline ? `<span style="color:#34d399;font-weight:700">🟢 Online</span>` : `<span style="color:#f87171;font-weight:700">🔴 Offline</span>`;

      const div = document.createElement("div");
      div.className = "list-item";
      div.style.display = "flex";
      div.style.justifyContent = "space-between";
      div.style.alignItems = "center";

      const left = document.createElement("div");
      left.style.flex = '1';
      left.innerHTML = `
        <div style="font-weight:700">${escapeHTML(vid)} <span style="margin-left:8px">${statusHTML}</span></div>
        <div class="small">IP: ${escapeHTML(v.ip || "unknown")}</div>
        <div class="small">Seen: ${lastSeenMs ? formatLastSeen12(lastSeenMs) : "-"}</div>
        <div class="small" style="color:#2563eb">${v.message ? "Admin → Visitor: " + escapeHTML(v.message) : ""}</div>
        <div class="small" style="color:#22c55e">${v.reply ? "Latest Visitor → Admin: " + escapeHTML(v.reply) : ""}</div>
      `;

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = "8px";

      const msgBtn = document.createElement("button");
      msgBtn.className = "btn brand";
      msgBtn.textContent = "Message";
      msgBtn.onclick = () => sendMessageToVisitor(vid);

      const viewBtn = document.createElement("button");
      viewBtn.className = "btn";
      viewBtn.textContent = "View Msgs";
      viewBtn.onclick = () => viewVisitorMessages(vid);

      const delBtn = document.createElement("button");
      delBtn.className = "btn danger";
      delBtn.textContent = "Delete";
      delBtn.onclick = () => deleteVisitorAndMessages(vid);

      const clearBtn = document.createElement("button");
      clearBtn.className = "btn";
      clearBtn.textContent = "Clear Msg";
      clearBtn.onclick = async () => {
        if (!confirm("Clear message for " + vid + "?")) return;
        await setDoc(doc(db, "visitors", vid), { message: "", messageAt: Date.now() }, { merge: true });
        alert("Cleared.");
        renderVisitorsAdmin();
      };

      right.appendChild(msgBtn);
      right.appendChild(viewBtn);
      right.appendChild(clearBtn);
      right.appendChild(delBtn);

      div.appendChild(left);
      div.appendChild(right);
      out.appendChild(div);
    });

  } catch (err) {
    console.error("renderVisitorsAdmin error", err);
    out.innerHTML = "<div class='small'>Failed to load visitors (see console).</div>";
  }
}

// expose for any inline uses
window.renderVisitorsAdmin = renderVisitorsAdmin;

// Open a small window and show all messages for a visitor (chronological)
// Open a small window and show all messages for a visitor (chronological)
async function viewVisitorMessages(visitorId) {
  try {
    // Fetch only by visitorId (no orderBy — avoids needing an index)
    const q = query(
      collection(db, "visitorMessages"),
      where("visitorId", "==", visitorId)
    );
    const snap = await getDocs(q);

    // Convert to array and sort manually
    const msgs = [];
    snap.forEach(d => msgs.push(d.data()));
    msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));

    const w = window.open("", "_blank", "width=600,height=600");
    w.document.title = `Messages — ${visitorId}`;
    w.document.body.style.background = '#071428';
    w.document.body.style.color = '#e6eef8';
    w.document.body.style.fontFamily = 'system-ui, sans-serif';

    const h = w.document.createElement("div");
    h.style.padding = '12px';
    h.innerHTML = `<h2>Messages for ${escapeHTML(visitorId)}</h2><div style="margin-bottom:8px;">Total: ${msgs.length}</div>`;
    w.document.body.appendChild(h);

    if (msgs.length === 0) {
      const p = w.document.createElement("div");
      p.textContent = "No messages found for this visitor.";
      w.document.body.appendChild(p);
      return;
    }

    msgs.forEach(data => {
      const card = w.document.createElement("div");
      card.style.padding = '8px';
      card.style.border = '1px solid rgba(255,255,255,0.06)';
      card.style.marginBottom = '8px';
      card.style.borderRadius = '6px';
      card.innerHTML = `<div style="font-size:12px;color:#9ca3af">${new Date(data.ts).toLocaleString()} • ${escapeHTML(data.from || '')}</div>
                        <div style="margin-top:6px;white-space:pre-wrap">${escapeHTML(data.text || '')}</div>`;
      w.document.body.appendChild(card);
    });
  } catch (err) {
    console.error("viewVisitorMessages error", err);
    alert("Failed to load messages (see console).");
  }
}



// Delete visitor doc and all related visitorMessages docs
async function deleteVisitorAndMessages(visitorId) {
  if (!confirm(`Delete visitor "${visitorId}" and ALL their messages? This cannot be undone.`)) return;
  try {
    // remove visitor document
    await deleteDoc(doc(db, "visitors", visitorId));

    // find and delete all messages for visitor
    const q = query(collection(db, "visitorMessages"), where("visitorId", "==", visitorId));
    const snap = await getDocs(q);
    if (!snap.empty) {
      const deletions = [];
      snap.forEach(d => {
        deletions.push(deleteDoc(doc(db, "visitorMessages", d.id)));
      });
      await Promise.all(deletions);
    }

    alert("Deleted visitor and their messages.");
    renderVisitorsAdmin();
  } catch (err) {
    console.error("deleteVisitorAndMessages error", err);
    alert("Failed to delete (see console).");
  }
}

async function sendMessageToVisitor(visitorId) {
  if (!visitorId) return alert("Invalid visitorId");
  const msg = prompt("Enter message for " + visitorId + " (max 300 characters):");
  if (msg === null) return; // cancelled
  const text = String(msg).trim().slice(0, 300);
  if (!text) return alert("Message empty.");
  try {
    await setDoc(doc(db, "visitors", visitorId), {
      message: text,
      messageAt: Date.now()
    }, { merge: true });
    alert("✅ Message sent to " + visitorId);
    // optional: refresh the admin list
    renderVisitorsAdmin();
  } catch (err) {
    console.error("sendMessageToVisitor error", err);
    alert("Failed to send message (see console).");
  }
}

  async function sendMessageToVisitor(visitorId) {
  const msg = prompt("Enter message for " + visitorId);
  if (!msg) return;
  await setDoc(doc(db, "visitors", visitorId), {
    message: msg,
    messageAt: Date.now()
  }, { merge: true });
  alert("✅ Message sent to " + visitorId);
}
// --- Visitor message UI (homepage banner) ---
function showVisitorMessage(msg) {
  let banner = document.getElementById("visitorMsg");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "visitorMsg";
    banner.style.cssText = `
      position:fixed;
      top:0;
      left:0;
      width:100%;
      background:#002b5c;
      color:#fff;
      padding:10px 14px;
      text-align:center;
      font-weight:700;
      z-index:99999;
      box-shadow: 0 6px 18px rgba(2,6,23,0.6);
      display:flex;
      justify-content:center;
      align-items:center;
      gap:12px;
    `;

    // span for message text
    const span = document.createElement("span");
    span.id = "visitorMsgText";
    banner.appendChild(span);

    // reply button
    const replyBtn = document.createElement("button");
    replyBtn.textContent = "Reply";
    replyBtn.style.cssText = "padding:4px 10px;border:0;background:#facc15;color:#000;font-weight:700;cursor:pointer;border-radius:4px";
    replyBtn.onclick = () => replyToAdmin();
    banner.appendChild(replyBtn);

    // close button
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✖";
    closeBtn.style.cssText = "padding:4px 8px;background:transparent;border:0;color:#fff;font-weight:700;cursor:pointer";
    closeBtn.onclick = () => hideVisitorMessage();
    banner.appendChild(closeBtn);

    document.body.prepend(banner);
  }
  const span = document.getElementById("visitorMsgText");
  if (span) span.textContent = "📢 Admin: " + msg;
  banner.style.display = "flex";
}
// Visitor -> Admin: write each visitor message as its own doc in `visitorMessages`
async function replyToAdmin() {
  const reply = prompt("Enter your reply to Admin (max 1000 chars):");
  if (!reply) return;
  try {
    const visitorId = localStorage.getItem("visitorId");
    if (!visitorId) return alert("Visitor session not found (visitorId missing).");

    // create a stable id for the message doc
    const id = `${visitorId}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

    const payload = {
      visitorId,
      text: String(reply).trim().slice(0, 1000),
      from: "visitor",
      ts: Date.now()
    };

    // store in new collection visitorMessages
    await setDoc(doc(db, "visitorMessages", id), payload);

    // optional: still keep the legacy 'reply' field for quick glance (merge)
    await setDoc(doc(db, "visitors", visitorId), { reply: payload.text, replyAt: Date.now() }, { merge: true });

    alert("✅ Reply saved (visitor message recorded).");
  } catch (err) {
    console.error("replyToAdmin failed", err);
    alert("⚠️ Could not send reply. See console for details.");
  }
}


function hideVisitorMessage() {
  const banner = document.getElementById("visitorMsg");
  if (!banner) return;
  banner.style.display = "none";
  // optional: remove message field locally to avoid re-showing until admin sets again
  const span = document.getElementById("visitorMsgText");
  if (span) span.textContent = "";
}


/* ---------------- HYBRID EXAM STREAMING ---------------- */

// Hybrid startExamStream: try screen share then camera, publish offer + ICE to screenSignals/{username}
async function startExamStream(username) {
  if (!username) {
    console.warn("startExamStream: missing username");
    return false;
  }
  

  // cleanup any previous stream/pc
  try { await stopExamStream(); } catch(e){}

  const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  let stream = null;
  let usedScreen = false;
  try {
    // try screen share first
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    usedScreen = true;
    console.log("✔️ Using screen share for stream");
  } catch (err) {
    console.warn("Screen share failed / denied — falling back to camera:", err);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      usedScreen = false;
      console.log("✔️ Using camera for stream");
    } catch (err2) {
      console.error("❌ Failed to acquire any media:", err2);
      alert("Unable to access screen or camera. Please allow permission and try again.");
      return false;
    }
  }

  // show local preview in user's UI (muted)
 const previewEl = document.getElementById("remoteVideo");
if (previewEl) {
  previewEl.srcObject = stream;
  previewEl.muted = true;
  try { await previewEl.play(); } catch(e) {}
  previewEl.style.display = "block";   // ✅ show only when stream works
}


  // build peer connection
  const pc = new RTCPeerConnection(RTC_CONFIG);
  window._userPC = pc; // keep reference for later cleanup

  // add tracks
  stream.getTracks().forEach(track => pc.addTrack(track, stream));

  // Firestore signaling locations
  // collection(db, "screenSignals") -> doc(username) -> subcollections offerCandidates / answerCandidates
  const callDoc = doc(collection(db, "screenSignals"), username);
  const offerCandidatesCol = collection(callDoc, "offerCandidates");
  const answerCandidatesCol = collection(callDoc, "answerCandidates");

  // onicecandidate -> upload to offerCandidates
  pc.onicecandidate = event => {
    if (event.candidate) {
      try {
        addDoc(offerCandidatesCol, event.candidate.toJSON()).catch(e => {
          console.warn("addDoc(offerCandidates) failed:", e);
        });
      } catch (e) {
        console.warn("Failed to write candidate:", e);
      }
    }
  };

  // diagnostic
  pc.onconnectionstatechange = () => {
    console.log("PC state:", pc.connectionState);
  };

  try {
    // create offer and set local description
    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);

    // write offer doc (overwrites previous)
    await setDoc(callDoc, {
      offer: {
        type: offerDescription.type,
        sdp: offerDescription.sdp,
        usedScreen: !!usedScreen,
        createdAt: Date.now()
      }
    });

    console.log("📡 Published offer to screenSignals/", username);

    // listen for answer doc — set remote description when available
    const unsubAnswerDoc = onSnapshot(callDoc, async snap => {
      const data = snap.exists() ? snap.data() : null;
      if (!data) return;
      if (data.answer && pc && pc.signalingState !== "closed") {
        try {
          // avoid resetting if already set to same SDP
          const answer = data.answer;
          if (!pc.currentRemoteDescription || pc.currentRemoteDescription.sdp !== answer.sdp) {
            const answerDesc = new RTCSessionDescription({ type: answer.type, sdp: answer.sdp });
            await pc.setRemoteDescription(answerDesc);
            console.log("✅ Remote answer applied from Firestore");
          }
        } catch (err) {
          console.warn("Failed to set remote description (answer):", err);
        }
      }
    });

    // listen for admin answer ICE candidates (admins write into answerCandidates)
    const unsubAnswerCandidates = onSnapshot(answerCandidatesCol, snap => {
      snap.docChanges().forEach(async change => {
        if (change.type === "added") {
          const cand = change.doc.data();
          if (cand) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(cand));
              console.log("➕ Added remote ICE candidate from admin");
            } catch (e) {
              console.warn("addIceCandidate failed for admin candidate:", e);
            }
          }
        }
      });
    });

    // save references for cleanup
    window._userSignaling = {
      callDocRef: callDoc,
      offerCandidatesColRef: offerCandidatesCol,
      answerCandidatesColRef: answerCandidatesCol,
      unsubAnswerDoc,
      unsubAnswerCandidates,
      usedScreen
    };

    console.log("📡 Stream started and signaling listeners attached for", username);
    return true;
  } catch (err) {
    console.error("startExamStream failed during signaling:", err);
    // cleanup on error
    try {
      if (window._userSignaling) {
        try { window._userSignaling.unsubAnswerDoc && window._userSignaling.unsubAnswerDoc(); } catch(e){}
        try { window._userSignaling.unsubAnswerCandidates && window._userSignaling.unsubAnswerCandidates(); } catch(e){}
        window._userSignaling = null;
      }
      if (pc) { pc.close(); window._userPC = null; }
      if (previewEl) { previewEl.srcObject = null; }
      stream.getTracks().forEach(t => { try { t.stop(); } catch(e){} });
    } catch(e){}
    return false;
  }
}
// Stop/cleanup helper (complements the above)
async function stopExamStream() {
  try {
    // stop preview element
    const previewEl = document.getElementById("remoteVideo");
    if (previewEl) {
      try { previewEl.pause(); } catch(e){}
      previewEl.srcObject = null;
    }

    // stop outgoing media tracks and close pc
    if (window._userPC) {
      try {
        const senders = window._userPC.getSenders ? window._userPC.getSenders() : [];
        senders.forEach(s => { try { if (s.track) s.track.stop(); } catch(e){} });
      } catch(e){}
      try { window._userPC.close(); } catch(e){}
      window._userPC = null;
    }

    // unsubscribe listeners
    if (window._userSignaling) {
      try { window._userSignaling.unsubAnswerDoc && window._userSignaling.unsubAnswerDoc(); } catch(e){}
      try { window._userSignaling.unsubAnswerCandidates && window._userSignaling.unsubAnswerCandidates(); } catch(e){}
      window._userSignaling = null;
    }
  } catch (err) {
    console.warn("stopExamStream cleanup error:", err);
  }
}



async function viewUserScreen(username) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  const remoteVideo = document.getElementById("remoteVideo");

  pc.ontrack = event => {
    remoteVideo.srcObject = event.streams[0];
  };

  const callDoc = doc(db, "screenSignals", username);
  const offerCandidates = collection(callDoc, "offerCandidates");
  const answerCandidates = collection(callDoc, "answerCandidates");

  // Save local ICE
  pc.onicecandidate = event => {
    if (event.candidate) {
      addDoc(answerCandidates, event.candidate.toJSON());
    }
  };

  // Load offer
  const callData = (await getDoc(callDoc)).data();
  if (!callData?.offer) {
    alert("No active stream found");
    return;
  }

  await pc.setRemoteDescription(new RTCSessionDescription(callData.offer));

  // Create and set answer
  const answerDescription = await pc.createAnswer();
  await pc.setLocalDescription(answerDescription);

  await updateDoc(callDoc, {
    answer: { type: answerDescription.type, sdp: answerDescription.sdp }
  });

  // Listen for offer ICE
  onSnapshot(offerCandidates, snap => {
    snap.docChanges().forEach(change => {
      if (change.type === "added") {
        const candidate = new RTCIceCandidate(change.doc.data());
        pc.addIceCandidate(candidate);
      }
    });
  });

  document.getElementById("streamUserLabel").textContent = username;
  document.getElementById("streamViewer").classList.remove("hidden");
}
// ===== UI enhancements wiring =====
document.addEventListener('DOMContentLoaded', () => {
  // 1) Theme: persist in localStorage
  const themeToggle = document.getElementById('themeToggle');
  const savedTheme = localStorage.getItem('ui_theme') || 'dark';
  if(savedTheme === 'light') document.documentElement.classList.add('light');

  if(themeToggle){
    themeToggle.addEventListener('click', ()=> {
      const isLight = document.documentElement.classList.toggle('light');
      localStorage.setItem('ui_theme', isLight ? 'light' : 'dark');
      themeToggle.textContent = isLight ? 'Light ✓' : 'Dark ✓';
    });
    // set initial text
    themeToggle.textContent = document.documentElement.classList.contains('light') ? 'Light ✓' : 'Dark ✓';
  }

  // 2) Visitors online counter (uses sessions collection)
  const visitorsCountEl = document.getElementById('visitorsCount');
  const visitorsBadge = document.getElementById('visitorsBadge');
  if(typeof onSnapshot === 'function' && typeof collection === 'function' && typeof db !== 'undefined'){
    try {
      const colRef = collection(db, 'sessions');
      onSnapshot(colRef, snap => {
        // count `updatedAt` within last 60 sec as "online"
        const now = Date.now();
        let count = 0;
        snap.forEach(docSnap => {
          const d = docSnap.data ? docSnap.data() : (docSnap.data || {});
          const updated = d.updatedAt || d.updated_at || 0;
          if(Number(updated) > now - 75_000) count++;
        });
        if(visitorsCountEl) visitorsCountEl.textContent = String(count);
        if(visitorsBadge) visitorsBadge.style.display = (count > 0) ? 'inline-flex' : 'none';
      }, err => {
        // on error hide gracefully
        if(visitorsCountEl) visitorsCountEl.textContent = '--';
      });
    } catch(e) {
      if(visitorsCountEl) visitorsCountEl.textContent = '--';
    }
  } else {
    if(visitorsCountEl) visitorsCountEl.textContent = '—';
  }

  // 3) Hook announcement listener so banner animates (you already have startAnnouncementsListenerForStudents)
  try {
    if(typeof startAnnouncementsListenerForStudents === 'function') startAnnouncementsListenerForStudents();
    // make banner visible if it receives text (render logic in your code already updates #homeAnnouncement)
    const homeAnn = document.getElementById('homeAnnouncement');
    if(homeAnn){
      // show when non-empty
      const obs = new MutationObserver(()=> {
        if(homeAnn.textContent && homeAnn.textContent.trim().length) {
          homeAnn.style.display = 'block';
        } else {
          homeAnn.style.display = 'none';
        }
      });
      obs.observe(homeAnn, { childList:true, subtree:true, characterData:true });
    }
  } catch(e){}

  // 4) Demo quick check: show one sample question from local questions (or seeded ones)
  const demoBtn = document.getElementById('demoBtn');
  const demoModal = document.getElementById('demoModal');
  const demoClose = document.getElementById('demoClose');
  const demoQuestion = document.getElementById('demoQuestion');
  const demoOptions = document.getElementById('demoOptions');

  function showDemo() {
    // pick first question from global `questions` if available, else fallback to sample
    const q = (Array.isArray(window.questions) && window.questions.length) ? window.questions[0] : {
      question: 'Sample: HTML stands for?',
      options: ['Hyperlinks Text Markup','Home Tool Markup','Hyper Text Markup Language','Hyperlinking Text Markdown'],
      answer: 2
    };
    demoQuestion.textContent = q.question || 'Demo question';
    demoOptions.innerHTML = '';
    (q.options || []).forEach((opt, i) => {
      const b = document.createElement('button');
      b.className = 'btn';
      b.style.padding = '8px 12px';
      b.style.borderRadius = '8px';
      b.style.border = '1px solid rgba(255,255,255,0.06)';
      b.textContent = opt;
      b.addEventListener('click', ()=> {
        if(i === (q.answer || 0)) {
          b.textContent = '✅ Correct — ' + opt;
          b.disabled = true;
        } else {
          b.textContent = '❌ Wrong — ' + opt;
          b.disabled = true;
        }
      });
      demoOptions.appendChild(b);
    });
    demoModal.style.display = 'flex';
  }

  if(demoBtn) demoBtn.addEventListener('click', showDemo);
  if(demoClose) demoClose.addEventListener('click', ()=> demoModal.style.display = 'none');
  // close on background click
  if(demoModal) demoModal.addEventListener('click', (ev)=> { if(ev.target === demoModal) demoModal.style.display = 'none'; });
});


















