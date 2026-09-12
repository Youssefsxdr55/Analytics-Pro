Analytics Pro — مشروع Android مستقل

هذا المشروع يغلّف نسخة PWA داخل تطبيق Android باستخدام Capacitor.
الصفحة والبيانات تعمل محليًا داخل التطبيق، ولا تحتاج فتح Chrome.

لبناء APK على جهاز/خدمة تدعم Node.js:
1) npm install
2) npx cap add android
3) npm run build
4) cd android
5) ./gradlew assembleDebug

سيظهر APK في:
android/app/build/outputs/apk/debug/app-debug.apk

ملاحظة: مجلد Android لا يتم تضمينه هنا لتقليل الحجم؛ يتم إنشاؤه بأمر npx cap add android.
