# Catatan Rilis & Riwayat Versi (Changelog)

Dokumen ini mencatat seluruh perubahan, penambahan fitur, dan perbaikan pada **Website Utama Monitoring Kunjungan & Inventaris Laboratorium (`lab_admin_monitor`)** secara sistematis menggunakan format **Semantic Versioning (`vMAJOR.MINOR.PATCH`)**:
- **MAJOR (`v1.x.x`)**: Perubahan arsitektur besar atau perubahan kontrak API yang tidak kompatibel ke belakang.
- **MINOR (`vx.1.x`)**: Penambahan fitur baru atau penyempurnaan modul/antarmuka tanpa merusak kontrak yang sudah ada.
- **PATCH (`vx.x.1`)**: Perbaikan bug, keamanan, optimasi performa, atau perapihan routing/tampilan.

---

## [v1.1.0] — 2026-11-17
### Ringkasan Pembaruan (Untuk Pengguna)
Pembaruan antarmuka pengguna dengan dukungan **Mode Terang & Mode Gelap (Theme Toggle)**, kustomisasi visual Portal Login laboratorium, perapihan fokus Sidebar Dashboard, penambahan Favicon & Footer aplikasi, serta fitur informasi versi langsung di dalam web.

- **Ditambahkan:**
  - Tombol **Theme Toggle (Mode Terang / Mode Gelap)** pada halaman `/login` dan topbar `/dashboard` yang tersimpan otomatis di browser.
  - Background foto ruang laboratorium (`lab-lantai-3.jpeg`) dengan efek transparansi pada halaman `/login`.
  - Penataan **Logo Utama Lab** serta **Logo Pelengkap (Prodi TI & UNIDA)** khusus pada halaman Portal Login (`/login`).
  - **Footer Konsol** yang memuat kredit pengelola, tautan ke repositori pasangan [Lab Traffic Tracker (Kiosk KTM)](https://github.com/Zizarinr/lab_traffic_tracker.git), dan tombol **Versi (`v1.1.0`)** yang membuka modal **Riwayat Pembaruan Aplikasi**.
  - **Favicon** resmi aplikasi (`/favicon.svg`) pada seluruh halaman.
- **Diubah / Diperbaiki:**
  - Menghapus logo pelengkap (Prodi TI & UNIDA) dari Sidebar Dashboard agar area kerja pengelola tetap bersih, ringkas, dan fokus pada data operasional.

### Catatan Teknis (Arsip Developer)
- Menambahkan modul `src/version.js` dan endpoint `GET /api/version` sebagai *Single Source of Truth* metadata versi antara backend, frontend, dan dokumentasi.
- Menambahkan route `/favicon.ico` -> `/favicon.svg` di `src/app.js`.

---

## [v1.0.1] — 2026-11-16
### Ringkasan Pembaruan (Untuk Pengguna)
Memisahkan alamat URL antara **Portal Login (`/login`)** dan **Konsol Dashboard (`/dashboard`)** agar lebih aman dan nyaman saat berpindah menu maupun saat halaman dimuat ulang (*refresh*).

- **Ditambahkan:**
  - Alamat khusus `/login` untuk halaman autentikasi administrator.
  - Alamat URL bersih (*Clean URL*) untuk setiap menu: `/dashboard`, `/visits`, `/laboratories`, `/inventory`, dan `/import-audit`.
  - Pengalihan otomatis (*redirect*) ke halaman tujuan semula (`?next=...`) setelah administrator berhasil login.
- **Diperbaiki:**
  - Mencegah halaman dashboard terunduh oleh pengguna yang belum memiliki sesi login aktif.

### Catatan Teknis (Arsip Developer)
- Memisahkan `public/index.html` menjadi `public/login.html` (+ `public/login.js`) dan `public/dashboard.html`.
- Menerapkan *server-side session guard* dengan header `Cache-Control: no-store` di `src/app.js`.

---

## [v1.0.0] — 2026-11-14
### Ringkasan Pembaruan (Untuk Pengguna)
Rilis perdana (MVP) **Website Utama Monitoring Kunjungan & Inventaris Laboratorium**.

- **Fitur Utama:**
  - Penerimaan sinkronisasi log kunjungan multi-laboratorium dari aplikasi **Lab Scan KTM (`traffic_tracker`)** secara aman dan bebas duplikasi.
  - Dashboard ringkasan operasional, indikator kesehatan sinkronisasi tiap lab (*Online*, *Silent*, *Backlog*, *Clock Skew*), grafik tren kunjungan, dan *Live Feed* 50 scan terakhir.
  - Tabel eksplorasi kunjungan dengan filter lengkap, laci detail kunjungan, riwayat mahasiswa lintas lab, dan ekspor `.xlsx` / `.csv`.
  - Manajemen laboratorium, rotasi Bearer token sekali tampil, dan generator konfigurasi `.env` siap salin untuk PC Kiosk.
  - Manajemen inventaris peralatan laboratorium (input manual & impor Excel tervalidasi 2-tahap dengan pratinjau baris).

### Catatan Teknis (Arsip Developer)
- Stack: Node.js (>=20), Express 5, SQLite WAL (`better-sqlite3`), SheetJS (`xlsx`), dan `node:crypto` (`scrypt`).
- Kontrak ingest `POST /api/lab/traffic` idempoten pada `(lab_id, id)` di mana array `accepted` selalu menyertakan ID baru maupun duplikat.
