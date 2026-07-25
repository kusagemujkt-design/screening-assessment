/* ============================================================================
   RECRUITMENT SCREENING ASSESSMENT - FRONTEND LOGIC (Vanilla JS)
   ----------------------------------------------------------------------------
   Strategi penyimpanan jawaban:
   - Selama kandidat mengerjakan soal, jawaban HANYA disimpan di localStorage
     browser (state.answers). Ini membuat pengetikan/pemilihan jawaban terasa
     instan tanpa menunggu jaringan, dan aman walau koneksi sempat putus.
   - Jawaban baru dikirim ke Google Sheets (via saveAnswer) pada 2 momen saja:
       1. Saat kandidat menekan tombol "Berikutnya" / "Sebelumnya"
       2. Saat timer soal tersebut habis (timeout)
     Ini mengurangi jumlah request ke Apps Script secara signifikan.
============================================================================ */

// ============================================================================
// KONFIGURASI
// ----------------------------------------------------------------------------
// Portal ini sekarang dipakai di 2 DOMAIN TERPISAH (satu per posisi), masing-
// masing dengan backend Apps Script SENDIRI (bukan lagi 1 backend berbagi).
// Konfigurasi di bawah otomatis pilih backend & workspace yang benar
// berdasarkan domain yang sedang diakses -- tidak perlu edit manual per
// domain, cukup 1 app.js yang sama di-deploy ke keduanya.
// ============================================================================
const HOST_CONFIG = {
  'hrga2.jakarta-assessment.center': {
    apiUrl: 'https://script.google.com/macros/s/AKfycbwfxVAeKNQp4KQo-NxyWakmt5gYsm6_XxqDmqJVBs3gO1QBj1CuCaLQhFaLrpC9PGMp/exec',
    workspace: 'HRGA2'
  },
  'material-logistic.jakarta-assessment.center': {
    apiUrl: 'https://script.google.com/macros/s/AKfycbyhNVaYdcezkqfZvHiiWgYLRq6p_hbBE7WU40R83oSWf2ErsiR8Tk8_xwZubFiIC3pM/exec',
    workspace: 'Material dan Logistik'
  }
};

// Resolusi konfigurasi: (1) cocokkan hostname persis dulu -- ini jalur utama
// di produksi; (2) kalau tidak cocok (misal testing di domain preview
// *.pages.dev Cloudflare), fallback baca ?ws= dari URL; (3) kalau itu juga
// tidak ada, default ke HRGA2 supaya tidak error total saat development.
function resolveHostConfig() {
  const host = window.location.hostname;
  if (HOST_CONFIG[host]) return HOST_CONFIG[host];

  const wsParam = new URLSearchParams(window.location.search).get('ws');
  const matchByWorkspace = Object.values(HOST_CONFIG).find(c => c.workspace === wsParam);
  if (matchByWorkspace) return matchByWorkspace;

  console.warn('Domain "' + host + '" tidak dikenali di HOST_CONFIG, fallback ke HRGA2. ' +
    'Ini normal kalau sedang testing di domain preview Cloudflare.');
  return HOST_CONFIG['hrga2.jakarta-assessment.center'];
}

const ACTIVE_CONFIG = resolveHostConfig();
const API_URL = ACTIVE_CONFIG.apiUrl;

const STORAGE_KEY = 'assessment_state_v1';

// ============================================================================
// STATE GLOBAL
// ============================================================================
// state disimpan penuh di localStorage supaya progres kandidat tidak hilang
// walau tab/browser tertutup tidak sengaja.
let state = {
  token: null,
  workspace: ACTIVE_CONFIG.workspace, // ditentukan dari domain, BUKAN lagi dari ?ws= saja
  candidate: null,     // { token, nama, email, posisi, client }
  questions: [],        // hasil dari getQuestions
  currentIndex: 0,
  answers: {},          // { [questionId]: { answer, remaining, spent, synced } }
  finished: false
};

let timerInterval = null;

// ============================================================================
// HELPER: PANGGIL API GOOGLE APPS SCRIPT
// ----------------------------------------------------------------------------
// Menggunakan Content-Type "text/plain" (bukan application/json) supaya
// browser mengirim request ini sebagai "simple request" dan TIDAK memicu
// CORS preflight (OPTIONS) yang tidak didukung baik oleh Apps Script.
// Body tetap berupa string JSON, dan di backend (doPost) kita JSON.parse().
//
// "workspace" otomatis disertakan di SETIAP panggilan (dari state.workspace)
// supaya backend tahu spreadsheet departemen mana yang harus dibaca/ditulis
// -- tidak perlu ditambahkan manual di tiap pemanggilan callAPI().
// ============================================================================
async function callAPI(action, payload, showLoading = true) {
  if (showLoading) toggleLoading(true);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action: action, workspace: state.workspace }, payload))
    });
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('Gagal menghubungi server:', err);
    return { success: false, message: 'Tidak dapat terhubung ke server. Periksa koneksi internet Anda.' };
  } finally {
    if (showLoading) toggleLoading(false);
  }
}

// ============================================================================
// HELPER: PANGGIL D1 (Cloudflare Pages Functions)
// ----------------------------------------------------------------------------
// Data operasional (autosave jawaban, log aktivitas, submit) SEKARANG lewat
// D1, BUKAN lagi Apps Script (lihat PROJECT-HANDOVER.md bagian migrasi D1).
// Path relatif ("/api/...") sengaja dipakai, BUKAN URL absolut -- karena
// Pages Functions ini hidup di domain yang SAMA dengan halaman ini sendiri
// (hrga2.jakarta-assessment.center atau material-logistic....), jadi
// otomatis kena workspace yang benar tanpa perlu config tambahan, dan tidak
// perlu CORS sama sekali (same-origin).
// ============================================================================
async function callD1(endpoint, payload, showLoading = false) {
  if (showLoading) toggleLoading(true);
  try {
    const res = await fetch('/api/' + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error('Gagal menghubungi D1 (' + endpoint + '):', err);
    return { success: false, message: 'Tidak dapat terhubung ke server. Periksa koneksi internet Anda.' };
  } finally {
    if (showLoading) toggleLoading(false);
  }
}

function toggleLoading(show) {
  const overlay = document.getElementById('loading-overlay');
  overlay.classList.toggle('hidden', !show);
}

// Ambil IP publik browser ini lewat layanan gratis ipify.org, di-cache
// supaya cuma fetch sekali per sesi (bukan diulang tiap logEvent dipanggil).
// CATATAN: ini IP yang dilaporkan sendiri oleh browser, bukan dibaca server
// Apps Script secara langsung -- lihat penjelasan di apps_script.gs.
let cachedClientIp = null;
let ipFetchPromise = null;
function getClientIp() {
  if (cachedClientIp !== null) return Promise.resolve(cachedClientIp);
  if (!ipFetchPromise) {
    // Timeout eksplisit (3 detik) -- tanpa ini, kalau jaringan kandidat
    // memblokir/melambatkan domain pihak ketiga (umum di jaringan korporat/
    // kampus dengan firewall ketat), fetch() bisa menggantung tanpa pernah
    // resolve/reject. Karena login/submit meng-`await` getClientIp() lebih
    // dulu, itu berarti kandidat bisa macet total di layar loading tanpa
    // error apapun. AbortController disini menjamin promise ini SELALU
    // selesai dalam waktu terbatas, baik berhasil maupun tidak.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    ipFetchPromise = fetch('https://api.ipify.org?format=json', { signal: controller.signal })
      .then(res => res.json())
      .then(data => { cachedClientIp = data.ip || ''; return cachedClientIp; })
      .catch(() => { cachedClientIp = ''; return ''; }) // gagal/timeout ambil IP tidak boleh menghentikan alur lain
      .finally(() => clearTimeout(timeoutId));
  }
  return ipFetchPromise;
}

// Kirim event ke D1 (tabel logs). Tidak menampilkan loading overlay karena
// ini proses "diam-diam" di background dan tidak boleh mengganggu pengalaman
// user. tokenOverride dipakai untuk event yang terjadi SEBELUM state.token
// terisi (misal saat halaman baru dibuka, atau token yang diketik salah).
async function logEvent(event, tokenOverride) {
  const ip = await getClientIp();
  callD1('log', {
    token: tokenOverride !== undefined ? tokenOverride : state.token,
    event: event,
    detail: { ip: ip, browser: navigator.userAgent }
  });
}

// ============================================================================
// LOCALSTORAGE: SIMPAN & MUAT STATE
// ============================================================================
function persistState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadPersistedState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.token && !parsed.finished) {
      state = parsed;
      return true;
    }
  } catch (e) { /* abaikan data rusak */ }
  return false;
}

function clearPersistedState() {
  localStorage.removeItem(STORAGE_KEY);
}

// ============================================================================
// PAGE SWITCHER
// ============================================================================
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active-page'));
  document.getElementById(pageId).classList.add('active-page');
}

// ============================================================================
// LOGIN
// ============================================================================
const loginForm = document.getElementById('login-form');
const tokenInput = document.getElementById('token-input');
const loginError = document.getElementById('login-error');

loginForm.addEventListener('submit', async function (e) {
  e.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) return;

  loginError.classList.add('hidden');
  document.getElementById('btn-start').disabled = true;

  // Kirim browser/ip/device supaya Apps Script bisa teruskan ke D1 saat
  // membuat sesi screening (lihat createD1Session di apps_script.gs).
  const ip = await getClientIp();
  const device = /Mobile|Android|iPhone/i.test(navigator.userAgent) ? 'Mobile' : 'Desktop';
  const result = await callAPI('validateToken', {
    token: token,
    browser: navigator.userAgent,
    ip: ip,
    device: device
  });

  document.getElementById('btn-start').disabled = false;

  if (!result.success) {
    loginError.textContent = result.message || 'Token tidak valid.';
    loginError.classList.remove('hidden');
    // Catat percobaan token yang gagal -- ini penting untuk mengukur minat/
    // antusiasme (misal kandidat sempat coba tapi salah ketik, atau link
    // sudah kedaluwarsa), bukan cuma yang berhasil login.
    logEvent('TOKEN SALAH', token);
    return;
  }

  // Token valid -> siapkan state baru
  state.token = token;
  state.candidate = result.candidate;
  state.currentIndex = 0;
  state.answers = {};
  state.finished = false;

  logEvent('LOGIN');

  const qResult = await callAPI('getQuestions', {});
  if (!qResult.success || !qResult.questions || qResult.questions.length === 0) {
    loginError.textContent = 'Tidak ada pertanyaan aktif yang tersedia saat ini.';
    loginError.classList.remove('hidden');
    return;
  }

  state.questions = qResult.questions;
  persistState();
  startAssessment();
});

// ============================================================================
// MULAI / LANJUTKAN ASSESSMENT
// ============================================================================
function startAssessment() {
  document.getElementById('candidate-name').textContent = state.candidate ? state.candidate.nama : '';
  renderSidebar();
  renderQuestion(state.currentIndex);
  showPage('assessment-page');
}

// ============================================================================
// RENDER SIDEBAR (DAFTAR NOMOR SOAL)
// ============================================================================
function renderSidebar() {
  const nav = document.getElementById('question-nav');
  nav.innerHTML = '';

  state.questions.forEach((q, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'q-nav-item';
    btn.textContent = idx + 1;

    const isAnswered = !!(state.answers[q.id] && hasValue(state.answers[q.id].answer));
    const isActive = idx === state.currentIndex;
    const isVisited = state.answers.hasOwnProperty(q.id) || isActive;

    if (isActive) btn.classList.add('active');
    else if (isAnswered) btn.classList.add('answered');

    // Hanya boleh loncat ke soal yang sudah pernah dikunjungi/dijawab,
    // supaya kandidat tidak bisa "mengintip" soal berikutnya lewat sidebar.
    if (!isVisited) {
      btn.disabled = true;
    } else {
      btn.addEventListener('click', () => goToQuestion(idx));
    }

    nav.appendChild(btn);
  });

  updateProgress();
}

function hasValue(val) {
  return val !== undefined && val !== null && val.toString().trim() !== '';
}

function updateProgress() {
  const total = state.questions.length;
  const answeredCount = Object.keys(state.answers).filter(id => hasValue(state.answers[id].answer)).length;
  document.getElementById('question-counter').textContent =
    `Soal ${state.currentIndex + 1} dari ${total}`;
  document.getElementById('progress-bar-fill').style.width =
    total > 0 ? `${Math.round((answeredCount / total) * 100)}%` : '0%';
}

// ============================================================================
// RENDER PERTANYAAN
// ============================================================================
function renderQuestion(index) {
  stopTimer();

  const q = state.questions[index];
  if (!q) return;

  document.getElementById('question-text').textContent = q.pertanyaan;

  const optionsContainer = document.getElementById('options-container');
  const essayContainer = document.getElementById('essay-container');
  const essayInput = document.getElementById('essay-answer');

  const savedAnswer = state.answers[q.id] ? state.answers[q.id].answer : '';

  if (String(q.jenis).toLowerCase().indexOf('esai') !== -1) {
    // ---- Jenis: ESAI ----
    optionsContainer.classList.add('hidden');
    essayContainer.classList.remove('hidden');
    essayInput.value = savedAnswer || '';
    essayInput.oninput = () => cacheAnswer(q.id, essayInput.value);
  } else {
    // ---- Jenis: PILIHAN GANDA ----
    essayContainer.classList.add('hidden');
    optionsContainer.classList.remove('hidden');
    optionsContainer.innerHTML = '';

    const opsiList = [
      { letter: 'A', text: q.opsiA },
      { letter: 'B', text: q.opsiB },
      { letter: 'C', text: q.opsiC },
      { letter: 'D', text: q.opsiD }
    ];

    opsiList.forEach(opt => {
      if (!hasValue(opt.text)) return; // skip opsi kosong

      const label = document.createElement('label');
      label.className = 'option-item';
      if (savedAnswer === opt.letter) label.classList.add('selected');

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'option-' + q.id;
      radio.value = opt.letter;
      radio.checked = savedAnswer === opt.letter;
      radio.addEventListener('change', () => {
        cacheAnswer(q.id, opt.letter);
        // refresh tampilan highlight opsi terpilih
        optionsContainer.querySelectorAll('.option-item').forEach(el => el.classList.remove('selected'));
        label.classList.add('selected');
      });

      const letterSpan = document.createElement('span');
      letterSpan.className = 'option-label-letter';
      letterSpan.textContent = opt.letter + '.';

      const textSpan = document.createElement('span');
      textSpan.textContent = opt.text;

      label.appendChild(radio);
      label.appendChild(letterSpan);
      label.appendChild(textSpan);
      optionsContainer.appendChild(label);
    });
  }

  // Tombol "Sebelumnya" nonaktif di soal pertama
  document.getElementById('btn-prev').disabled = (index === 0);
  // Label tombol "Berikutnya" jadi "Selesai" di soal terakhir
  document.getElementById('btn-next').textContent =
    (index === state.questions.length - 1) ? 'Selesai & Submit' : 'Berikutnya →';

  renderSidebar();
  startTimer(q);
}

// Menyimpan jawaban ke localStorage saja (TANPA request ke server).
// Ini yang membuat pengetikan terasa instan.
function cacheAnswer(questionId, value) {
  if (!state.answers[questionId]) {
    state.answers[questionId] = { answer: '', remaining: null, spent: 0, synced: false };
  }
  state.answers[questionId].answer = value;
  state.answers[questionId].synced = false;
  persistState();
  renderSidebar();
}

// ============================================================================
// TIMER PER SOAL
// ============================================================================
function startTimer(question) {
  const badge = document.getElementById('timer-badge');
  const text = document.getElementById('timer-text');

  const maxTime = Number(question.waktuMaksimum) || 60;

  // Pakai sisa waktu tersimpan jika soal ini pernah dikunjungi sebelumnya
  const existing = state.answers[question.id];
  let remaining = (existing && typeof existing.remaining === 'number') ? existing.remaining : maxTime;

  updateTimerUI(remaining, maxTime, badge, text);

  timerInterval = setInterval(() => {
    remaining -= 1;

    // Simpan sisa waktu ke state supaya jika kandidat pindah soal lalu
    // kembali lagi, hitung mundur melanjutkan dari sisa waktu terakhir.
    if (!state.answers[question.id]) {
      state.answers[question.id] = { answer: '', remaining: remaining, spent: 0, synced: false };
    } else {
      state.answers[question.id].remaining = remaining;
    }

    updateTimerUI(remaining, maxTime, badge, text);

    if (remaining <= 0) {
      stopTimer();
      handleTimeout(question);
    }
  }, 1000);
}

function updateTimerUI(remaining, maxTime, badge, text) {
  const safeRemaining = Math.max(remaining, 0);
  const minutes = Math.floor(safeRemaining / 60).toString().padStart(2, '0');
  const seconds = (safeRemaining % 60).toString().padStart(2, '0');
  text.textContent = `${minutes}:${seconds}`;

  const ratio = safeRemaining / maxTime;
  badge.classList.remove('timer-green', 'timer-yellow', 'timer-red');
  if (ratio > 0.5) {
    badge.classList.add('timer-green');
  } else if (ratio > 0.2) {
    badge.classList.add('timer-yellow');
  } else {
    badge.classList.add('timer-red');
  }
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// Waktu soal habis: simpan jawaban ke server, catat log TIMEOUT,
// lalu otomatis lanjut ke soal berikutnya (atau submit jika soal terakhir).
async function handleTimeout(question) {
  await syncAnswerToServer(question.id);
  logEvent('TIMEOUT');

  if (state.currentIndex === state.questions.length - 1) {
    await finishAssessment();
  } else {
    state.currentIndex += 1;
    persistState();
    renderQuestion(state.currentIndex);
  }
}

// ============================================================================
// SINKRONISASI JAWABAN KE D1 (Cloudflare)
// ----------------------------------------------------------------------------
// BUKAN lagi ke Google Sheets langsung -- Sheets diisi belakangan lewat
// proses export terjadwal (lihat runExportPendingScreenings di
// apps_script.gs). Ini murni tulis ke D1, cepat & tidak kena limit GAS.
// ============================================================================
async function syncAnswerToServer(questionId) {
  const entry = state.answers[questionId];
  if (!entry) return;

  const question = state.questions.find(q => q.id === questionId);
  const maxTime = question ? (Number(question.waktuMaksimum) || 60) : 0;
  const remaining = typeof entry.remaining === 'number' ? entry.remaining : maxTime;
  const spentSeconds = Math.max(maxTime - remaining, 0);

  const result = await callD1('autosave', {
    token: state.token,
    questionId: questionId,
    answer: entry.answer || '',
    duration: spentSeconds,
    nomor: question ? question.nomor : undefined
  });

  if (result.success) {
    entry.synced = true;
    persistState();
    // SENGAJA TIDAK logEvent() di sini -- sesuai keputusan dimensioning di
    // PROJECT-HANDOVER.md, log per-soal (AUTO SAVE/NEXT QUESTION) dihindari
    // supaya tidak boros kuota write D1 harian. Riwayat waktu tiap jawaban
    // sudah cukup terekam lewat field "savedAt" di dalam data JSON jawaban
    // itu sendiri (tabel `answers`), tidak perlu baris log terpisah lagi.
  } else {
    // Jangan biarkan kegagalan ini hilang tanpa jejak -- tampilkan di console
    // supaya mudah dicek lewat DevTools (F12) kalau ada laporan jawaban tidak tersimpan.
    console.error('Gagal menyimpan jawaban ke sheet:', result.message);
  }
}

// ============================================================================
// TOMBOL NAVIGASI: SEBELUMNYA / BERIKUTNYA
// ============================================================================
document.getElementById('btn-next').addEventListener('click', async function () {
  const btn = this;
  btn.disabled = true;

  const currentQuestion = state.questions[state.currentIndex];
  await syncAnswerToServer(currentQuestion.id);
  // SENGAJA TIDAK logEvent('NEXT QUESTION') -- lihat catatan dimensioning
  // di syncAnswerToServer(). Progress soal cukup terekam lewat
  // `current_question` di tabel screenings (D1), diupdate bareng autosave.

  if (state.currentIndex === state.questions.length - 1) {
    await finishAssessment();
  } else {
    state.currentIndex += 1;
    persistState();
    renderQuestion(state.currentIndex);
  }

  btn.disabled = false;
});

document.getElementById('btn-prev').addEventListener('click', async function () {
  if (state.currentIndex === 0) return;
  const btn = this;
  btn.disabled = true;

  const currentQuestion = state.questions[state.currentIndex];
  await syncAnswerToServer(currentQuestion.id);

  state.currentIndex -= 1;
  persistState();
  renderQuestion(state.currentIndex);

  btn.disabled = false;
});

// ============================================================================
// SUBMIT ASSESSMENT (SETELAH SOAL TERAKHIR)
// ============================================================================
async function finishAssessment() {
  stopTimer();
  await callD1('submit', { token: state.token }, true); // showLoading:true, ini aksi terakhir & penting, wajar ada jeda kelihatan
  logEvent('AUTO SUBMIT'); // milestone -- tetap dicatat, beda dengan log per-soal yang sudah dihapus

  state.finished = true;
  clearPersistedState();
  showPage('finish-page');
}

// ============================================================================
// INISIALISASI SAAT HALAMAN DIMUAT
// Jika ada sesi assessment yang belum selesai tersimpan di localStorage
// (misalnya kandidat reload halaman di tengah pengerjaan), lanjutkan
// dari soal terakhir yang sedang dikerjakan tanpa perlu login ulang.
// ============================================================================
(function init() {
  // state.workspace SUDAH ditentukan lewat ACTIVE_CONFIG (berdasar domain yang
  // diakses, lihat resolveHostConfig di atas) -- tidak perlu baca ?ws= lagi
  // di sini secara terpisah, supaya tidak ada 2 sumber kebenaran yang bisa beda.

  // Catat SETIAP kali portal ini dibuka, sebelum tahu apakah kandidat akan
  // login atau tidak -- ini sinyal minat/antusiasme mentah (berapa kali link
  // benar-benar diklik & dibuka), terpisah dari LOGIN yang cuma tercatat
  // kalau tokennya valid. Pakai token dari URL kalau ada (belum tentu valid).
  var urlTokenForLog = new URLSearchParams(window.location.search).get('token') || '';
  logEvent('BUKA HALAMAN', urlTokenForLog);

  const restored = loadPersistedState();
  if (restored && state.questions && state.questions.length > 0) {
    startAssessment();
    return;
  }

  showPage('login-page');

  // Jika link dibuka dengan ?token=XXXX (dibuat dari dashboard recruiter),
  // otomatis isi kolom token DAN langsung submit, supaya kandidat tidak perlu
  // mengetik ulang atau klik tombol "Mulai Assessment" secara manual.
  const urlToken = new URLSearchParams(window.location.search).get('token');
  if (urlToken) {
    tokenInput.value = urlToken;
    loginForm.requestSubmit ? loginForm.requestSubmit() : loginForm.dispatchEvent(new Event('submit'));
  }
})();
