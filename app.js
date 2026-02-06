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
const app = express();
const PORT = process.env.PORT || 3000;
const WEBSITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;

// Config View & Static Files
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));

// Parser Body
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 2. FIREBASE ADMIN INIT
// ==========================================
try {
    let serviceAccount;
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        const buffer = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64');
        serviceAccount = JSON.parse(buffer.toString('utf8'));
        console.log("[System] Firebase Admin loaded from ENV.");
    } else {
        serviceAccount = require('./serviceAccountKey.json');
        console.log("[System] Firebase Admin loaded from FILE.");
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
} catch (error) {
    console.warn("[Warning] Gagal init Firebase Admin:", error.message);
}

// ==========================================
// 3. AUTH MIDDLEWARE (Global)
// ==========================================
app.use(async (req, res, next) => {
    const authHeader = req.headers.authorization;
    req.user = null; // Default null (Guest)

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const idToken = authHeader.split('Bearer ')[1];
        try {
            const decodedToken = await admin.auth().verifyIdToken(idToken);
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
            req.user = { id: user._id, email: user.email }; 
        } catch (error) {}
    }
    next();
});

// ==========================================
// 4. ROUTING
// ==========================================
app.use('/api', apiRoutes);

// Halaman Frontend Utama (Single Page)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html')); 
});

// ==========================================
// 5. START SERVER
// ==========================================
const DB_URI = process.env.DB_URI;

const startServer = async () => {
    try {
        if (!DB_URI) throw new Error("DB_URI tidak ditemukan di .env");
        await mongoose.connect(DB_URI);
        console.log('[System] Connected to MongoDB...');
        app.listen(PORT, () => {
            console.log(`[System] Server running at: ${WEBSITE_URL}`);
        });
    } catch (err) {
        console.error('[Fatal] Gagal menjalankan server:', err.message);
        process.exit(1);
    }
};

startServer();
