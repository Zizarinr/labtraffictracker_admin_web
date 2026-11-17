'use strict';

/**
 * Single Source of Truth untuk Versi Aplikasi & Riwayat Pembaruan (Changelog).
 * Digunakan oleh:
 * - Endpoint `/api/health`, `/api/auth/me`, dan `/api/version`
 * - Footer & Modal "Info Pembaruan / Riwayat Versi" di dalam aplikasi web
 * - Referensi rilis developer (selaras dengan CHANGELOG.md & package.json)
 */
const CURRENT_VERSION = '1.1.0';

const RELEASES = [
  {
    version: '1.1.0',
    date: '2026-11-17',
    title: 'Penyempurnaan Portal Login, Theme Toggle (Light/Dark), Footer, & Dokumentasi Versi',
    summary:
      'Pembaruan antarmuka pengguna dengan dukungan mode terang/gelap, kustomisasi visual portal login laboratorium, penambahan favicon & footer kredit, serta pencatatan versi terintegrasi.',
    user_changes: [
      'Menambahkan tombol Theme Toggle (Mode Terang & Mode Gelap) di Portal Login dan Dashboard yang tersimpan otomatis.',
      'Memperbarui tampilan Portal Login (/login) dengan background ruang laboratorium berefek transparansi serta identitas Logo Lab, Prodi TI, dan UNIDA.',
      'Merapikan Sidebar Dashboard agar tetap bersih dan fokus operasional (logo institusi hanya ditampilkan di halaman Login).',
      'Menambahkan Favicon aplikasi serta Footer resmi yang memuat kredit pengembang, tautan aplikasi sumber Lab Traffic Tracker, dan panel Riwayat Versi (Changelog).',
    ],
    dev_notes: [
      'Menambahkan modul `src/version.js` dan endpoint `GET /api/version` sebagai Single Source of Truth informasi rilis.',
      'Menambahkan `CHANGELOG.md` dengan standar Semantic Versioning (vMAJOR.MINOR.PATCH).',
      'Menambahkan `public/favicon.svg` dan handler `/favicon.ico` untuk mencegah HTTP 404 pada browser.',
    ],
  },
  {
    version: '1.0.1',
    date: '2026-11-16',
    title: 'Pemisahan Endpoint Portal Login (/login) & Proteksi Route Dashboard',
    summary:
      'Memisahkan alamat URL halaman login dari konsol utama serta memperkuat proteksi sesi langsung di tingkat server.',
    user_changes: [
      'Portal Login kini memiliki alamat khusus di `/login` yang terpisah dari halaman `/dashboard`.',
      'Setiap menu di sidebar kini memiliki alamat URL tersendiri (`/dashboard`, `/visits`, `/laboratories`, `/inventory`, `/import-audit`) sehingga aman saat di-refresh (F5) atau di-bookmark.',
      'Pengguna yang belum login akan otomatis diarahkan ke `/login` dan dikembalikan ke halaman tujuan semula setelah berhasil masuk.',
    ],
    dev_notes: [
      'Memecah `public/index.html` menjadi `public/login.html` (+ `public/login.js`) dan `public/dashboard.html`.',
      'Menerapkan server-side session guard dengan header `Cache-Control: no-store` pada seluruh route konsol admin di `src/app.js`.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-11-14',
    title: 'Rilis Awal MVP — Sistem Pusat Monitoring Kunjungan & Inventaris Laboratorium',
    summary:
      'Fondasi utama sistem penerima sinkronisasi kunjungan multi-lab dari aplikasi kiosk Lab Scan KTM serta manajemen inventaris peralatan laboratorium.',
    user_changes: [
      'Dashboard ringkasan operasional: memantau kunjungan hari ini, jumlah mahasiswa unik, status kesehatan kiosk per lab (Online/Silent/Backlog), grafik tren 7 hari, dan 50 Live Feed terakhir.',
      'Eksplorasi Data Kunjungan: pencarian NIM/nama, filter tanggal/lab/status/kelas/semester, laci detail kunjungan, riwayat kunjungan mahasiswa lintas lab, serta ekspor Excel/CSV.',
      'Manajemen Laboratorium & Token: pendaftaran `lab_id`, rotasi Bearer token sekali tampil, dan generator konfigurasi `.env` siap salin untuk PC Kiosk.',
      'Manajemen Inventaris & Impor Excel 2-Tahap: CRUD inventaris manual, unduh template resmi `.xlsx`, validasi pratinjau per baris sebelum simpan, serta pilihan kebijakan konflik kode barang.',
    ],
    dev_notes: [
      'Implementasi endpoint ingest `POST /api/lab/traffic` dengan deduplikasi idempoten `(lab_id, id)` pada SQLite WAL (`better-sqlite3`).',
      'Autentikasi sesi cookie `HttpOnly` + `scrypt` password/token hashing + proteksi `X-CSRF-Token` + pencatatan `audit_log`.',
    ],
  },
];

module.exports = {
  CURRENT_VERSION,
  RELEASES,
};
