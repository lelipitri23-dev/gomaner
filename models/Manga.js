const mongoose = require('mongoose');

const MangaSchema = new mongoose.Schema({
    title: { type: String, required: true },
    alternativeTitle: String,
    slug: { type: String, required: true, unique: true, index: true },
    thumb: String,
    synopsis: String,
    // TAMBAHAN: Field Views
    views: { type: Number, default: 0 }, 
    metadata: {
        status: String,
        type: { type: String }, 
        series: String,
        author: String,
        rating: String,
        created: String
    },
    tags: [String]
}, { timestamps: true });

module.exports = mongoose.model('Manga', MangaSchema);
