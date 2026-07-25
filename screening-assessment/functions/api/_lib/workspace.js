// ============================================================================
// Helper bersama: tentukan WORKSPACE dari hostname request, di sisi SERVER.
// ----------------------------------------------------------------------------
// Ini sengaja TIDAK mempercayai field "workspace" yang dikirim client kalau
// hostname-nya sudah dikenali -- supaya kandidat/browser tidak bisa
// "menyamar" mengaku dari workspace lain lewat body request. Kalau nanti
// nambah posisi baru, tambahkan entrinya di HOST_WORKSPACE_MAP saja.
// ============================================================================

export const HOST_WORKSPACE_MAP = {
  'hrga2.jakarta-assessment.center': 'HRGA2',
  'material-logistic.jakarta-assessment.center': 'Material dan Logistik'
};

export const DEFAULT_WORKSPACE = 'HRGA2';

export function resolveWorkspaceFromRequest(request) {
  const host = new URL(request.url).hostname;
  if (HOST_WORKSPACE_MAP[host]) return HOST_WORKSPACE_MAP[host];

  // Fallback untuk testing di domain preview *.pages.dev Cloudflare --
  // di produksi (custom domain asli) baris ini tidak akan pernah kepakai.
  return DEFAULT_WORKSPACE;
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function nowIso() {
  return new Date().toISOString();
}

// ----------------------------------------------------------------------------
// Perbandingan string constant-time, dipakai untuk mencocokkan
// X-Internal-Secret di endpoint yang cuma boleh dipanggil Apps Script
// (session-start, export-pending, mark-exported). `!==` biasa membandingkan
// string karakter-demi-karakter dan berhenti di ketidakcocokan pertama,
// yang secara teori bisa membocorkan sedikit info lewat perbedaan waktu
// respons (timing attack). Risikonya kecil untuk endpoint internal seperti
// ini, tapi perbandingan constant-time ini murah untuk diterapkan dan
// menghilangkan celah itu sama sekali.
export function timingSafeEqual(a, b) {
  const strA = (a || '').toString();
  const strB = (b || '').toString();

  // Encode ke UTF-8 supaya panjang byte konsisten meski ada karakter non-ASCII.
  const bytesA = new TextEncoder().encode(strA);
  const bytesB = new TextEncoder().encode(strB);

  // Kalau panjang beda, TETAP proses sepanjang bytesA (padded) supaya waktu
  // eksekusi tidak langsung mengungkap "panjangnya beda" lebih cepat dari
  // proses normal -- lalu diakhiri dengan penambahan penanda "length mismatch".
  const maxLen = Math.max(bytesA.length, bytesB.length, 1);
  let diff = bytesA.length === bytesB.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const byteA = i < bytesA.length ? bytesA[i] : 0;
    const byteB = i < bytesB.length ? bytesB[i] : 0;
    diff |= byteA ^ byteB;
  }
  return diff === 0;
}

// Helper terpusat untuk validasi header X-Internal-Secret -- dipakai oleh
// session-start.js, export-pending.js, dan mark-exported.js supaya
// perilakunya konsisten (dan supaya perbaikan/perubahan ke depan cukup di
// satu tempat).
export function checkInternalSecret(request, env) {
  const provided = request.headers.get('X-Internal-Secret');
  if (!provided || !env.INTERNAL_SECRET) return false;
  return timingSafeEqual(provided, env.INTERNAL_SECRET);
}
