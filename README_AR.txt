EgyBook — R2 account media storage v1

الهدف:
- ربط وسائط الموقع العامة بالحاوية الجديدة egybook-media.
- وضع كل ملفات الحساب تحت مجلد UUID واحد.
- استمرار تسجيل روابط الملفات في Supabase من كود الموقع الحالي دون تغيير شكل الاستجابة.
- إبقاء ملفات الريلز منفصلة مؤقتًا عن وسائط المنشورات، وعدم نقلها إلى egybook-media في هذا التحديث؛ بيانات الريلز تظل في Neon، ومخزنها الحالي يبقى كما هو إلى أن يتم تحديد خادم الوسائط الرابع.

هيكل التخزين الجديد:
{user_id}/posts/{uuid}-{filename}
{user_id}/profile/{uuid}-{filename}

الربط:
MEDIA_BUCKET -> egybook-media
REELS_BUCKET -> egybook-reels (مؤقتًا لمسار الريلز الحالي فقط)

Secrets المطلوبة كما هي في Worker الحالي:
SUPABASE_URL
SUPABASE_ANON_KEY
NEON_DATABASE_URL

لا توجد MIGRATION_SECRET ولا endpoint ترحيل في هذا الإصدار.
لا يقوم هذا التحديث بحذف أو نقل أي ملفات قديمة.

التوافق:
- الموقع الحالي يرسل POST /media مع form fields: file وfolder (posts أو profile).
- Worker يتحقق من جلسة Supabase ويستخرج user.id؛ لا يعتمد على user_id يرسله المتصفح.
- بعد الرفع يتحقق من وجود الملف ومطابقة الحجم، ثم يعيد url بنفس الصيغة التي يتوقعها script.js.
- روابط /media/... تُخدم من MEDIA_BUCKET إذا كان المفتاح يبدأ بمجلد UUID، ومن REELS_BUCKET إذا كان المفتاح يبدأ بـ reels/.

قبل النشر:
1. تأكد أن Bucket egybook-media موجود.
2. استبدل ملفات Worker الثلاثة بهذا الإصدار في مستودع Worker.
3. تأكد من وجود R2 bindings بالأسماء المحددة أعلاه.
4. احتفظ بالـSecrets الثلاثة الحالية دون إرسالها لأي شخص.
5. انشر Worker.

الاختبار بعد النشر:
1. افتح عنوان Worker الأساسي؛ يجب أن يعرض media_bucket = egybook-media.
2. ارفع صورة منشور تجريبية من حسابك.
3. تأكد من ظهورها في R2 تحت {user_id}/posts/.
4. تأكد من حفظ الرابط في posts.media_url أو posts.media_urls حسب مسار النشر.
5. ارفع صورة شخصية تجريبية وتأكد من ظهورها تحت {user_id}/profile/ ومن تحديث profiles.avatar_url أو profiles.cover_url.

مهم:
- لم يتم تعديل ملفات واجهة الموقع؛ دالة uploadMediaToR2 الحالية متوافقة مع الاستجابة.
- لا تحذف bucket القديمة الآن. هذا الإصدار لا ينقل محتوياتها ولا يغيّر سجلات قديمة.
- لا تغيّر سياسات Supabase أو جداول قاعدة البيانات في هذه المرحلة.
