const mysql = require('mysql2/promise'); 
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');

dotenv.config();

async function createAdmin() {
    // Hubungkan ke database menggunakan variabel dari file .env Anda
    const db = await mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    try {
        const email = 'admin@sikara.com';
        const passwordAsli = 'admin123'; // Ini password yang akan Anda gunakan untuk login nanti

        // Hapus akun admin lama jika ada biar tidak duplikat/bentrok
        await db.query('DELETE FROM users WHERE email = ?', [email]);

        // Proses hashing menggunakan mesin bcrypt backend Anda sendiri
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(passwordAsli, salt);

        // Masukkan data admin ke database
        await db.query(
            'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
            ['Admin SIKaRa', email, hashedPassword, 'admin']
        );

        console.log('\n==================================================');
        console.log('✅ AKUN ADMIN BERHASIL DICIPTAKAN!');
        console.log(`📧 Email   : ${email}`);
        console.log(`🔑 Password: ${passwordAsli}`);
        console.log('==================================================\n');

    } catch (error) {
        console.error('❌ Gagal membuat admin:', error.message);
    } finally {
        process.exit();
    }
}

createAdmin();