import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';

// Set the ffmpeg executable path explicitly
ffmpeg.setFfmpegPath(ffmpegInstaller);

/**
 * Process a video file for HLS streaming
 * @param {string} inputPath - Absolute path to the uploaded raw video
 * @param {string} outputBaseDir - Absolute path to the base HLS directory
 * @param {string} fileId - Unique ID for this video (creates a folder for its chunks)
 * @returns {Promise} Resolves with the relative URL to the m3u8 playlist
 */
export const processVideoForHLS = (inputPath, outputBaseDir, fileId) => {
    return new Promise((resolve, reject) => {
        const hlsDir = path.join(outputBaseDir, fileId);
        if (!fs.existsSync(hlsDir)) {
            fs.mkdirSync(hlsDir, { recursive: true });
        }

        const outputPath = path.join(hlsDir, 'index.m3u8');
        console.log(`Starting FFMPEG HLS processing for: ${fileId}`);

        // Try fast stream copy first (-c copy) for near-instant chunking (2-4 seconds)
        const runStreamCopy = () => {
            ffmpeg(inputPath, { timeout: 432000 })
                .outputOptions([
                    '-c copy',
                    '-start_number 0',
                    '-hls_time 6',      // 6-second segments for instant scrubbing
                    '-hls_list_size 0',  // Keep all segments in playlist (VOD)
                    '-f hls'
                ])
                .output(outputPath)
                .on('end', () => {
                    console.log(`HLS stream-copy successfully finished for: ${fileId}`);
                    // Clean up raw temp file to save VPS disk space
                    try {
                        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                    } catch (e) {
                        console.error('Failed to clean up raw input file:', e);
                    }
                    resolve({
                        success: true,
                        playlistUrl: `/uploads/hls/${fileId}/index.m3u8`,
                        hlsDir
                    });
                })
                .on('error', (err) => {
                    console.warn(`HLS stream-copy failed (${err.message}). Retrying with high-compatibility transcode...`);
                    runTranscodeFallback();
                })
                .run();
        };

        // Fallback for non-standard codecs: re-encode to high compatibility H.264
        const runTranscodeFallback = () => {
            ffmpeg(inputPath, { timeout: 432000 })
                .outputOptions([
                    '-c:v libx264',
                    '-preset veryfast',
                    '-crf 22',
                    '-profile:v main',
                    '-level 3.1',
                    '-c:a aac',
                    '-b:a 128k',
                    '-start_number 0',
                    '-hls_time 6',
                    '-hls_list_size 0',
                    '-f hls'
                ])
                .output(outputPath)
                .on('end', () => {
                    console.log(`HLS transcode successfully finished for: ${fileId}`);
                    try {
                        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                    } catch (e) {
                        console.error('Failed to clean up raw input file:', e);
                    }
                    resolve({
                        success: true,
                        playlistUrl: `/uploads/hls/${fileId}/index.m3u8`,
                        hlsDir
                    });
                })
                .on('error', (err) => {
                    console.error(`FFMPEG Error processing ${fileId}:`, err.message);
                    try {
                        if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                    } catch (_) {}
                    reject(err);
                })
                .run();
        };

        runStreamCopy();
    });
};
