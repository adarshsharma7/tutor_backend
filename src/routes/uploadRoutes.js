import express from 'express';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { protect, authorize } from '../middleware/auth.js';
import { processVideoForHLS } from '../services/hlsService.js';
import { requireFeature } from '../middleware/subscriptionMiddleware.js';
import Lesson from '../models/Lesson.js';
import { getForUser as getEntitlementsForUser } from '../services/entitlementService.js';
import { evaluateAccess } from '../services/accessPolicy.js';
import { toStringId } from '../utils/audience.js';
import {
  imageUpload,
  documentUpload,
  standardVideoUpload,
  rawVideoUpload,
  getFilePublicUrl,
  DIRS
} from '../utils/localUpload.js';

const router = express.Router();

// Flexible multer field handlers to prevent "Unexpected field" errors
const handleImageUpload = (req, res, next) => {
  imageUpload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'file', maxCount: 1 },
    { name: 'thumbnail', maxCount: 1 },
    { name: 'avatar', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    req.file = req.files?.image?.[0]
      || req.files?.file?.[0]
      || req.files?.thumbnail?.[0]
      || req.files?.avatar?.[0]
      || null;
    next();
  });
};

const handleDocumentUpload = (req, res, next) => {
  documentUpload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'document', maxCount: 1 },
    { name: 'attachment', maxCount: 1 },
    { name: 'image', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    req.file = req.files?.file?.[0]
      || req.files?.document?.[0]
      || req.files?.attachment?.[0]
      || req.files?.image?.[0]
      || null;
    next();
  });
};

const handleStandardVideoUpload = (req, res, next) => {
  standardVideoUpload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    req.file = req.files?.video?.[0] || req.files?.file?.[0] || null;
    next();
  });
};

const handleRawVideoUpload = (req, res, next) => {
  rawVideoUpload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });
    req.file = req.files?.video?.[0] || req.files?.file?.[0] || null;
    next();
  });
};

const escapeRegex = (value = '') => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeCloudinaryAssetPath = (pathSuffix = '') => {
  const decoded = decodeURIComponent(String(pathSuffix).split('?')[0] || '');
  const match = decoded.match(/^[^/]+\/video\/upload\/(.+)$/);
  if (!match) return null;

  const parts = match[1].split('/').filter(Boolean);
  while (
    parts.length > 1
    && (
      /^v\d+$/.test(parts[0])
      || /^sp_/.test(parts[0])
      || parts[0].includes(',')
      || /^[a-z]_[^/]+/.test(parts[0])
    )
  ) {
    parts.shift();
  }

  return parts.join('/').replace(/\.(m3u8|ts|m4s|mp4)$/i, '');
};

const normalizeCloudinaryUrlAssetPath = (url = '') => {
  const match = String(url).match(/res\.cloudinary\.com\/([^/]+\/video\/upload\/[^?#]+)/i);
  return match ? normalizeCloudinaryAssetPath(match[1]) : null;
};

const lessonMatchesHlsPath = (lesson, normalizedPath) => {
  if (!lesson || !normalizedPath) return false;
  const videoUrl = lesson.content?.videoUrl || '';
  const lessonPath = normalizeCloudinaryUrlAssetPath(videoUrl);
  if (!lessonPath) return false;

  return normalizedPath === lessonPath
    || normalizedPath.startsWith(`${lessonPath}/`)
    || lessonPath.startsWith(`${normalizedPath}/`);
};

const canManageCourse = async (req, course) => {
  if (!course) return false;
  if (req.user.role === 'superadmin') return true;

  const entitlements = await getEntitlementsForUser(req.user);
  const userId = toStringId(req.user._id || req.user.id);
  const courseId = toStringId(course._id);
  const courseTutorId = toStringId(course.tutorId?._id || course.tutorId);
  const courseInstituteId = toStringId(course.instituteId);

  if (toStringId(course.createdBy) === userId) return true;
  if (entitlements?.tutorId && courseTutorId === entitlements.tutorId) return true;
  if ((entitlements?.tutorCourseIds || []).includes(courseId)) return true;

  if (req.user.role === 'admin' && courseInstituteId) {
    return (entitlements?.membershipInstituteIds || []).includes(courseInstituteId)
      || entitlements?.activeInstituteId === courseInstituteId;
  }

  return false;
};

const authorizeLessonHlsAccess = async (req, pathSuffix) => {
  const normalizedPath = normalizeCloudinaryAssetPath(pathSuffix);
  if (!normalizedPath) {
    return { allowed: false, status: 400, message: 'Invalid Cloudinary HLS path' };
  }

  let lesson = null;
  if (req.query.lessonId) {
    lesson = await Lesson.findById(req.query.lessonId).populate('courseId');
    if (!lesson || !lessonMatchesHlsPath(lesson, normalizedPath)) {
      return { allowed: false, status: 403, message: 'HLS asset does not belong to the requested lesson' };
    }
  } else {
    const assetStem = normalizedPath.split('/').pop();
    lesson = await Lesson.findOne({
      'content.videoUrl': { $regex: escapeRegex(assetStem), $options: 'i' }
    }).populate('courseId');

    if (!lesson || !lessonMatchesHlsPath(lesson, normalizedPath)) {
      return { allowed: false, status: 403, message: 'Unable to verify access to this video asset' };
    }
  }

  const course = lesson.courseId;
  if (!course) {
    return { allowed: false, status: 404, message: 'Course for this lesson was not found' };
  }

  if (await canManageCourse(req, course)) {
    return { allowed: true, lesson };
  }

  const entitlements = await getEntitlementsForUser(req.user);
  const requireEnrollment = !lesson.isFree;
  const decision = evaluateAccess({
    resource: course,
    entitlements,
    ownerId: course.createdBy,
    requireEnrollment,
    requirePayment: requireEnrollment && !course.isFree,
    isFree: course.isFree || lesson.isFree,
    courseId: course._id,
  });

  if (!decision.allowed) {
    return { allowed: false, status: 403, message: 'You are not authorized to stream this lesson video' };
  }

  return { allowed: true, lesson };
};

// ============================================================================
// @route   POST /api/upload/image
// @desc    Upload an image (Avatar, Thumbnail, Banner, etc.) directly to VPS
// @access  Private (Student, Tutor, Admin, Superadmin)
// ============================================================================
router.post(
  '/image',
  protect,
  authorize('tutor', 'admin', 'student', 'superadmin'),
  handleImageUpload,
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file uploaded' });
    }

    const relativeUrl = `/uploads/images/${req.file.filename}`;
    const fullUrl = getFilePublicUrl(req, relativeUrl);

    res.status(200).json({
      success: true,
      imageUrl: fullUrl,
      url: fullUrl,
      fileUrl: fullUrl,
      relativeUrl,
      filename: req.file.filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
      cloudinaryId: req.file.filename, // backward compatibility
    });
  }
);

// ============================================================================
// @route   POST /api/upload/file
// @desc    Upload a document/file (PDF, Word, Excel, Notes, Assignments) to VPS
// @access  Private (Student, Tutor, Admin, Superadmin)
// ============================================================================
router.post(
  '/file',
  protect,
  authorize('tutor', 'admin', 'student', 'superadmin'),
  handleDocumentUpload,
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const relativeUrl = `/uploads/files/${req.file.filename}`;
    const fullUrl = getFilePublicUrl(req, relativeUrl);

    res.status(200).json({
      success: true,
      fileUrl: fullUrl,
      url: fullUrl,
      imageUrl: fullUrl,
      relativeUrl,
      name: req.file.originalname,
      filename: req.file.filename,
      type: req.file.mimetype,
      size: req.file.size,
      cloudinaryId: req.file.filename, // backward compatibility
    });
  }
);

// ============================================================================
// @route   POST /api/upload/video
// @desc    Standard video upload (Direct MP4/WebM storage on VPS)
// @access  Private (Tutor, Admin, Superadmin)
// ============================================================================
router.post(
  '/video',
  protect,
  authorize('tutor', 'admin', 'superadmin'),
  handleStandardVideoUpload,
  (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No video file provided' });
    }

    const relativeUrl = `/uploads/videos/${req.file.filename}`;
    const fullUrl = getFilePublicUrl(req, relativeUrl);

    res.status(200).json({
      success: true,
      message: 'Video uploaded successfully to VPS',
      videoUrl: fullUrl,
      url: fullUrl,
      fileUrl: fullUrl,
      relativeUrl,
      filename: req.file.filename,
      size: req.file.size,
      duration: Number(req.body.duration || 0),
      status: 'ready',
    });
  }
);

// ============================================================================
// @route   POST /api/upload/video-hls
// @desc    Upload raw video, convert to HLS (.m3u8 + 6s .ts chunks) on VPS
// @access  Private (Tutor/Admin/Superadmin with HLS Subscription)
// ============================================================================
router.post(
  '/video-hls',
  protect,
  authorize('tutor', 'admin', 'superadmin'),
  requireFeature('hlsStreaming'), // SECURE: Only subscribed tenants can use HLS
  handleRawVideoUpload,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No video file provided' });
    }

    const videoId = uuidv4();

    try {
      // Run industry-standard FFMPEG HLS segmentation on VPS
      const hlsResult = await processVideoForHLS(req.file.path, DIRS.hls, videoId);

      const relativeUrl = hlsResult.playlistUrl; // /uploads/hls/<videoId>/index.m3u8
      const fullUrl = getFilePublicUrl(req, relativeUrl);

      res.status(200).json({
        success: true,
        message: 'Video converted to secure HLS streaming on VPS',
        estimatedPlaylistUrl: fullUrl,
        playlistUrl: fullUrl,
        videoUrl: fullUrl,
        url: fullUrl,
        relativeUrl,
        videoId,
        duration: Number(req.body.duration || 0),
        videoSize: req.file.size,
        status: 'ready',
      });
    } catch (error) {
      console.error('HLS Conversion Error on VPS:', error);
      // Clean up raw temp file if still present
      try {
        if (req.file && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      } catch (_) {}
      res.status(500).json({ success: false, message: 'Server error during HLS video processing' });
    }
  }
);

// ============================================================================
// @route   POST /api/upload/cloudinary-signature
// @desc    Legacy fallback signature route (Directs clients to VPS endpoints)
// @access  Private
// ============================================================================
router.post('/cloudinary-signature', protect, (req, res, next) => {
  if (req.body?.type === 'hls') {
    return requireFeature('hlsStreaming')(req, res, next);
  }
  next();
}, (req, res) => {
  const isHls = req.body?.type === 'hls';
  res.json({
    success: true,
    isLocal: true,
    uploadEndpoint: isHls ? '/api/upload/video-hls' : '/api/upload/video',
    message: 'VPS local upload active',
  });
});

// ============================================================================
// @route   GET /api/upload/secure-hls/*cloudinaryPath
// @desc    Legacy proxy for previously stored Cloudinary HLS assets
// @access  Private (Authenticated Students/Tutors/Admins)
// ============================================================================
router.get(/^\/secure-hls\/(.*)/, protect, async (req, res) => {
  let pathSuffix = req.params[0];

  if (Array.isArray(pathSuffix)) {
    pathSuffix = pathSuffix.join('/');
  }
  if (!pathSuffix) {
    return res.status(400).json({ success: false, message: 'Invalid HLS path' });
  }

  let accessDecision;
  try {
    accessDecision = await authorizeLessonHlsAccess(req, pathSuffix);
  } catch (error) {
    console.error('Secure HLS access check error:', error.message);
    return res.status(500).json({ success: false, message: 'Failed to verify HLS access' });
  }

  if (!accessDecision.allowed) {
    return res.status(accessDecision.status || 403).json({
      success: false,
      message: accessDecision.message || 'Not authorized to stream this video',
    });
  }

  const cloudinaryUrl = `https://res.cloudinary.com/${pathSuffix}`;
  const isManifest = pathSuffix.endsWith('.m3u8');

  const headers = {};
  if (req.headers.range) {
    headers.range = req.headers.range;
  }

  try {
    if (isManifest) {
      const response = await axios.get(cloudinaryUrl, {
        headers,
        responseType: 'text',
      });

      const token = req.query.token
        || req.cookies?.token
        || (req.headers.authorization ? req.headers.authorization.split(' ')[1] : null);
      const isCookieAuth = !req.query.token && req.cookies?.token;
      let manifestText = response.data;

      const lines = manifestText.split(/\r?\n/);
      const rewrittenLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          return line;
        }

        let rewrittenUri = trimmed;
        const cloudinaryMatch = rewrittenUri.match(
          /(?:https:\/\/res\.cloudinary\.com)?\/([a-zA-Z0-9_-]+)\/video\/upload\/([^\s?]+)/
        );
        if (cloudinaryMatch) {
          const [_, cloudName, rest] = cloudinaryMatch;
          rewrittenUri = `/api/proxy/upload/secure-hls/${cloudName}/video/upload/${rest}`;
        }

        if (token && !isCookieAuth) {
          const separator = rewrittenUri.includes('?') ? '&' : '?';
          if (!rewrittenUri.includes('token=')) {
            rewrittenUri = `${rewrittenUri}${separator}token=${token}`;
          }
        }

        if (accessDecision.lesson?._id && !rewrittenUri.includes('lessonId=')) {
          const separator = rewrittenUri.includes('?') ? '&' : '?';
          rewrittenUri = `${rewrittenUri}${separator}lessonId=${accessDecision.lesson._id}`;
        }

        return rewrittenUri;
      });

      manifestText = rewrittenLines.join('\n');
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(manifestText);
    } else {
      const response = await axios.get(cloudinaryUrl, {
        headers,
        responseType: 'stream',
      });

      if (response.headers['content-type']) res.setHeader('content-type', response.headers['content-type']);
      if (response.headers['content-length']) res.setHeader('content-length', response.headers['content-length']);
      if (response.headers['accept-ranges']) res.setHeader('accept-ranges', response.headers['accept-ranges']);
      if (response.headers['content-range']) res.setHeader('content-range', response.headers['content-range']);

      res.status(response.status);
      response.data.pipe(res);
    }
  } catch (error) {
    console.error('Secure HLS Proxy Error:', error.message);
    if (error.response) {
      return res.status(error.response.status).send(error.response.statusText);
    }
    return res.status(500).json({ success: false, message: 'Failed to stream secure HLS resource' });
  }
});

export default router;
