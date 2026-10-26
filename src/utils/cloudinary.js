/**
 * Backwards compatibility adapter for file uploads.
 * Replaces Cloudinary storage with local VPS disk storage.
 */
import { imageUpload, documentUpload, getFilePublicUrl } from './localUpload.js';

// Default export is imageUpload (formerly Cloudinary profile upload)
const upload = imageUpload;

// Named export for general files (formerly Cloudinary resource upload)
export const fileUpload = documentUpload;

export { getFilePublicUrl };
export default upload;
