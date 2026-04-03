// Build script - creates a distributable folder with the exe and all static files
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DIST = path.join(__dirname, 'dist');

// Clean dist
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

// Copy static files
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

copyDir(path.join(__dirname, 'public'), path.join(DIST, 'public'));
fs.mkdirSync(path.join(DIST, 'media'), { recursive: true });

// Copy exe
if (fs.existsSync(path.join(__dirname, 'iptv-server.exe'))) {
  fs.copyFileSync(path.join(__dirname, 'iptv-server.exe'), path.join(DIST, 'iptv-server.exe'));
}

// Create launcher bat
fs.writeFileSync(path.join(DIST, 'START-IPTV.bat'), `@echo off
title IPTV Learning System
echo ========================================
echo    Starting IPTV Learning System...
echo ========================================
echo.
iptv-server.exe
pause
`);

console.log('Build complete! Check the dist/ folder.');
console.log('Files:', fs.readdirSync(DIST));
