// ============================================================================
// POST /api/session-start
// ----------------------------------------------------------------------------
// DIPANGGIL OLEH APPS SCRIPT (server-to-server), BUKAN oleh browser kandidat
// secara langsung -- ini "serah terima" dari Sheets (sumber validasi token)
// ke D1 (tempat data operasional selama pengerjaan hidup).
//
// Kenapa perlu secret? Endpoint ini yang MEMBUAT sesi baru -- kalau publik
// tanpa proteksi, siapapun bisa membuat baris `screenings` palsu. Endpoint
// lain (autosave/log/submit) dipanggil LANGSUNG dari browser kandidat, jadi
// TIDAK BISA pakai secret (bakal kelihatan di JS), keamanannya beda level --
// lihat catatan di autosave.js.
//
// Body yang diharapkan dari Apps Script:
// {
//   token, nama, email, posisi, client,
//   browser, ip, device   -- (opsional, kalau Apps Script mau teruskan)
// }
// Workspace ditentukan dari HOSTNAME request ini (bukan dari body), sama
// seperti endpoint lain -- jadi Apps Script HARUS memanggil endpoint ini di
// domain yang sesuai (hrga2.jakarta-assessment.center/api/session-start
// untuk token HRGA2, dst).
// ============================================================================
import { resolveWorkspaceFromRequest, jsonResponse, nowIso, checkInternalSecret } from './_lib/workspace.js';

export async function onRequestPost({ request, env }) {
  if (!checkInternalSecret(request, env)) {
    return jsonResponse({ success: false, message: 'Unauthorized.' }, 401);
  }

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

  try {
    // ON CONFLICT DO UPDATE ... WHERE status != 'FINISHED': supaya kalau
    // kandidat reload halaman (Apps Script validateToken terpanggil lagi),
    // baris yang SUDAH FINISHED tidak ke-reset jadi RUNNING lagi.
    await env.DB.prepare(
      `INSERT INTO screenings
         (token, workspace, candidate_name, candidate_email, posisi, client, status, started_at, updated_at, browser, ip, device)
       VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?)
       ON CONFLICT(token, workspace) DO UPDATE SET updated_at = excluded.updated_at
       WHERE screenings.status != 'FINISHED'`
    ).bind(
      token, workspace,
      body.nama || '', body.email || '', body.posisi || '', body.client || '',
      now, now,
      body.browser || '', body.ip || '', body.device || ''
    ).run();

    // Siapkan baris `answers` kosong sekali di awal, supaya autosave pertama
    // tinggal UPDATE (tidak perlu cek INSERT-atau-UPDATE di endpoint autosave).
    await env.DB.prepare(
      `INSERT INTO answers (token, workspace, data, updated_at)
       VALUES (?, ?, '{}', ?)
       ON CONFLICT(token, workspace) DO NOTHING`
    ).bind(token, workspace, now).run();

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, message: 'Gagal membuat sesi: ' + err.message }, 500);
  }
}
