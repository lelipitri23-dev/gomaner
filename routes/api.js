const express = require('express');
const router = express.Router();
const Manga = require('../models/Manga');
const Chapter = require('../models/Chapter');

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Standard Response Format
const successResponse = (res, data, pagination = null) => {
    res.json({
        success: true,
        data,
        pagination
    });
};

const errorResponse = (res, message, code = 500) => {
    console.error(`[Error] ${message}`);
    res.status(code).json({ success: false, message });
};

// Helper: Kalkulasi Pagination
const getPaginationParams = (req, defaultLimit = 24) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || defaultLimit);
    const skip = (page - 1) * limit;
    return { page, limit, skip };
};

// Helper: Optimized Chapter Count
async function attachChapterCounts(mangas) {
    if (!mangas || mangas.length === 0) return [];
    const mangaIds = mangas.map(m => m._id);
    const counts = await Chapter.aggregate([
        { $match: { manga_id: { $in: mangaIds } } },
        { $group: { _id: "$manga_id", count: { $sum: 1 } } }
    ]);
    const countMap = {};
    counts.forEach(c => { countMap[c._id.toString()] = c.count; });
    return mangas.map(m => ({ ...m, chapter_count: countMap[m._id.toString()] || 0 }));
}

// ==========================================
// 1. UTAMA: ADVANCED FILTER & SEARCH (GET /manga)
// ==========================================
// Endpoint ini menggantikan /manga-list, /search, dan /filter terpisah
router.get('/manga', async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);
        const { q, status, type, genre } = req.query;

        // Bangun Query Object Dinamis
        let query = {};

        // 1. Search (Title)
        if (q) {
            query.title = { $regex: q, $options: 'i' };
        }

        // 2. Filter Status (Publishing/Finished)
        if (status && status !== 'all') {
            query['metadata.status'] = { $regex: `^${status}$`, $options: 'i' };
        }

        // 3. Filter Type (Manga/Manhwa/Doujinshi)
        if (type && type !== 'all') {
            query['metadata.type'] = { $regex: `^${type}$`, $options: 'i' };
        }

        // 4. Filter Genre
        if (genre && genre !== 'all') {
            // Regex fleksibel untuk menangani spasi atau dash
            const cleanGenre = genre.replace(/-/g, '[\\s\\-]');
            query.tags = { $regex: new RegExp(cleanGenre, 'i') };
        }

        // Eksekusi Query
        const [total, mangasRaw] = await Promise.all([
            Manga.countDocuments(query),
            Manga.find(query)
                .select('title slug thumb metadata updatedAt')
                .sort({ updatedAt: -1 }) // Selalu urutkan update terbaru
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
// 2. HOME PAGE DATA
// ==========================================
router.get('/home', async (req, res) => {
    try {
        // Query 1: Recents (Update Terbaru)
        const recentsRaw = await Manga.find()
            .select('title slug thumb metadata createdAt updatedAt')
            .sort({ updatedAt: -1 })
            .limit(12)
            .lean();

        // Query 2: Trending (Top Views)
        const trendingRaw = await Manga.find()
            .select('title slug thumb views metadata')
            .sort({ views: -1 })
            .limit(10)
            .lean();

        // Query 3: Manhwa Update
        const manhwasRaw = await Manga.find({ 'metadata.type': { $regex: 'manhwa', $options: 'i' } })
            .select('title slug thumb metadata updatedAt')
            .sort({ updatedAt: -1 })
            .limit(12)
            .lean();
        
        // Query 4: Doujinshi Update (Optional, buat jaga-jaga)
        const doujinshiRaw = await Manga.find({ 'metadata.type': { $regex: 'doujin', $options: 'i' } })
            .select('title slug thumb metadata updatedAt')
            .sort({ updatedAt: -1 })
            .limit(12)
            .lean();

        // Attach Counts Paralel
        const [recents, trending, manhwas, doujinshi] = await Promise.all([
            attachChapterCounts(recentsRaw),
            attachChapterCounts(trendingRaw),
            attachChapterCounts(manhwasRaw),
            attachChapterCounts(doujinshiRaw)
        ]);

        // Kirim struktur yang sesuai dengan Frontend page.js
        res.json({
            success: true,
            data: {
                recents,
                trending,
                manhwas,  // Plural sesuai frontend
                doujinshi // Tambahan
            }
        });

    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 3. DETAIL & READ ENDPOINTS
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

        // Ambil Chapter
        const chapters = await Chapter.find({ manga_id: manga._id })
            .select('title slug chapter_index createdAt')
            .sort({ chapter_index: -1 }) 
            .collation({ locale: "en_US", numericOrdering: true })
            .lean();
        
        // Ambil Rekomendasi (Genre Sejenis)
        let recommendations = [];
        if (manga.tags && manga.tags.length > 0) {
            recommendations = await Manga.find({
                tags: { $in: manga.tags },
                _id: { $ne: manga._id } // Jangan tampilkan manga yang sama
            })
            .select('title slug thumb metadata')
            .limit(4)
            .lean();
            recommendations = await attachChapterCounts(recommendations);
        }

        successResponse(res, { info: manga, chapters, recommendations });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// GET /api/read/:slug/:chapterSlug
router.get('/read/:slug/:chapterSlug', async (req, res) => {
    try {
        // 1. Cari Manga ID dulu
        const manga = await Manga.findOne({ slug: req.params.slug })
            .select('_id title slug thumb')
            .lean();
            
        if (!manga) return errorResponse(res, 'Manga not found', 404);

        // 2. Cari Current Chapter
        const chapter = await Chapter.findOne({ 
            manga_id: manga._id, 
            slug: req.params.chapterSlug 
        }).lean();

        if (!chapter) return errorResponse(res, 'Chapter not found', 404);

        // 3. Cari Next & Prev Chapter
        // Logic: 
        // Next Chapter = Chapter Index yang lebih besar TERDEKAT (sort Ascending 1)
        // Prev Chapter = Chapter Index yang lebih kecil TERDEKAT (sort Descending -1)
        
        const [nextChap, prevChap] = await Promise.all([
            Chapter.findOne({ 
                manga_id: manga._id, 
                chapter_index: { $gt: chapter.chapter_index } 
            })
            .sort({ chapter_index: 1 }) // Ambil yang paling kecil dari yang lebih besar
            .select('slug title')
            .collation({ locale: "en_US", numericOrdering: true }) 
            .lean(),
            Chapter.findOne({ 
                manga_id: manga._id, 
                chapter_index: { $lt: chapter.chapter_index } 
            })
            .sort({ chapter_index: -1 }) // Ambil yang paling besar dari yang lebih kecil
            .select('slug title')
            .collation({ locale: "en_US", numericOrdering: true })
            .lean()
        ]);

        successResponse(res, { 
            chapter, 
            manga, 
            navigation: {
                next: nextChap ? nextChap.slug : null, // Next logic button biasanya ke chapter lebih besar
                prev: prevChap ? prevChap.slug : null
            }
        });
    } catch (err) {
        errorResponse(res, err.message);
    }
});

// ==========================================
// 4. GENRES LIST
// ==========================================
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

module.exports = router;
