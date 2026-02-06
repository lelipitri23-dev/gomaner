const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const axios = require('axios');
const sharp = require('sharp');

// ==========================================
// 1. IMPORT MODELS
// ==========================================
const Manga = require('../models/Manga');
const Chapter = require('../models/Chapter');
const User = require('../models/User');

// ==========================================
// 2. CONFIG LIMIT & CACHE
// ==========================================
// Cache penyimpanan sementara IP Guest (hilang saat restart server)
const guestCache = new Map();
const LIMIT_GUEST_IP = 10; // Batas download untuk Guest

// ==========================================
// 3. HELPER FUNCTIONS & MIDDLEWARE
// ==========================================

// Standard API Response
const successResponse = (res, data, pagination = null) => {
    res.json({ success: true, data, pagination });
};

const errorResponse = (res, message, code = 500) => {
    console.error(`[Error API] ${message}`);
    res.status(code).json({ success: false, message });
};

// Pagination Helper
const getPaginationParams = (req, defaultLimit = 24) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || defaultLimit);
    const skip = (page - 1) * limit;
    return { page, limit, skip };
};

// Helper: Menghitung jumlah chapter untuk setiap manga (Optimized)
async function attachChapterCounts(mangas) {
    if (!mangas || mangas.length === 0) return [];

    const mangaIds = mangas.map(m => m._id);

    // Aggregate count berdasarkan manga_id
    const counts = await Chapter.aggregate([
        { $match: { manga_id: { $in: mangaIds } } },
        { $group: { _id: "$manga_id", count: { $sum: 1 } } }
    ]);

    const countMap = {};
    counts.forEach(c => {
        countMap[c._id.toString()] = c.count;
    });

    return mangas.map(m => ({
        ...m,
        chapter_count: countMap[m._id.toString()] || 0
    }));
}

/**
 * Middleware: Cek Kuota Download
 * Logika: Cek Login Database -> Jika tidak login, cek IP Address
 */
const checkDownloadLimit = async (req, res, next) => {
    try {
        // A. JIKA USER LOGIN
        if (req.user && req.user.id) {
            const user = await User.findById(req.user.id);
            if (!user) return res.status(404).json({ success: false, message: "User not found" });

            if (user.isPremium) return next(); // Premium = Unlimited

            if (user.downloadCount >= 50) {
                return res.status(403).json({ success: false, message: "Limit harian akun (50) tercapai. Upgrade Premium!" });
            }
            req.userDoc = user; 
            return next();
        }

        // B. JIKA GUEST (Cek IP)
        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        // Bersihkan IP jika ada multiple proxy (ambil yang paling depan)
        if (ip.includes(',')) ip = ip.split(',')[0].trim();

        const currentUsage = guestCache.get(ip) || 0;

        if (currentUsage >= LIMIT_GUEST_IP) {
            return res.status(403).json({ 
                success: false, 
                message: `Limit Guest (${LIMIT_GUEST_IP}) tercapai. Silakan Login untuk lanjut!` 
            });
        }
        
        req.isGuest = true;
        req.clientIp = ip;
        next();

    } catch (err) {
        console.error("Limit Check Error:", err);
        res.status(500).json({ success: false, message: "Server Error checking limit" });
    }
};

// ==========================================
// 4. ENDPOINTS
// ==========================================

// GET /api/stats (Untuk Progress Bar Frontend)
router.get('/stats', async (req, res) => {
    try {
        // Cek User
        if (req.user && req.user.id) {
            const user = await User.findById(req.user.id);
            if (!user) return res.json({ type: 'guest', usage: 0, limit: LIMIT_GUEST_IP });
            if (user.isPremium) return res.json({ type: 'premium', usage: user.downloadCount, limit: '∞' });
            return res.json({ type: 'user', usage: user.downloadCount, limit: 50 });
        }
        // Cek Guest IP
        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        if (ip.includes(',')) ip = ip.split(',')[0].trim();

        const usage = guestCache.get(ip) || 0;
        return res.json({ type: 'guest', usage: usage, limit: LIMIT_GUEST_IP });
    } catch (err) {
        return res.json({ type: 'guest', usage: 0, limit: LIMIT_GUEST_IP });
    }
});

// GET /api/top-downloads (Untuk List Paling Banyak Didownload)
router.get('/top-downloads', async (req, res) => {
    try {
        // Ambil 6 manga dengan download terbanyak
        const mangasRaw = await Manga.find()
            .sort({ downloads: -1, views: -1 })
            .limit(6)
            .select('title slug thumb downloads')
            .lean();

        const mangas = await attachChapterCounts(mangasRaw);
        successResponse(res, mangas);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/home (Data Homepage Default)
router.get('/home', async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);
        const totalManga = await Manga.countDocuments();

        const [recentsRaw, trendingRaw, manhwasRaw] = await Promise.all([
            Manga.find().select('title slug thumb metadata createdAt').sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
            Manga.find().select('title slug thumb views metadata').sort({ views: -1 }).limit(10).lean(),
            Manga.find({ 'metadata.type': { $regex: 'manhwa', $options: 'i' } }).select('title slug thumb metadata').sort({ updatedAt: -1 }).limit(10).lean()
        ]);

        const [recents, trending, manhwas] = await Promise.all([
            attachChapterCounts(recentsRaw),
            attachChapterCounts(trendingRaw),
            attachChapterCounts(manhwasRaw)
        ]);

        successResponse(res, { recents, trending, manhwas }, {
            currentPage: page, totalPages: Math.ceil(totalManga / limit), totalItems: totalManga, perPage: limit
        });
    } catch (err) { errorResponse(res, err.message); }
});

// GET /api/manga/:slug (Detail Manga)
router.get('/manga/:slug', async (req, res) => {
    try {
        // Increment Views saat dibuka
        const manga = await Manga.findOneAndUpdate(
            { slug: req.params.slug }, 
            { $inc: { views: 1 } }, 
            { new: true }
        ).lean();

        if (!manga) return errorResponse(res, 'Manga not found', 404);

        const chapters = await Chapter.find({ manga_id: manga._id })
            .select('title slug chapter_index createdAt')
            .sort({ chapter_index: -1 })
            .collation({ locale: "en_US", numericOrdering: true })
            .lean();

        manga.chapter_count = chapters.length;
        successResponse(res, { info: manga, chapters });
    } catch (err) { errorResponse(res, err.message); }
});

// GET /api/search (Pencarian)
router.get('/search', async (req, res) => {
    try {
        const keyword = req.query.q;
        if (!keyword) return errorResponse(res, 'Query parameter "q" required', 400);

        const { limit, skip } = getPaginationParams(req);
        const query = { title: { $regex: keyword, $options: 'i' } };
        
        const mangasRaw = await Manga.find(query).select('title slug thumb metadata').skip(skip).limit(limit).lean();
        const mangas = await attachChapterCounts(mangasRaw);
        
        successResponse(res, mangas);
    } catch (err) { errorResponse(res, err.message); }
});

// ==========================================
// 5. DOWNLOAD LOGIC
// ==========================================
router.get('/download/:slug/:chapterSlug', checkDownloadLimit, async (req, res) => {
    try {
        const { slug, chapterSlug } = req.params;
        
        // 1. Cari Manga & Chapter
        const manga = await Manga.findOne({ slug }).select('title _id').lean();
        if (!manga) return errorResponse(res, "Manga not found", 404);

        const chapter = await Chapter.findOne({ manga_id: manga._id, slug: chapterSlug }).lean();
        if (!chapter || !chapter.images?.length) return errorResponse(res, "Images not found", 404);

        // 2. Setup PDF Stream
        const cleanTitle = manga.title.replace(/[^a-zA-Z0-9]/g, '-');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${cleanTitle}-Ch${chapter.chapter_index}.pdf"`);

        const doc = new PDFDocument({ autoFirstPage: false });
        doc.pipe(res);

        // 3. Loop Images (Download & Add to PDF)
        for (const url of chapter.images) {
            try {
                const response = await axios.get(url, { 
                    responseType: 'arraybuffer', 
                    headers: { 
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Referer': 'https://doujindesu.tv/' 
                    },
                    timeout: 8000 // 8 Detik timeout per gambar agar tidak hang
                });
                // Kompresi gambar (JPEG 70%) agar ukuran PDF kecil & cepat
                const imgBuffer = await sharp(response.data).jpeg({ quality: 70 }).toBuffer();
                
                const img = doc.openImage(imgBuffer);
                doc.addPage({ size: [img.width, img.height] });
                doc.image(img, 0, 0);

            } catch (e) { 
                // Jika 1 gambar gagal, skip saja, jangan batalkan seluruh PDF
                console.warn(`[Skip Image] ${url} - Reason: ${e.message}`); 
            }
        }
        doc.end();

        // 4. Update Counter setelah selesai (Finish Event)
        res.on('finish', async () => {
            try {
                // A. Update Kuota User/Guest
                if (req.userDoc) {
                    await User.findByIdAndUpdate(req.userDoc._id, { $inc: { downloadCount: 1 } });
                } else if (req.isGuest && req.clientIp) {
                    const cur = guestCache.get(req.clientIp) || 0;
                    guestCache.set(req.clientIp, cur + 1);
                }

                // B. Update Statistik Download Manga
                await Manga.findByIdAndUpdate(manga._id, { $inc: { downloads: 1 } });
                
            } catch (err) { console.error("[Limit Update Error]", err); }
        });

    } catch (err) {
        console.error("[Download Error]", err);
        if (!res.headersSent) res.status(500).send("Error generating PDF");
    }
});

// ==========================================
// 6. WEBHOOK & EXPORT
// ==========================================
router.post('/trakteer-webhook', async (req, res) => {
    try {
        const { supporter_email, status } = req.body;
        if (status === 'Success') await User.findOneAndUpdate({ email: supporter_email }, { isPremium: true });
        res.sendStatus(200);
    } catch (err) { res.sendStatus(500); }
});

module.exports = router;
