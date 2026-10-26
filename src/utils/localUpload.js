import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// Base uploads directory: <backend_root>/public/uploads
const UPLOADS_BASE = path.join(process.cwd(), 'public', 'uploads');

const DIRS = {
    images: path.join(UPLOADS_BASE, 'images'),
    files: path.join(UPLOADS_BASE, 'files'),
    videos: path.join(UPLOADS_BASE, 'videos'),
    hls: path.join(UPLOADS_BASE, 'hls'),
    rawVideos: path.join(UPLOADS_BASE, 'raw_videos'),
};

// Ensure all upload directories exist
Object.values(DIRS).forEach((dirPath) => {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});

/**
 * Generates an absolute public URL for an uploaded file
 * Uses process.env.BACKEND_URL if set, otherwise derives from req
 */
export const getFilePublicUrl = (req, relativePath) => {
    const cleanRelative = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
    const baseUrl = process.env.BACKEND_URL
        ? process.env.BACKEND_URL.replace(/\/+$/, '')
        : (req ? `${req.protocol}://${req.get('host')}` : '');
    return `${baseUrl}${cleanRelative}`;
};

// Sanitize extension and create unique filename
const createFilename = (prefix, originalname) => {
    const ext = path.extname(originalname || '').toLowerCase();
    const safePrefix = prefix || 'file';
    return `${safePrefix}-${Date.now()}-${uuidv4().slice(0, 8)}${ext}`;
};

// 1. Image Storage (Profile photos, Course thumbnails, Logos)
const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, DIRS.images);
    },
    filename: (req, file, cb) => {
        cb(null, createFilename('img', file.originalname));
    },
});

export const imageUpload = multer({
    storage: imageStorage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
    fileFilter: (req, file, cb) => {
        if (!file.mimetype || !file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files (JPEG, PNG, WEBP, GIF, SVG) are allowed!'), false);
        }
        cb(null, true);
    },
});

// 2. Document/File Storage (PDFs, Notes, Assignments, Attachments)
const docStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, DIRS.files);
    },
    filename: (req, file, cb) => {
        cb(null, createFilename('doc', file.originalname));
    },
});

export const documentUpload = multer({
    storage: docStorage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
});

// 3. Raw Video Storage for HLS processing
const rawVideoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, DIRS.rawVideos);
    },
    filename: (req, file, cb) => {
        cb(null, createFilename('raw-vid', file.originalname));
    },
});

const MAX_VIDEO_UPLOAD_MB = Number(process.env.MAX_VIDEO_UPLOAD_MB || 500);

export const rawVideoUpload = multer({
    storage: rawVideoStorage,
    limits: { fileSize: MAX_VIDEO_UPLOAD_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file?.mimetype?.startsWith('video/')) {
            return cb(new Error('Only video files are allowed!'), false);
        }
        cb(null, true);
    },
});

// 4. Standard Non-HLS Video Storage
const standardVideoStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, DIRS.videos);
    },
    filename: (req, file, cb) => {
        cb(null, createFilename('vid', file.originalname));
    },
});

export const standardVideoUpload = multer({
    storage: standardVideoStorage,
    limits: { fileSize: MAX_VIDEO_UPLOAD_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!file?.mimetype?.startsWith('video/')) {
            return cb(new Error('Only video files are allowed!'), false);
        }
        cb(null, true);
    },
});

export { DIRS, UPLOADS_BASE };
