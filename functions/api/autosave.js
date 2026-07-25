// ============================================================================
// POST /api/autosave
// ----------------------------------------------------------------------------
// DIPANGGIL LANGSUNG DARI BROWSER KANDIDAT (app.js), sama seperti saveAnswer
// di apps_script.gs dulu. TIDAK pakai secret (browser tidak bisa simpan
// rahasia) -- keamanannya cuma: token harus ada & statusnya RUNNING.
//
// Model kepercayaan ini SAMA seperti sistem yang sudah berjalan sejak awal
// (token = bearer credential) -- bukan pengurangan keamanan dibanding
// sebelumnya, cuma dipindah lokasinya dari Apps Script ke sini.
//
// Body: { token, questionId, answer, duration }
// Workspace ditentukan dari hostname (lihat _lib/workspace.js).
// ============================================================================
import { resolveWorkspaceFromRequest, jsonResponse, nowIso } from './_lib/workspace.js';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ success: false, message: 'Body harus JSON valid.' }, 400);
  }

  const token = (body.token || '').toString().trim();
  const questionId = (body.questionId || '').toString().trim();
  const answer = body.answer !== undefined ? body.answer : '';
  const duration = Number(body.duration) || 0;

  if (!token || !questionId) {
    return jsonResponse({ success: false, message: 'Token dan questionId wajib diisi.' }, 400);
  }

  // Validasi bentuk questionId -- ini disisipkan langsung ke dalam path JSON
  // SQLite ('$."<questionId>"') lewat string concatenation di bawah, jadi
  // harus dibatasi ke karakter aman untuk mencegah path JSON yang rusak/tidak
  // terduga (tidak bisa keluar dari baris token ini, tapi tetap bisa merusak
  // integritas JSON milik token itu sendiri kalau dibiarkan bebas).
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(questionId)) {
    return jsonResponse({ success: false, message: 'questionId tidak valid.' }, 400);
  }

  const workspace = resolveWorkspaceFromRequest(request);
  const now = nowIso();

  // --- Pastikan sesi ini benar ada & masih RUNNING sebelum menerima autosave ---
  const session = await env.DB.prepare(
    `SELECT status FROM screenings WHERE token = ? AND workspace = ?`
  ).bind(token, workspace).first();

  if (!session) {
    return jsonResponse({ success: false, message: 'Sesi tidak ditemukan. Silakan login ulang.' }, 404);
  }
  if (session.status === 'FINISHED') {
    return jsonResponse({ success: false, message: 'Screening ini sudah disubmit, autosave ditolak.' }, 409);
  }

  const answerEntry = JSON.stringify({ answer, duration, savedAt: now });

  try {
    // json_set() adalah fungsi bawaan SQLite (D1 berbasis SQLite) -- ini yang
    // memungkinkan "update 1 field di dalam JSON blob" tanpa perlu baca dulu
    // seluruh isi lalu tulis ulang dari sisi aplikasi (hindari race condition).
    //
    // PAKAI UPSERT (INSERT ... ON CONFLICT DO UPDATE), BUKAN UPDATE polos --
    // kalau baris `answers` untuk token ini ternyata belum ada (mis. insert
    // di session-start.js gagal/ke-skip karena sebab apapun), UPDATE polos
    // akan mengubah 0 baris TANPA error, dan endpoint ini tetap membalas
    // {success:true} padahal jawaban kandidat sama sekali tidak tersimpan.
    // json_set(coalesce(data,'{}'), ...) dipakai karena baris baru dari
    // INSERT belum punya isi 'data' untuk di-json_set pada saat itu juga.
    const result = await env.DB.prepare(
      `INSERT INTO answers (token, workspace, data, updated_at)
       VALUES (?, ?, json_set('{}', '$."' || ? || '"', json(?)), ?)
       ON CONFLICT(token, workspace) DO UPDATE SET
         data = json_set(coalesce(answers.data, '{}'), '$."' || ? || '"', json(?)),
         updated_at = excluded.updated_at`
    ).bind(
      token, workspace, questionId, answerEntry, now,
      questionId, answerEntry
    ).run();

    // Jaga-jaga tambahan: kalau karena alasan lain tidak ada baris yang
    // ter-affect sama sekali, laporkan sebagai kegagalan (bukan silent
    // success) supaya kandidat/tim tahu jawaban tidak tersimpan.
    if (!result || result.meta?.changes === 0) {
      return jsonResponse({ success: false, message: 'Gagal menyimpan jawaban: tidak ada baris yang tersimpan.' }, 500);
    }

    // current_question dipakai kalau nanti dashboard mau live-view progress;
    // update ini "menumpang" di request yang sama, tidak nambah write terpisah.
    // Cek eksplisit undefined/null/'' (bukan `Number(x) || null`) supaya
    // nomor soal 0 (kalau suatu saat penomoran mulai dari 0) tidak ikut
    // di-treat sebagai "tidak ada nomor" oleh falsy-check.
    const nomorSoal = (body.nomor !== undefined && body.nomor !== null && body.nomor !== '')
      ? Number(body.nomor)
      : null;
    if (nomorSoal !== null && !Number.isNaN(nomorSoal)) {
      await env.DB.prepare(
        `UPDATE screenings SET current_question = ?, updated_at = ? WHERE token = ? AND workspace = ?`
      ).bind(nomorSoal, now, token, workspace).run();
    }

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, message: 'Gagal menyimpan jawaban: ' + err.message }, 500);
  }
}
