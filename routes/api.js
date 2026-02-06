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

// Cache sederhana untuk Guest (IP based)
const guestCache = new Map();

// ==========================================
// 2. HELPER FUNCTIONS & MIDDLEWARE
// ==========================================

// Helper: Standard Response
const successResponse = (res, data, pagination = null) => {
    res.json({
        success: true,
        data,
        pagination
    });
};

const errorResponse = (res, message, code = 500) => {
    console.error(`[Error API] ${message}`);
    res.status(code).json({ success: false, message });
};

// Helper: Kalkulasi Pagination
const getPaginationParams = (req, defaultLimit = 24) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || defaultLimit);
    const skip = (page - 1) * limit;
    return { page, limit, skip };
};

// Helper: Optimized Chapter Count (Mencegah N+1 Query Problem)
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
 */
const checkDownloadLimit = async (req, res, next) => {
    try {
        // A. USER LOGIN
        if (req.user && req.user.id) {
            const user = await User.findById(req.user.id);
            if (!user) return res.status(404).json({ success: false, message: "User not found" });

            if (user.isPremium) return next();

            if (user.downloadCount >= 50) {
                return res.status(403).json({ success: false, message: "Limit harian (50) tercapai. Upgrade Premium!" });
            }
            req.userDoc = user; 
            return next();
        }

        // B. GUEST (Tanpa Login)
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const currentUsage = guestCache.get(ip) || 0;

        if (currentUsage >= 10) {
            return res.status(403).json({ success: false, message: "Limit Guest (10) tercapai. Silakan Login!" });
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
// 3. ENDPOINTS: STATS, HOME, & LIST
// ==========================================

// GET /api/stats
router.get('/stats', async (req, res) => {
    try {
        if (req.user && req.user.id) {
            const user = await User.findById(req.user.id);
            if (!user) return res.json({ type: 'guest', usage: 0, limit: 10 }); // Fallback if user null
            if (user.isPremium) return res.json({ type: 'premium', usage: user.downloadCount, limit: '∞' });
            return res.json({ type: 'user', usage: user.downloadCount, limit: 50 });
        }
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const usage = guestCache.get(ip) || 0;
        return res.json({ type: 'guest', usage: usage, limit: 10 });
    } catch (err) {
        return res.json({ type: 'guest', usage: 0, limit: 10 });
    }
});

// GET /api/home 
router.get('/home', async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);

        const totalMangaPromise = Manga.countDocuments();

        const recentsPromise = Manga.find()
            .select('title slug thumb metadata createdAt updatedAt') 
            .sort({ updatedAt: -1 }) 
            .skip(skip)
            .limit(limit)
            .lean(); 

        const trendingPromise = Manga.find()
            .select('title slug thumb views metadata')
            .sort({ views: -1 })
            .limit(10)
            .lean();

        const manhwasPromise = Manga.find({ 'metadata.type': { $regex: 'manhwa', $options: 'i' } })
            .select('title slug thumb metadata updatedAt')
            .sort({ updatedAt: -1 }) 
            .limit(10)
            .lean();

        const [totalManga, recentsRaw, trendingRaw, manhwasRaw] = await Promise.all([
            totalMangaPromise,
            recentsPromise,
            trendingPromise,
            manhwasPromise
        ]);

        const [recents, trending, manhwas] = await Promise.all([
            attachChapterCounts(recentsRaw),
            attachChapterCounts(trendingRaw),
            attachChapterCounts(manhwasRaw)
        ]);

        successResponse(res, { 
            recents, 
            trending,
            manhwas 
        }, {
            currentPage: page,
            totalPages: Math.ceil(totalManga / limit),
            totalItems: totalManga,
            perPage: limit
        });

    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/manga-list
router.get('/manga-list', async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);

        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(),
            Manga.find()
                .select('title slug thumb metadata.rating metadata.status metadata.type')
                .sort({ title: 1 }) // A-Z
                .skip(skip)
                .limit(limit)
                .lean()
        ]);
        
        const mangas = await attachChapterCounts(mangasRaw);

        successResponse(res, mangas, {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            perPage: limit
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 4. DETAIL & READ ENDPOINTS
// ==========================================

// GET /api/manga/:slug
router.get('/manga/:slug', async (req, res) => {
    try {
        const manga = await Manga.findOneAndUpdate(
            { slug: req.params.slug },
            { $inc: { views: 1 } },
            { new: true, timestamps: false }
        ).lean();

        if (!manga) return errorResponse(res, 'Manga not found', 404);

        const chapters = await Chapter.find({ manga_id: manga._id })
            .select('title slug chapter_index createdAt')
            .sort({ chapter_index: -1 }) 
            .collation({ locale: "en_US", numericOrdering: true })
            .lean();

        manga.chapter_count = chapters.length;

        successResponse(res, { info: manga, chapters });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/read/:slug/:chapterSlug
router.get('/read/:slug/:chapterSlug', async (req, res) => {
    try {
        const manga = await Manga.findOne({ slug: req.params.slug })
            .select('_id title slug thumb')
            .lean();
            
        if (!manga) return errorResponse(res, 'Manga not found', 404);

        const chapter = await Chapter.findOne({ 
            manga_id: manga._id, 
            slug: req.params.chapterSlug 
        }).lean();

        if (!chapter) return errorResponse(res, 'Chapter not found', 404);

        const [nextChap, prevChap] = await Promise.all([
            Chapter.findOne({ 
                manga_id: manga._id, 
                chapter_index: { $gt: chapter.chapter_index } 
            })
            .sort({ chapter_index: 1 })
            .select('slug title')
            .collation({ locale: "en_US", numericOrdering: true }) 
            .lean(),
            Chapter.findOne({ 
                manga_id: manga._id, 
                chapter_index: { $lt: chapter.chapter_index } 
            })
            .sort({ chapter_index: -1 })
            .select('slug title')
            .collation({ locale: "en_US", numericOrdering: true })
            .lean()
        ]);

        successResponse(res, { 
            chapter, 
            manga, 
            navigation: {
                next: nextChap ? nextChap.slug : null,
                prev: prevChap ? prevChap.slug : null
            }
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 5. SEARCH & FILTERS
// ==========================================

// GET /api/search?q=keyword
router.get('/search', async (req, res) => {
    try {
        const keyword = req.query.q;
        if (!keyword) return errorResponse(res, 'Query parameter "q" required', 400);

        const { page, limit, skip } = getPaginationParams(req);
        const query = { title: { $regex: keyword, $options: 'i' } };

        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(query),
            Manga.find(query)
                .select('title slug thumb metadata')
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        const mangas = await attachChapterCounts(mangasRaw);

        successResponse(res, mangas, {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            perPage: limit
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/genres
router.get('/genres', async (req, res) => {
    try {
        const genres = await Manga.aggregate([
            { $unwind: "$tags" },
            { $match: { tags: { $ne: "" } } }, 
            { $group: { _id: "$tags", count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]);
        
        const formattedGenres = genres.map(g => ({ name: g._id, count: g.count }));
        
        successResponse(res, formattedGenres);
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/filter/:type/:value
router.get('/filter/:type/:value', async (req, res) => {
    try {
        const { type, value } = req.params;
        const { page, limit, skip } = getPaginationParams(req);

        let query = {};

        if (type === 'genre') {
            const cleanValue = value.replace(/-/g, '[\\s\\-]'); 
            query = { tags: { $regex: new RegExp(cleanValue, 'i') } };
        } else if (type === 'status') {
            query = { 'metadata.status': { $regex: `^${value}$`, $options: 'i' } };
        } else if (type === 'type') {
            query = { 'metadata.type': { $regex: `^${value}$`, $options: 'i' } };
        } else {
            return errorResponse(res, 'Invalid filter type. Use: genre, status, or type.', 400);
        }

        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(query),
            Manga.find(query)
                .sort({ updatedAt: -1 })
                .select('title slug thumb metadata updatedAt')
                .skip(skip)
                .limit(limit)
                .lean()
        ]);

        const mangas = await attachChapterCounts(mangasRaw);

        successResponse(res, mangas, {
            currentPage: page,
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            filter: { type, value },
            perPage: limit
        });

    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 6. DOWNLOAD ENDPOINT
// ==========================================
router.get('/download/:slug/:chapterSlug', checkDownloadLimit, async (req, res) => {
    try {
        const { slug, chapterSlug } = req.params;
        
        // 1. Ambil ID Manga dulu
        const manga = await Manga.findOne({ slug }).select('title _id').lean();
        if (!manga) return errorResponse(res, "Manga not found", 404);

        // 2. Ambil Chapter dengan mencocokkan manga_id
        // PENTING: Tambahkan manga_id agar tidak salah mengambil chapter dari manga lain
        const chapter = await Chapter.findOne({ 
            manga_id: manga._id, 
            slug: chapterSlug 
        }).lean();

        if (!chapter || !chapter.images || chapter.images.length === 0) {
            return errorResponse(res, "Images not found", 404);
        }

        const cleanTitle = manga.title.replace(/[^a-zA-Z0-9]/g, '-');
        
        // Setup Header PDF
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${cleanTitle}-Ch${chapter.chapter_index}.pdf"`);

        const doc = new PDFDocument({ autoFirstPage: false });
        doc.pipe(res);

        // Loop Images
        for (const url of chapter.images) {
            try {
                const response = await axios.get(url, { 
                    responseType: 'arraybuffer',
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://doujindesu.tv/' },
                    timeout: 15000 
                });
                // Kompres gambar agar PDF tidak terlalu besar
                const imgBuffer = await sharp(response.data).jpeg({ quality: 80 }).toBuffer();
                
                const img = doc.openImage(imgBuffer);
                doc.addPage({ size: [img.width, img.height] });
                doc.image(img, 0, 0);
            } catch (e) { 
                console.error(`[PDF Warning] Skip img: ${url} - Error: ${e.message}`); 
                // Kita continue saja agar PDF tetap terbuat walau ada 1 gambar gagal
            }
        }

        doc.end();

        // Update Limit setelah selesai stream
        res.on('finish', async () => {
            try {
                if (req.userDoc) {
                    await User.findByIdAndUpdate(req.userDoc._id, { $inc: { downloadCount: 1 } });
                } else if (req.isGuest) {
                    const cur = guestCache.get(req.clientIp) || 0;
                    guestCache.set(req.clientIp, cur + 1);
                }
            } catch (err) {
                console.error("[Limit Update Error]", err);
            }
        });

    } catch (err) {
        console.error(err);
        if (!res.headersSent) res.status(500).send("Error generating PDF");
    }
});

// ==========================================
// 7. WEBHOOK TRAKTEER
// ==========================================
router.post('/trakteer-webhook', async (req, res) => {
    try {
        const { supporter_email, status } = req.body;
        if (status === 'Success') {
            await User.findOneAndUpdate({ email: supporter_email }, { isPremium: true });
            console.log(`[Premium] ${supporter_email} upgraded!`);
        }
        res.sendStatus(200);
    } catch (err) {
        console.error("[Webhook Error]", err);
        res.sendStatus(500);
    }
});

module.exports = router;