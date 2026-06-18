const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken'); 
const multer = require('multer');
const path = require('path');
const fs = require('fs');


dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/'); 
    },
    filename: (req, file, cb) => {
        cb(null, 'logo-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// Hubungkan ke Database MySQL
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    ssl: {
        rejectUnauthorized: true
    }
}).promise();

// Tes Koneksi Database
db.getConnection()
    .then((connection) => {
        console.log('✅ Koneksi database MySQL BERHASIL!');
        connection.release();
    })
    .catch((err) => {
        console.error('❌ Koneksi database GAGAL:', err.message);
    });

// 💡 Fungsi pembantu pembulatan (Dipindah ke atas agar aman diakses oleh rute laporan di bawahnya)
function ROUND_TO_ONE(num) {
    return Math.round(num * 10) / 10;
}

// Route Utama untuk Tes
app.get('/', (req, res) => {
    res.send('Server SIKaRa Berjalan Lancar!');
});

app.post('/api/auth/register', async (req, res) => {
    // Tambahkan field data toko di req.body
    const { name, email, password, role, business_name, phone, location, category } = req.body;

    if (!name || !email || !password || !role) {
        return res.status(400).json({ message: 'Nama, email, password, dan role wajib diisi!' });
    }

    try {
        // A. Cek email
        const [existingUser] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (existingUser.length > 0) {
            return res.status(400).json({ message: 'Email sudah terdaftar!' });
        }

        // B. Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // C. Simpan ke tabel users
        const [userResult] = await db.query(
            'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
            [name, email, hashedPassword, role]
        );

        // DAPATKAN ID USER YANG BARU SAJA DIINPUT
        const newUserId = userResult.insertId;

        // D. JIKA DAFTAR SEBAGAI UMKM, OTOMATIS MASUKKAN DATA KE TABEL PROFIL UMKM
        if (role === 'umkm') {
            if (!business_name || !phone || !location || !category) {
                return res.status(400).json({ message: 'Untuk akun UMKM; Nama Usaha, Telepon, Lokasi, dan Kategori wajib diisi!' });
            }

            await db.query(
                'INSERT INTO umkm_profiles (user_id, business_name, owner_name, email, phone, location, category) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [newUserId, business_name, name, email, phone, location, category]
            );
        }

        return res.status(201).json({ message: 'Registrasi akun berhasil!' });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});


// ==========================================
// 2. API ENDPOINT LOGIN 
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { email, password, role } = req.body;

    // Validasi input awal
    if (!email || !password || !role) {
        return res.status(400).json({ message: 'Email, password, dan role wajib diisi!' });
    }

    try {
        // A. Cari user berdasarkan email dan role yang dipilih di form
        const [users] = await db.query('SELECT * FROM users WHERE email = ? AND role = ?', [email, role]);
        if (users.length === 0) {
            return res.status(400).json({ message: 'Akun tidak ditemukan atau salah memilih status masuk!' });
        }

        const user = users[0];

        // B. Cocokkan password teks biasa dari form dengan password ter-hash di database
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ message: 'Kata sandi salah!' });
        }

        // C. Buat token JWT digital jika password benar
        const token = jwt.sign(
            { id: user.id, name: user.name, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '1d' } // Berlaku selama 1 hari
        );

        // 🔥 PERBAIKAN DI SINI (D): Data dibungkus ke dalam objek 'user' agar klop dengan data.user?.id di frontend Anda
        return res.status(200).json({
            message: 'Login berhasil!',
            token: token,
            role: user.role,
            user: {
                id: user.id,
                name: user.name,
                email: user.email
            }
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Terjadi kesalahan pada server.' });
    }
});


// ==========================================
// API PUBLIC: AMBIL PRODUK UNTUK LANDING PAGE
// ==========================================
app.get('/api/public/products', async (req, res) => {
    try {
        // Ambil produk dan gabungkan dengan nama usaha/toko dari tabel umkm_profiles
        const queryText = `
            SELECT p.*, u.business_name 
            FROM products p
            JOIN umkm_profiles u ON p.umkm_id = u.id
            ORDER BY p.rating DESC 
            LIMIT 6
        `;
        const [products] = await db.query(queryText);
        
        return res.status(200).json(products);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal mengambil data produk.' });
    }
});

// ==========================================
// API ADMIN: AMBIL STATISTIK & DAFTAR UMKM
// ==========================================
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        // 1. Hitung Total UMKM
        const [totalUmkmRow] = await db.query('SELECT COUNT(*) as total FROM umkm_profiles');
        
        // 2. Hitung Total Produk
        const [totalProdukRow] = await db.query('SELECT COUNT(*) as total FROM products');
        
        // 3. Hitung UMKM yang berstatus 'Aktif'
        const [activeUmkmRow] = await db.query("SELECT COUNT(*) as total FROM umkm_profiles WHERE status = 'Aktif'");
        
        // 4. Ambil 5 data UMKM terbaru untuk tabel
        const [umkmList] = await db.query(`
            SELECT business_name, owner_name, location, status 
            FROM umkm_profiles 
            ORDER BY id DESC 
            LIMIT 5
        `);

        // Kirim semua data gabungan dalam bentuk JSON
        return res.status(200).json({
            stats: {
                totalUMKM: totalUmkmRow[0].total,
                totalProduk: totalProdukRow[0].total,
                umkmAktif: activeUmkmRow[0].total
            },
            umkmList: umkmList
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal memuat data statistik admin.' });
    }
});

// ==========================================
// API ADMIN: AMBIL SEMUA DATA UMKM (PANEL DATA)
// ==========================================
app.get('/api/admin/umkm', async (req, res) => {
    try {
        // Ambil semua data profil UMKM beserta hitungan total produk yang mereka miliki
        const queryText = `
            SELECT u.*, COUNT(p.id) as total_products 
            FROM umkm_profiles u
            LEFT JOIN products p ON u.id = p.umkm_id
            GROUP BY u.id
            ORDER BY u.id DESC
        `;
        const [umkmRows] = await db.query(queryText);
        
        return res.status(200).json(umkmRows);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal mengambil seluruh data UMKM.' });
    }
});

// ==========================================
// API ADMIN: AMBIL SEMUA DAFTAR PRODUK (TABEL)
// ==========================================
app.get('/api/admin/products', async (req, res) => {
    try {
        const queryText = `
            SELECT p.*, u.business_name 
            FROM products p
            JOIN umkm_profiles u ON p.umkm_id = u.id
            ORDER BY p.id DESC
        `;
        const [productRows] = await db.query(queryText);
        return res.status(200).json(productRows);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal mengambil data produk admin.' });
    }
});

// ==========================================
// API ADMIN: HAPUS PRODUK BERDASARKAN ID
// ==========================================
app.delete('/api/admin/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM products WHERE id = ?', [id]);
        return res.status(200).json({ message: 'Produk berhasil dihapus.' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal menghapus produk.' });
    }
});

// ==========================================
// API ADMIN: HITUNG DATA REKAP LAPORAN REAL (Membersihkan Duplikat Rute Laporan)
// ==========================================
app.get('/api/admin/laporan', async (req, res) => {
    try {
        // 1. Hitung ringkasan utama (Total UMKM, Produk, dan UMKM Aktif)
        const [totalUmkmRow] = await db.query('SELECT COUNT(*) as total FROM umkm_profiles');
        const [totalProdukRow] = await db.query('SELECT COUNT(*) as total FROM products');
        const [activeUmkmRow] = await db.query("SELECT COUNT(*) as total FROM umkm_profiles WHERE status = 'Aktif'");

        const totalUMKM = totalUmkmRow[0].total || 0;
        const totalProduk = totalProdukRow[0].total || 0;
        const umkmAktif = activeUmkmRow[0].total || 0;

        // 2. Hitung UMKM Berdasarkan Kategori + Persentase
        const [umkmKategoriRows] = await db.query(`
            SELECT 
                IFNULL(category, 'Umum') as name, 
                COUNT(*) as count,
                ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM umkm_profiles)), 1) as percent
            FROM umkm_profiles
            GROUP BY category
            ORDER BY count DESC
        `);

        // 3. Hitung Produk Berdasarkan Kategori + Persentase
        const [produkKategoriRows] = await db.query(`
            SELECT 
                IFNULL(category_name, 'Lainnya') as name, 
                COUNT(*) as count,
                ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM products)), 1) as percent
            FROM products
            GROUP BY category_name
            ORDER BY count DESC
        `);

        // 4. Cari Kategori Dominan untuk baris teks ringkasan
        let kategoriDominan = 'Belum ada';
        let percentDominan = 0;
        if (umkmKategoriRows.length > 0) {
            kategoriDominan = umkmKategoriRows[0].name;
            percentDominan = umkmKategoriRows[0].percent;
        }

        return res.status(200).json({
            stats: {
                totalUMKM,
                totalProduk,
                umkmAktif,
                tingkatAktif: totalUMKM > 0 ? ROUND_TO_ONE((umkmAktif / totalUMKM) * 100) : 0,
                rataRataProduk: totalUMKM > 0 ? ROUND_TO_ONE(totalProduk / totalUMKM) : 0,
                totalKategoriUMKM: umkmKategoriRows.length,
                kategoriDominan,
                percentDominan
            },
            umkmKategori: umkmKategoriRows,
            produkKategori: produkKategoriRows
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal menyusun laporan database.' });
    }
});

// =======================================================
// API UMKM: AMBIL DATA PRODUK KHUSUS TOKO YANG SEDANG LOGIN
// =======================================================
app.get('/api/umkm/products/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        // 1. Cari tahu dulu ID Profil UMKM berdasarkan User ID yang login
        const [umkmRow] = await db.query('SELECT id, business_name FROM umkm_profiles WHERE user_id = ?', [userId]);
        
        if (umkmRow.length === 0) {
            return res.status(404).json({ message: 'Profil UMKM belum didaftarkan oleh Admin.' });
        }

        const umkmId = umkmRow[0].id;
        const businessName = umkmRow[0].business_name;

        // 2. Tarik semua produk yang hanya dimiliki oleh umkm_id tersebut
        const [products] = await db.query('SELECT * FROM products WHERE umkm_id = ? ORDER BY id DESC', [umkmId]);

        // 3. Hitung ringkasan total stok barang toko mereka
        const [stokRow] = await db.query('SELECT SUM(stock) as total_stok FROM products WHERE umkm_id = ?', [umkmId]);

        return res.status(200).json({
            businessName,
            umkmId,
            totalStok: stokRow[0].total_stok || 0,
            totalItems: products.length,
            products: products
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal memuat inventori toko Anda.' });
    }
});

// =======================================================
// API UMKM: TAMBAH PRODUK BARU OLEH PEMILIK UMKM
// =======================================================
app.post('/api/umkm/products', async (req, res) => {
    try {
        const { umkm_id, title, category_name, price, stock, image_url } = req.body;

        if (!umkm_id || !title || !price || !stock) {
            return res.status(400).json({ message: 'Data produk belum lengkap!' });
        }

        const queryText = `
            INSERT INTO products (umkm_id, title, category_name, price, stock, rating, review_count, image_url)
            VALUES (?, ?, ?, ?, ?, 5.0, 0, ?)
        `;
        
        await db.query(queryText, [umkm_id, title, category_name || 'Umum', price, stock, image_url || '']);
        return res.status(201).json({ message: 'Produk dagangan Anda berhasil ditambahkan!' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal menambahkan produk baru.' });
    }
});

// =======================================================
// 🔥 API UMKM: UPDATE/EDIT DATA PRODUK MILIK SENDIRI
// =======================================================
app.put('/api/umkm/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { title, category_name, price, stock, image_url } = req.body;

        const queryText = `
            UPDATE products 
            SET title = ?, category_name = ?, price = ?, stock = ?, image_url = ?
            WHERE id = ?
        `;
        
        await db.query(queryText, [title, category_name || 'Umum', parseFloat(price), parseInt(stock), image_url || '', id]);
        return res.status(200).json({ message: 'Produk berhasil diperbarui!' });
    } catch (error) {
        console.error("Error update produk UMKM:", error);
        return res.status(500).json({ message: 'Gagal memperbarui produk.' });
    }
});

// =======================================================
// 🔥 API UMKM: HAPUS PRODUK MILIK SENDIRI
// =======================================================
app.delete('/api/umkm/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM products WHERE id = ?', [id]);
        return res.status(200).json({ message: 'Produk berhasil dihapus.' });
    } catch (error) {
        console.error("Error delete produk UMKM:", error);
        return res.status(500).json({ message: 'Gagal menghapus produk.' });
    }
});

// =======================================================
// API REKAP TOTAL MITRA UMKM (DASHBOARD, PRODUK, & LAPORAN)
// =======================================================
app.get('/api/umkm/dashboard-full/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const [umkmRow] = await db.query('SELECT id, business_name FROM umkm_profiles WHERE user_id = ?', [userId]);
        
        if (umkmRow.length === 0) {
            return res.status(200).json({
                businessName: "Administrator SIKaRa",
                umkmId: null,
                stats: { totalProduk: 0, totalPenjualan: 0, totalTransaksi: 0 },
                products: [],
                orders: []
            });
        }
        
        const umkmId = umkmRow[0].id;
        const businessName = umkmRow[0].business_name;

        // 2. Hitung Total Produk Toko Ini
        const [totalProd] = await db.query('SELECT COUNT(*) as total FROM products WHERE umkm_id = ?', [umkmId]);

        // 3. Hitung Total Penjualan (Rp) & Total Transaksi (Count)
        const [salesRow] = await db.query('SELECT SUM(total) as total_rp, COUNT(*) as total_count FROM orders WHERE umkm_id = ?', [umkmId]);

        // 4. Ambil Daftar Semua Produk Milik Toko Ini
        const [products] = await db.query('SELECT * FROM products WHERE umkm_id = ? ORDER BY id DESC', [umkmId]);

        // 5. Ambil Daftar Semua Transaksi/Orders Milik Toko Ini
        const [orders] = await db.query(`
            SELECT id, product_name, quantity, price, total, 
                   DATE_FORMAT(created_at, '%d %b %Y') as tanggal,
                   DATE_FORMAT(created_at, '%H:%i') as jam_lalu
            FROM orders 
            WHERE umkm_id = ? 
            ORDER BY id DESC
        `, [umkmId]);

        return res.status(200).json({
            businessName,
            umkmId,
            stats: {
                totalProduk: totalProd[0].total || 0,
                totalPenjualan: salesRow[0].total_rp || 0,
                totalTransaksi: salesRow[0].total_count || 0,
            },
            products,
            orders
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal sinkronisasi database mitra.' });
    }
});

// =======================================================
// 🔥 TAMBAHAN FITUR: API INPUT PENJUALAN MANUAL MULTI-ITEM (KASIR POS)
// =======================================================
app.post('/api/umkm/orders-manual', async (req, res) => {
    try {
        const { umkm_id, items } = req.body;

        if (!umkm_id || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: 'Keranjang belanja masih kosong atau data tidak valid!' });
        }

        const queryText = `
            INSERT INTO orders (umkm_id, product_name, quantity, price, total, created_at)
            VALUES ?
        `;

        // Petakan array multi-item dari kasir menjadi data bulk insert MySQL
        const values = items.map(item => {
            const totalItem = parseInt(item.quantity) * parseFloat(item.price);
            return [
                umkm_id,
                item.product_name,
                parseInt(item.quantity),
                parseFloat(item.price),
                totalItem,
                new Date()
            ];
        });

        await db.query(queryText, [values]);
        return res.status(201).json({ message: 'Seluruh transaksi kasir berhasil disimpan!' });
    } catch (error) {
        console.error("Gagal memproses kasir multi-item:", error);
        return res.status(500).json({ message: 'Gagal memproses transaksi kasir.' });
    }
});

// =======================================================
// 🔥 API ADMIN: TAMBAH PRODUK BARU OLEH ADMIN (DENGAN LOOKUP NAMA USAHA)
// =======================================================
app.post('/api/admin/products', async (req, res) => {
    const { title, category_name, price, stock, business_name, image_url } = req.body;

    if (!title || !price || !stock || !business_name) {
        return res.status(400).json({ message: 'Nama produk, harga, stok, dan nama usaha wajib diisi!' });
    }

    try {
        // 1. Cari tahu dulu id profil UMKM berdasarkan business_name yang dimasukkan di form
        const [umkmRow] = await db.query('SELECT id FROM umkm_profiles WHERE business_name = ?', [business_name]);
        
        if (umkmRow.length === 0) {
            return res.status(400).json({ message: `Nama UMKM "${business_name}" tidak ditemukan di database! Pastikan penulisannya sama persis.` });
        }

        const umkmId = umkmRow[0].id;

        // 2. Masukkan data ke dalam tabel products menggunakan umkm_id yang sah
        const queryText = `
            INSERT INTO products (umkm_id, title, category_name, price, stock, rating, review_count, image_url)
            VALUES (?, ?, ?, ?, ?, 5.0, 0, ?)
        `;
        
        await db.query(queryText, [umkmId, title, category_name || 'Umum', parseFloat(price), parseInt(stock), image_url || '']);
        return res.status(201).json({ message: 'Produk baru berhasil ditambahkan oleh Admin!' });

    } catch (error) {
        console.error("Gagal menambahkan produk lewat panel admin:", error);
        return res.status(500).json({ message: 'Terjadi kesalahan pada server saat menyimpan produk.' });
    }
});

// =======================================================
// 🔥 API ADMIN: DAFTARKAN MITRA UMKM BARU (OTOMATIS BIKIN USER LOGIN)
// =======================================================
app.post('/api/admin/umkm', async (req, res) => {
    const { business_name, owner_name, email, phone, location, category, status } = req.body;

    if (!business_name || !owner_name || !email) {
        return res.status(400).json({ message: 'Nama usaha, nama pemilik, dan email wajib diisi!' });
    }

    try {
        // 1. Cek apakah email sudah terdaftar di tabel users
        const [existingUser] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (existingUser.length > 0) {
            return res.status(400).json({ message: 'Email pemilik sudah terdaftar di sistem!' });
        }

        // 2. Buat password default bawaan untuk mitra baru (bisa diubah nanti, misal: "12345678")
        const salt = await bcrypt.genSalt(10);
        const defaultPassword = await bcrypt.hash('12345678', salt);

        // 3. Masukkan ke tabel users
        const [userResult] = await db.query(
            'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, "umkm")',
            [owner_name, email, defaultPassword]
        );

        const newUserId = userResult.insertId;

        // 4. Masukkan ke tabel umkm_profiles dengan foreign key user_id yang sah
        await db.query(
            'INSERT INTO umkm_profiles (user_id, business_name, owner_name, email, phone, location, category, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [newUserId, business_name, owner_name, email, phone || '', location || '', category || 'Umum', status || 'Aktif']
        );

        return res.status(201).json({ message: 'Mitra UMKM dan akun login berhasil dibuat!' });

    } catch (error) {
        console.error("Gagal mendaftarkan UMKM baru via panel admin:", error);
        return res.status(500).json({ message: 'Terjadi kesalahan pada server saat mendaftarkan UMKM.' });
    }
});

// =======================================================
// 🔥 API ADMIN: AMBIL DAFTAR KATEGORI UNTUK DROPDOWN FORM
// =======================================================
app.get('/api/admin/categories', async (req, res) => {
    try {
        // Mengambil list kategori unik yang sudah ada di profil UMKM saat ini
        const [rows] = await db.query('SELECT DISTINCT category as name FROM umkm_profiles WHERE category IS NOT NULL AND category != ""');
        
        // Jika di DB masih kosong, berikan fallback array default
        if (rows.length === 0) {
            return res.status(200).json([{ name: 'Makanan & Minuman' }, { name: 'Fashion' }, { name: 'Kerajinan' }, { name: 'Ritel' }]);
        }
        return res.status(200).json(rows);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal memuat kategori.' });
    }
});

// =======================================================
// 🔥 API UMKM: AMBIL DATA PROFIL SEBELUM DIEDIT
// =======================================================
app.get('/api/umkm/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const [rows] = await db.query('SELECT * FROM umkm_profiles WHERE user_id = ?', [userId]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Profil UMKM belum terdaftar.' });
        }
        return res.status(200).json(rows[0]);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal memuat profil toko.' });
    }
});

// =======================================================
// 🔥 API UMKM: UPDATE PERUBAHAN PROFIL TOKO KE DATABASE
// =======================================================
app.put('/api/umkm/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        // 🔥 TAMBAHAN: Ekstrak logo_url dari data yang dikirim frontend
        const { business_name, owner_name, phone, location, category, logo_url } = req.body;

        if (!business_name || !owner_name) {
            return res.status(400).json({ message: 'Nama toko dan nama pemilik wajib diisi!' });
        }

        // 🔥 TAMBAHAN: Masukkan logo_url ke dalam perintah UPDATE MySQL
        const queryText = `
            UPDATE umkm_profiles 
            SET business_name = ?, owner_name = ?, phone = ?, location = ?, category = ?, logo_url = ? 
            WHERE user_id = ?
        `;
        
        await db.query(queryText, [
            business_name, 
            owner_name, 
            phone || '', 
            location || '', 
            category || 'Umum', 
            logo_url || '', // Simpan link gambar ke DB
            userId
        ]);
        return res.status(200).json({ message: 'Profil toko berhasil diperbarui!' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal memperbarui profil toko di database.' });
    }
});

// =======================================================
// 🔥 API KHUSUS UPLOAD GAMBAR DARI PC
// =======================================================
app.post('/api/upload', upload.single('image'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'Tidak ada gambar yang diunggah.' });
        }
        // Kembalikan URL publik dari gambar yang baru saja masuk ke folder
        const imageUrl = `https://backend-sikara.onrender.com/uploads/${req.file.filename}`;
        return res.status(200).json({ imageUrl });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ message: 'Gagal memproses gambar.' });
    }
});

// Jalankan Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});