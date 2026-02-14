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

// Helper: Optimized Chapter Count & Last Chapter
async function attachChapterInfo(mangas) {
    if (!mangas || mangas.length === 0) return [];
    const mangaIds = mangas.map(m => m._id);

    // 1. Hitung Total Chapter per Manga
    const counts = await Chapter.aggregate([
        { $match: { manga_id: { $in: mangaIds } } },
        { $group: { _id: "$manga_id", count: { $sum: 1 } } }
    ]);

    // 2. Cari Chapter Terakhir per Manga (Untuk tombol "Chapter ...")
    // Ini agak berat jika datanya jutaan, tapi untuk skala kecil-menengah oke.
    // Cara optimasi: simpan last_chapter di collection Manga saat upload chapter baru.
    // Di sini kita pakai cara simple dulu:
    const lastChapters = await Chapter.aggregate([
        { $match: { manga_id: { $in: mangaIds } } },
        { $sort: { chapter_index: -1 } },
        { $group: { 
            _id: "$manga_id", 
            last_chapter: { $first: "$chapter_index" },
            last_chapter_slug: { $first: "$slug" },
            updatedAt: { $first: "$createdAt" }
        }}
    ]);

    const countMap = {};
    counts.forEach(c => { countMap[c._id.toString()] = c.count; });

    const lastChapMap = {};
    lastChapters.forEach(c => { 
        lastChapMap[c._id.toString()] = {
            index: c.last_chapter,
            slug: c.last_chapter_slug,
            date: c.updatedAt
        }; 
    });

    return mangas.map(m => ({ 
        ...m, 
        chapter_count: countMap[m._id.toString()] || 0,
        last_chapter: lastChapMap[m._id.toString()]?.index || '?',
        last_chapter_slug: lastChapMap[m._id.toString()]?.slug || '',
        last_update: lastChapMap[m._id.toString()]?.date || m.updatedAt
    }));
}

// ==========================================
// 1. UTAMA: ADVANCED FILTER & SEARCH (GET /manga)
// ==========================================
router.get('/manga', async (req, res) => {
    try {
        const { page, limit, skip } = getPaginationParams(req);
        // 1. Tambahkan 'order' dalam destructuring query
        const { q, status, type, genre, order } = req.query;

        // Bangun Query Object Dinamis
        let query = {};

        // Filter Search (Title)
        if (q) {
            query.title = { $regex: q, $options: 'i' };
        }

        // Filter Status (Publishing/Finished)
        if (status && status !== 'all') {
            query['metadata.status'] = { $regex: new RegExp(`^${status}$`, 'i') };
        }

        // Filter Type (Manga/Manhwa/Doujinshi)
        if (type && type !== 'all') {
            query['metadata.type'] = { $regex: new RegExp(`^${type}$`, 'i') };
        }

        // Filter Genre
        if (genre && genre !== 'all') {
            const cleanGenre = genre.replace(/-/g, '[\\s\\-]');
            query.tags = { $regex: new RegExp(cleanGenre, 'i') };
        }

        // --- 2. LOGIKA SORTING BARU ---
        let sortOption = { updatedAt: -1 }; // Default: Terbaru

        switch (order) {
            case 'oldest':
                sortOption = { updatedAt: 1 }; // Terlama (Ascending)
                break;
            case 'popular':
                sortOption = { views: -1 }; // Terpopuler (Views terbanyak)
                break;
            case 'az':
                sortOption = { title: 1 }; // Abjad A-Z
                break;
            case 'za':
                sortOption = { title: -1 }; // Abjad Z-A
                break;
            default:
                sortOption = { updatedAt: -1 }; // Terbaru (Default)
        }

        // Eksekusi Query
        const total = await Manga.countDocuments(query);
        
        const mangasRaw = await Manga.find(query)
            .select('title slug thumb metadata views rating status type tags updatedAt') 
            .sort(sortOption) // 3. Gunakan variabel sortOption disini
            .skip(skip)
            .limit(limit)
            .lean();

        // Attach info tambahan (Chapter Count & Last Chapter)
        const mangas = await attachChapterInfo(mangasRaw);

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
        const selectFields = 'title slug thumb metadata views rating status type updatedAt';

        // Query 1: Recents (Update Terbaru)
        const recentsRaw = await Manga.find()
            .select(selectFields)
            .sort({ updatedAt: -1 })
            .limit(12)
            .lean();

        // Query 2: Trending (Top Views)
        const trendingRaw = await Manga.find()
            .select(selectFields)
            .sort({ views: -1 })
            .limit(10)
            .lean();

        // Query 3: Manhwa Update
        const manhwasRaw = await Manga.find({ 'metadata.type': { $regex: 'manhwa', $options: 'i' } })
            .select(selectFields)
            .sort({ updatedAt: -1 })
            .limit(12)
            .lean();
        
        // Attach Counts Paralel
        const [recents, trending, manhwas] = await Promise.all([
            attachChapterInfo(recentsRaw),
            attachChapterInfo(trendingRaw),
            attachChapterInfo(manhwasRaw)
        ]);

        res.json({
            success: true,
            data: {
                recents,
                trending,
                manhwas
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
                _id: { $ne: manga._id }
            })
            .select('title slug thumb metadata views rating')
            .limit(4)
            .lean();
            recommendations = await attachChapterInfo(recommendations);
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
        // Prev: Chapter Index Lebih Kecil Terdekat (Descending)
        // Next: Chapter Index Lebih Besar Terdekat (Ascending)
        
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
