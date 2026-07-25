// ============================================================================
// POST /api/mark-exported
// ----------------------------------------------------------------------------
// DIPANGGIL OLEH APPS SCRIPT, SETELAH berhasil menulis data dari
// /api/export-pending ke Sheet Report. Menandai baris-baris itu supaya tidak
// diambil & ditulis dobel di panggilan export berikutnya.
//
// Body: { tokens: ["ABC12345", "DEF67890", ...] }
// ============================================================================
import { resolveWorkspaceFromRequest, jsonResponse, checkInternalSecret } from './_lib/workspace.js';

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

  const tokens = Array.isArray(body.tokens) ? body.tokens : [];
  if (tokens.length === 0) {
    return jsonResponse({ success: false, message: 'tokens (array) wajib diisi.' }, 400);
  }
  // Sanity bound: export-pending.js membatasi LIMIT 200 per panggilan, jadi
  // 1 batch mark-exported yang wajar tidak akan pernah melebihi itu. Batas
  // ini murni jaring pengaman terhadap payload yang salah/berlebihan.
  if (tokens.length > 500) {
    return jsonResponse({ success: false, message: 'Maksimum 500 token per panggilan.' }, 400);
  }

  const workspace = resolveWorkspaceFromRequest(request);

  try {
    // D1 batch: satu round-trip untuk banyak UPDATE sekaligus, lebih hemat
    // daripada loop `await` satu-satu per token.
    const statements = tokens.map(token =>
      env.DB.prepare(
        `UPDATE screenings SET exported_to_sheet = 1 WHERE token = ? AND workspace = ?`
      ).bind(token, workspace)
    );
    await env.DB.batch(statements);

    return jsonResponse({ success: true, message: tokens.length + ' baris ditandai sudah diekspor.' });
  } catch (err) {
    return jsonResponse({ success: false, message: 'Gagal menandai export: ' + err.message }, 500);
  }
}
