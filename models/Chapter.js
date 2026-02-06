const mongoose = require('mongoose');

const ChapterSchema = new mongoose.Schema({
    manga_id: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Manga', // Relasi ke model Manga
        required: true,
        index: true 
    },
    title: String,
    slug: String,      // ex: chapter-1
    link: String,      // link sumber
    chapter_index: Number, // Untuk sorting urutan chapter
    images: [String]   // Array URL gambar
}, { timestamps: true });

// Index compound agar tidak ada duplikat chapter di manga yang sama
ChapterSchema.index({ manga_id: 1, slug: 1 }, { unique: true });

module.exports = mongoose.model('Chapter', ChapterSchema);