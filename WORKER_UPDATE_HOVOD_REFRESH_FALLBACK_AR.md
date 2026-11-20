تحديث توافق Worker — Hovod Refresh Secret

- تم الإبقاء على worker.js الأحدث الموجود في مجلد cloudflare كما هو، دون استبداله بنسخة أقدم.
- التعديل الوحيد: مسار تجديد تذكرة التشغيل يقبل EGYBOOK_HOVOD_REFRESH_SECRET، وإذا لم يكن مضبوطًا يستخدم السر الموجود بالفعل EGYBOOK_PLAYBACK_AUTH_SECRET.
- لم يتم تضمين أي قيمة سرية داخل الملفات.
- إعداد EGYBOOK_PLAYBACK_AUTH_URL يظل متغيرًا في Cloudflare Production كما أضفته من لوحة التحكم.
- تم الإبقاء على ربط MEDIA_BUCKET مع egybook-media وREELS_BUCKET مع egybook-reels في wrangler.jsonc.
- لم يتم تنفيذ Deploy أو الاتصال بحساب Cloudflare أو Neon من هنا.
