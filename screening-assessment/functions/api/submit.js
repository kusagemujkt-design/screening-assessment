// ============================================================================
// POST /api/submit
// ----------------------------------------------------------------------------
// DIPANGGIL LANGSUNG DARI BROWSER KANDIDAT saat soal terakhir selesai
// dijawab (baik lewat tombol "Selesai & Submit" maupun auto-submit karena
// timeout di soal terakhir). Menggantikan peran submitAssessment() di
// apps_script.gs untuk bagian status/waktu selesai -- Total Durasi & status
// akhir di SHEET tetap diisi lewat proses export terpisah (lihat
// export-pending.js), bukan di sini.
//
// Body: { token }
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
  if (!token) {
    return jsonResponse({ success: false, message: 'Token wajib diisi.' }, 400);
  }

  const workspace = resolveWorkspaceFromRequest(request);
  const now = nowIso();

  const session = await env.DB.prepare(
    `SELECT status FROM screenings WHERE token = ? AND workspace = ?`
  ).bind(token, workspace).first();

  if (!session) {
    return jsonResponse({ success: false, message: 'Sesi tidak ditemukan.' }, 404);
  }
  if (session.status === 'FINISHED') {
    // Idempotent: kalau sudah FINISHED (misal submit ke-klik dobel / retry
    // jaringan), anggap sukses saja, jangan dianggap error.
    return jsonResponse({ success: true, message: 'Sudah disubmit sebelumnya.' });
  }

  try {
    await env.DB.prepare(
      `UPDATE screenings SET status = 'FINISHED', finished_at = ?, updated_at = ? WHERE token = ? AND workspace = ?`
    ).bind(now, now, token, workspace).run();

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, message: 'Gagal submit: ' + err.message }, 500);
  }
}
