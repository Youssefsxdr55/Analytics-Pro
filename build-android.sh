#!/data/data/com.termux/files/usr/bin/bash
set -e
npm install
npx cap add android
npx cap sync android
cd android
./gradlew assembleDebug
