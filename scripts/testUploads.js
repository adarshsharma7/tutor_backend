import path from 'path';
import fs from 'fs';
import { getFilePublicUrl, DIRS } from '../src/utils/localUpload.js';

console.log('--- Testing Local Upload Configuration ---');

console.log('Upload Directories:');
Object.entries(DIRS).forEach(([key, dirPath]) => {
  const exists = fs.existsSync(dirPath);
  console.log(`- ${key}: ${dirPath} (Exists: ${exists})`);
  if (!exists) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`  Created ${dirPath}`);
  }
});

// Test URL generator
const mockReq = {
  protocol: 'http',
  get: (header) => (header.toLowerCase() === 'host' ? '195.35.20.207:4000' : ''),
};

const testRelativeUrl = '/uploads/images/sample-profile.png';
const publicUrl = getFilePublicUrl(mockReq, testRelativeUrl);
console.log('Sample Public URL Generated:', publicUrl);

if (publicUrl.includes('/uploads/images/sample-profile.png')) {
  console.log('✅ URL resolution test passed!');
} else {
  console.error('❌ URL resolution test failed!');
  process.exit(1);
}

// Test writing and reading a sample test file
const testImgPath = path.join(DIRS.images, 'test-ping.txt');
fs.writeFileSync(testImgPath, 'VPS Local Upload Test OK');
if (fs.existsSync(testImgPath)) {
  const content = fs.readFileSync(testImgPath, 'utf8');
  console.log('Sample file written and verified:', content);
  fs.unlinkSync(testImgPath);
  console.log('✅ Local file system read/write/unlink verified successfully!');
}

console.log('--- All Upload Engine Self-Tests Passed! ---');
