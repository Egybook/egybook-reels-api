# تكامل EgyBook مع Hovod — مرحلة جسر التصاريح (مسودة تنفيذية آمنة)

## ما أُضيف
- نقطتا Worker: `POST /hovod/playback/ticket` و`POST /hovod/playback/refresh`.
- لا يصدر Worker تصريح تشغيل إلا بعد استدعاء خدمة تفويض خلفية تابعة لـEgyBook.
- التوقيع HMAC-SHA256 متوافق مع تنسيق التذكرة الذي يتحقق منه Hovod: `base64url(payload).base64url(signature)`.
- مدة التصريح 5 دقائق، والتجديد يعيد فحص التفويض بدل تمديد التصريح تلقائيًا.
- كل الردود الحاملة للتذاكر تستخدم `Cache-Control: no-store`.
- إذا غابت الإعدادات أو تعذرت خدمة التفويض، يفشل المسار مغلقًا (503/403)، ولا يصدر رابط تشغيل.

## إعدادات Worker المطلوبة (Secrets/Variables)
- `HOVOD_PLAYBACK_TOKEN_SECRET`: سر عشوائي لا يقل عن 32 حرفًا؛ يجب أن يطابق `PLAYBACK_TOKEN_SECRET` في Hovod حرفيًا.
- `EGYBOOK_HOVOD_REFRESH_SECRET`: سر منفصل لا يقل عن 32 حرفًا؛ يجب أن يطابق `EGYBOOK_PLAYBACK_REFRESH_SECRET` في Hovod.
- `EGYBOOK_PLAYBACK_AUTH_URL`: عنوان endpoint خلفي في EgyBook يطبق قواعد الجمهور الحقيقية.
- `EGYBOOK_PLAYBACK_AUTH_SECRET`: سر منفصل بين Worker وخدمة التفويض.

لا تضع هذه القيم في JavaScript الواجهة أو ملفات عامة أو مستودع Git.

## إعدادات Hovod
في بيئة Hovod:
- `PLAYBACK_SECURITY_MODE=private`
- `PLAYBACK_TOKEN_SECRET` = نفس `HOVOD_PLAYBACK_TOKEN_SECRET` في Worker.
- `EGYBOOK_PLAYBACK_REFRESH_URL=https://<worker-host>/hovod/playback/refresh`
- `EGYBOOK_PLAYBACK_REFRESH_SECRET` = نفس `EGYBOOK_HOVOD_REFRESH_SECRET` في Worker.

## عقد خدمة التفويض الخلفية (غير موجودة في ملفات V55 الحالية)
Worker يرسل إلى `EGYBOOK_PLAYBACK_AUTH_URL` طلب POST مع:

```json
{ "playbackId": "...", "userId": "...", "action": "issue" }
```

أو `action: "refresh"`، مع header `x-egybook-playback-secret`.

يجب أن ترد الخدمة بـ`{ "allowed": true, "postId": "..." }` فقط بعد أن:
1. تربط `playbackId` بمنشور EgyBook الصحيح من سجل موثوق.
2. تتحقق من أن المنشور يستخدم Hovod فعلًا وأن حالة المعالجة جاهزة.
3. تتحقق من صلاحية المستخدم الحالي حسب قواعد `posts.visibility` وقواعد الأصدقاء/القوائم المخصصة الحالية.
4. ترفض المنشور المحذوف أو غير المنشور أو الذي تغير جمهوره أو سُحبت صلاحية مشاهدته.
5. لا تعتمد على قيمة visibility أو postId مرسلة من المتصفح.

**لا توجد في ملفات V55 الحالية خدمة خلفية أو جدول ربط موثق بين Hovod playbackId وposts.id؛ لذلك لم أكتب استعلامًا تخمينيًا ولم أفعّل الربط من الواجهة.** يلزم تنفيذ هذا endpoint في بيئة خادمية موثوقة بعد تأكيد مخطط قواعد الأصدقاء/الجمهور. بدون هذا endpoint، مسارات إصدار وتجديد التذاكر ترفض العمل.

## ما لم يتغير
- لم يتم تعديل الفيديوهات القديمة أو روابطها.
- لم يتم تغيير الصور أو الصوت أو مسارات رفع R2 الحالية.
- لم يتم حذف أو نقل أي بيانات أو ملفات.
- لم يتم نشر Worker أو Hovod أو تعديل إعدادات الإنتاج.
- لم يتم تغيير V55 frontend؛ فلا يزال يستخدم مسار الرفع القديم حتى استكمال endpoint وربط إنشاء أصول Hovod واختبارها.

## اختبارات منفذة
- `node --check worker.js` نجح.
- لم تُنفذ اختبارات تشغيل على Cloudflare/Hovod أو R2؛ لم تتوفر بيئة نشر/أسرار تشغيل.

## حالة الاعتماد
هذه مرحلة جسر تفويض قابلة للمراجعة، وليست تكامل فيديو إنتاجيًا مكتملًا. لا تفعّلها في الإنتاج قبل إنشاء endpoint التفويض واختباره، وربط إنشاء asset/upload في Hovod، وإضافة ربط metadata في Supabase بعد تأكيد schema.
