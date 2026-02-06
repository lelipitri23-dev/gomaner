require('dotenv').config({ debug: false, quiet: true });
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const admin = require('firebase-admin');

// Import Models
const User = require('./models/User');

// Import Routes
const apiRoutes = require('./routes/api');

// ==========================================
// 1. SETUP SERVER & MIDDLEWARE
// ==========================================
const app = express(); // Inisialisasi Express DULUAN
const PORT = process.env.PORT || 3000;
const WEBSITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

// Config View & Static Files
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

// Parser Body (Penting untuk Webhook Trakteer)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 2. FIREBASE ADMIN INIT (SECURED)
// ==========================================
try {
    let serviceAccount;

    // A. Cek Environment Variable (Prioritas Utama - Production)
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        // Decode string Base64 kembali menjadi JSON Object
        const buffer = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64');
        serviceAccount = JSON.parse(buffer.toString('utf8'));
        console.log("[System] Firebase Admin loaded from ENV (Base64).");
    } 
    // B. Cek File Fisik (Cadangan - Local Development)
    else {
        // Ini akan error jika file sudah dihapus, tapi berguna saat dev lokal
        serviceAccount = require('./serviceAccountKey.json');
        console.log("[System] Firebase Admin loaded from FILE (Local).");
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    
} catch (error) {
    console.warn("[Warning] Gagal init Firebase Admin:", error.message);
    console.warn("Solusi: Pastikan 'FIREBASE_SERVICE_ACCOUNT_BASE64' ada di .env atau file 'serviceAccountKey.json' tersedia.");
}

// ==========================================
// 3. AUTH MIDDLEWARE (Global)
// ==========================================
// Mengecek apakah ada token Bearer dari frontend
app.use(async (req, res, next) => {
    const authHeader = req.headers.authorization;
    req.user = null; // Default null (Guest)

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const idToken = authHeader.split('Bearer ')[1];
        try {
            // Verifikasi Token ke Google
            const decodedToken = await admin.auth().verifyIdToken(idToken);
            
            // Cari User di MongoDB, kalau belum ada buat baru
            let user = await User.findOne({ googleId: decodedToken.uid });
            if (!user) {
                user = await User.create({
                    googleId: decodedToken.uid,
                    email: decodedToken.email,
                    displayName: decodedToken.name || 'User',
                    isPremium: false,
                    downloadCount: 0
                });
            }
            // Simpan data user MongoDB ke request
            req.user = { id: user._id, email: user.email }; 
            
        } catch (error) {
            // Error token expired atau invalid wajar terjadi, cukup log error kecil
            // console.error("[Auth] Token invalid:", error.message);
        }
    }
    next();
});

// ==========================================
// 4. ROUTING
// ==========================================
app.use('/api', apiRoutes);

// ==========================================
// 5. START SERVER
// ==========================================
const DB_URI = process.env.DB_URI;

const startServer = async () => {
    try {
        if (!DB_URI) throw new Error("DB_URI tidak ditemukan di .env");

        // Koneksi Database
        await mongoose.connect(DB_URI);
        console.log('[System] Connected to MongoDB...');

        // Jalankan Server
        app.listen(PORT, () => {
            console.log(`[System] Server running at: ${WEBSITE_URL}`);
        });

    } catch (err) {
        console.error('[Fatal] Gagal menjalankan server:', err.message);
        process.exit(1);
    }
};

startServer();