const User = require('./models/User');

// Simpan limit guest di memori (untuk produksi disarankan pakai Redis)
const guestCache = new Map();

const checkDownloadLimit = async (req, res, next) => {
    try {
        // 1. Logika User Login (Firebase/Google)
        if (req.user) {
            const user = await User.findById(req.user.id);
            if (!user) return res.status(404).send("User not found");

            if (user.isPremium) return next(); // Unlimited

            if (user.downloadCount >= 50) {
                return res.status(403).json({ 
                    success: false, 
                    message: "Limit login (50) tercapai. Donasi di Trakteer untuk Unlimited!" 
                });
            }
            req.userDoc = user; // Simpan untuk update nanti
            return next();
        }

        // 2. Logika Guest (Tanpa Login) via IP
        const ip = req.ip;
        const currentUsage = guestCache.get(ip) || 0;

        if (currentUsage >= 10) {
            return res.status(403).json({ 
                success: false, 
                message: "Limit Guest (10) tercapai. Silakan login untuk kuota 50!" 
            });
        }
        
        req.isGuest = true;
        next();
    } catch (err) {
        res.status(500).send("Limit Check Error");
    }
};

module.exports = { checkDownloadLimit, guestCache };