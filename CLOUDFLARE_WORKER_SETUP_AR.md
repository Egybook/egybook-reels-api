# إعداد Cloudflare Worker — EgyBook / Hovod

## لا تحتاج لإضافة إعدادات جديدة في Cloudflare لهذه النسخة

الـ Worker أصبح يستخدم الإعدادات الموجودة بالفعل:
- `SUPABASE_URL`: يُشتق منه تلقائيًا رابط Edge Function:
  `/functions/v1/egybook-hovod-authorize`
- `EGYBOOK_PLAYBACK_AUTH_SECRET`: يُستخدم كسر تجديد احتياطي إذا لم يوجد `EGYBOOK_HOVOD_REFRESH_SECRET`.
- `SUPABASE_ANON_KEY`: للتحقق من جلسة المستخدم.
- `NEON_DATABASE_URL`: لقاعدة بيانات Reels كما هي.
- `MEDIA_BUCKET` و`REELS_BUCKET`: يظلان مربوطين بالـ R2 buckets الحالية.

## إعدادات اختيارية فقط

يمكن لاحقًا إضافة:
- Variable: `EGYBOOK_PLAYBACK_AUTH_URL` إذا أردت تحديد رابط Edge Function يدويًا.
- Secret: `EGYBOOK_HOVOD_REFRESH_SECRET` إذا أردت اسمًا منفصلًا لسر التجديد.

إذا لم تضفهما، سيستخدم Worker القيم الموجودة أعلاه تلقائيًا. لا تحذف أو تدوّر أي Secret حالي.

## مهم قبل اعتماد التشغيل

هذا التعديل يزيل الحاجة إلى إدخال إعدادات جديدة يدويًا، لكنه لا ينشئ إعدادات Supabase الناقصة ولا ينشر Edge Function. يجب أن تكون دالة `egybook-hovod-authorize` منشورة ومضبوطة على Supabase، وأن تكون قيمة `EGYBOOK_PLAYBACK_AUTH_SECRET` في Worker مطابقة لسر الدالة. كما يجب أن يطابق سر التجديد إعداد Hovod عند تشغيله.

لا تنشر Hovod أو تغيّر إعداداته من هذه الحزمة. لم يتم إثبات تشغيل Hovod على Altare بعد.
