// ============================================================================
// GET /api/export-pending
// ----------------------------------------------------------------------------
// DIPANGGIL OLEH APPS SCRIPT (server-to-server, pakai secret sama seperti
// session-start.js) lewat time-driven trigger terjadwal (misal tiap 15
// menit). Apps Script yang MENULIS hasilnya ke Sheet (Kandidat + Jawaban),
// D1 di sini cuma jadi sumber data yang dibaca, tidak menulis ke Sheets
// sendiri -- supaya semua penulisan Sheets tetap lewat 1 jalur (Apps Script),
// konsisten dengan cara kerja fitur lain yang sudah ada.
//
// Response: { success, screenings: [ { token, candidateName, ..., answers: {...} } ] }
// ============================================================================
import { resolveWorkspaceFromRequest, jsonResponse, checkInternalSecret } from './_lib/workspace.js';

export async function onRequestGet({ request, env }) {
  if (!checkInternalSecret(request, env)) {
    return jsonResponse({ success: false, message: 'Unauthorized.' }, 401);
  }

  const workspace = resolveWorkspaceFromRequest(request);

  try {
    // LIMIT 200: batasi per panggilan, supaya 1 eksekusi trigger tidak kelamaan
    // ORDER BY finished_at ASC: kalau backlog pernah menumpuk lebih dari 200
    // (mis. trigger sempat berhenti lama), yang FINISHED lebih dulu diproses
    // lebih dulu (FIFO) -- tanpa ini SQLite tidak menjamin urutan tertentu.
    const { results } = await env.DB.prepare(
      `SELECT s.token, s.candidate_name, s.candidate_email, s.posisi, s.client,
              s.started_at, s.finished_at, a.data AS answers_json
       FROM screenings s
       LEFT JOIN answers a ON a.token = s.token AND a.workspace = s.workspace
       WHERE s.workspace = ? AND s.status = 'FINISHED' AND s.exported_to_sheet = 0
       ORDER BY s.finished_at ASC
       LIMIT 200`
    ).bind(workspace).all();

    const screenings = results.map(row => ({
      token: row.token,
      candidateName: row.candidate_name,
      candidateEmail: row.candidate_email,
      posisi: row.posisi,
      client: row.client,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      answers: row.answers_json ? JSON.parse(row.answers_json) : {}
    }));

    return jsonResponse({ success: true, screenings });
  } catch (err) {
    return jsonResponse({ success: false, message: 'Gagal ambil data export: ' + err.message }, 500);
  }
}
