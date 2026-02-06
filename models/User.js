// models/User.js
const mongoose = require('mongoose'); // <--- BARIS INI YANG HILANG SEBELUMNYA

const userSchema = new mongoose.Schema({
    googleId: String,
    email: String,
    displayName: String,
    isPremium: { type: Boolean, default: false },
    downloadCount: { type: Number, default: 0 },
    lastDownloadDate: { type: Date, default: Date.now }
});

// Jangan lupa export modelnya agar bisa dipakai di file lain
module.exports = mongoose.model('User', userSchema);