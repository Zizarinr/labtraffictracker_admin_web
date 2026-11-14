# Sistem Pusat Monitoring Kunjungan & Inventaris Laboratorium (`lab_admin_monitor`)

Website utama yang berfungsi sebagai **pusat penerimaan, penyimpanan, pemantauan log kunjungan mahasiswa multi-laboratorium** (terintegrasi dengan aplikasi kiosk **Lab Scan KTM** / `traffic_tracker`) sekaligus **pengelolaan inventaris peralatan laboratorium** (CRUD manual & impor Excel tervalidasi 2-tahap).

## Fitur Utama (MVP)

1. **Integrasi Ingest Multi-Lab yang Idempoten (`POST /api/lab/traffic`)**
   - Autentikasi `Authorization: Bearer <token-lab>` unik per laboratorium (`lab_<random>`, disimpan sebagai hash `scrypt` + *pepper*).
   - Laboratorium wajib didaftarkan terlebih dahulu oleh Administrator (tidak *auto-register*).
   - Deduplikasi ketat pada pasangan `(lab_id, id)`. Respons `200 OK` selalu menyertakan ID baru maupun ID duplikat di dalam array `accepted` agar worker sinkronisasi kiosk tidak terjebak *infinite retry*.
   - Pencatatan waktu ganda (`scanned_at` dari kiosk dan `received_at` di pusat) dalam zona waktu `Asia/Jakarta (+07:00)`, pemantauan *backlog* (`pending_count`), dan deteksi *clock skew*.
2. **Dashboard Operasional & Eksplorasi Kunjungan**
   - Ringkasan kunjungan hari ini, rentang tanggal terpilih, jumlah mahasiswa unik, status kesehatan tiap kiosk (*Online*, *Silent*, *Nonaktif*), tren 7 hari, distribusi jam sibuk, dan *Live Feed* 50 scan terakhir.
   - Tabel kunjungan dengan *server-side pagination*, filter lengkap (tanggal, lab, status `ok`/`not_found`, kelas, semester), pencarian NIM/nama, laci inspeksi detail kunjungan + **riwayat kunjungan mahasiswa lintas lab**, serta ekspor `.xlsx` & `.csv`.
3. **Manajemen Inventaris & Impor Excel 2-Tahap (Preview → Confirm)**
   - CRUD inventaris peralatan per laboratorium (`kode_inventaris` unik, jumlah, satuan, kondisi [`Baik`, `Rusak Ringan`, `Rusak Berat`, `Dalam Perbaikan`], dan status [`Aktif`, `Tidak Aktif`, `Arsip`]).
   - Unduh template resmi `.xlsx`, validasi pratinjau baris demi baris sebelum disimpan, dan pilihan kebijakan konflik (`Tambah Saja` atau `Perbarui Berdasarkan Kode Inventaris`).
4. **Keamanan & Audit**
   - Login Administrator berbasis session cookie (`HttpOnly`, `SameSite=Lax`) + proteksi `X-CSRF-Token`.
   - Pencatatan `audit_log` otomatis dan skrip backup database pusat terverifikasi (`npm run backup`).

## Cara Menjalankan

```bash
# 1. Instal dependensi
npm install

# 2. (Opsional) Isi data contoh awal (3 lab, log kunjungan, dan inventaris)
npm run seed

# 3. Jalankan server pusat (default: http://127.0.0.1:4000)
npm start
```

Kredensial Administrator bawaan (dapat diubah melalui `.env`):
- **Email:** `admin@lab.kampus.ac.id`
- **Password:** `AdminLab!2026`

## Pengujian & Backup

```bash
# Jalankan automated test suite (kontrak ingest, idempotensi, inventaris, impor Excel, backup)
npm test

# Uji integrasi langsung menggunakan worker sinkronisasi dari repositori traffic_tracker
npm run verify:kiosk

# Buat backup database pusat + cek integritas SQLite
npm run backup
```
