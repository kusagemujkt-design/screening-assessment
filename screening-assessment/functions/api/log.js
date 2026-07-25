// ============================================================================
// POST /api/log
// ----------------------------------------------------------------------------
// DIPANGGIL LANGSUNG DARI BROWSER KANDIDAT. Sengaja PERMISIF -- tidak
// mensyaratkan baris `screenings` sudah ada, karena event seperti
// "BUKA HALAMAN" dan "TOKEN SALAH" justru terjadi SEBELUM sesi resmi dibuat.
//
// HANYA untuk event milestone (bukan per-soal) -- lihat catatan dimensioning
// di PROJECT-HANDOVER.md kenapa ini penting untuk kuota write harian D1.
//
// Body: { token, event, detail (opsional, object bebas) }
// ============================================================================
import { resolveWorkspaceFromRequest, jsonResponse, nowIso } from './_lib/workspace.js';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ success: false, message: 'Body harus JSON valid.' }, 400);
  }

  const token = (body.token || '(belum ada token)').toString().trim().slice(0, 200);
  const event = (body.event || '').toString().trim().slice(0, 200);
  if (!event) {
    return jsonResponse({ success: false, message: 'Event wajib diisi.' }, 400);
  }

  const workspace = resolveWorkspaceFromRequest(request);
  // Endpoint ini sengaja permisif (tidak mensyaratkan sesi ada -- lihat
  // komentar di atas), jadi lebih terbuka untuk disalahgunakan dibanding
  // autosave/submit. Batasi ukuran `detail` supaya payload besar/berulang
  // tidak bisa membebani tabel `logs` (append-only, tidak ada pembersihan).
  let detail = body.detail ? JSON.stringify(body.detail) : null;
  if (detail && detail.length > 5000) {
    detail = detail.slice(0, 5000);
  }

  try {
    await env.DB.prepare(
      `INSERT INTO logs (token, workspace, event, timestamp, detail) VALUES (?, ?, ?, ?, ?)`
    ).bind(token, workspace, event, nowIso(), detail).run();

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, message: 'Gagal mencatat log: ' + err.message }, 500);
  }
}
