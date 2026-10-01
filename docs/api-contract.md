# عقد API المنفذ في المرحلة الأساسية
كل المسارات /api/v1، والجلسة تحدد الشركة والمستخدم والنطاق.
POST /companies/register: إنشاء شركة ومالك بحالة pending.
POST /auth/login وPOST /auth/logout: جلسة opaque؛ الخادم يخزن hash التوكن فقط.
GET /platform/companies/pending وPOST /platform/companies/:id/approve: لإدارة المنصة فقط.
GET /bootstrap: الحساب والصلاحيات والجهاز وبيانات أول تحميل.
GET /roles وPOST /users: أدوار الشركة وإنشاء مستخدم ضمن دور ونطاق مصرح.
POST /sync/push: batch عمليات مع UUID وتسلسل وتبعيات ونسخ؛ نتيجة لكل عملية.
GET /sync/pull?cursor=...: تغييرات وتومبستون ومؤشر التالي؛ تطبيق الصفحة محليًا بشكل ذري.
GET /sync/status: العمليات والتعارضات ضمن نطاق المستخدم والجهاز.
المسارات الأخرى تحت أسماء الوحدات، مع validation وpaging وفلاتر مصرح بها.
عمليات المزامنة المقبولة تشمل `draft.*` و`financial.record` و`commerce.commit` وعمليات
الكاشير والمندوب أدناه. عقود الرواتب لم تُفتح بعد.

## التجارة المنفذة

- GET /master-data: المواد والوحدات والأسعار والأطراف والمخازن والأرصدة ضمن الشركة.
- POST /catalog/units و/catalog/items و/catalog/items/:id/units و/catalog/prices.
- POST /customers و/suppliers و/warehouses.
- POST /commerce/commit: اعتماد مباشر مع operationId وتسلسل جهاز؛ الأنواع purchase وsale
  وpurchase_return وsale_return.
- GET /commerce/documents: آخر المستندات المصرح بها مع البنود والدفعات.
- `commerce.commit` مدعوم أيضًا داخل POST /sync/push وبالمعاملة نفسها.

القيم المالية والكميات ترسل كسلاسل عشرية حتى 6 منازل. المرتجع يتطلب
`originalDocumentId` و`originalLineId`. لا يقبل الخادم company_id من payload.

## الكاشير المنفذ

- POST /catalog/barcodes: ربط باركود بمادة ووحدة.
- POST /pos/devices: تسجيل جهاز ووضع restaurant أو market أو enterprise وسياسة الخصم.
- PUT /pos/devices/:deviceId/allocations/:itemId: حجز مخصص أوف لاين ضمن المخزون المتاح.
- GET /pos/bootstrap?deviceId=: تنزيل الجهاز والشفت والباركود والأسعار والعملاء والمخصص.
- POST /pos/operations: تنفيذ مباشر للعمليات أدناه.
- العمليات نفسها مدعومة في POST /sync/push: `pos.shift.open` و`pos.sale` و`pos.return`
  و`pos.shift.close`.

البيع يحمل `shiftId` و`deviceId` و`interfaceMode` وlines وpayments وdiscountAmount
وorderContext. `offlineOrigin=true` يفرض مخصص الجهاز. إغلاق الشفت المرسل بعد انقطاع
الاتصال يعتمد مرة واحدة ويعيد expectedCash وcountedCash وvariance.

## المندوبون المنفذون

- POST `/representatives`، PUT `/representatives/:id/customers/:customerId`، وPOST
  `/representatives/:id/routes` للإعداد المصرح.
- GET `/representatives/bootstrap` لتنزيل الملف والعملاء والمسار والمخزون والدين والعهدة
  والطلبات والتسليمات والتعارضات.
- POST `/representatives/operations` أو `/sync/push` للعمليات:
  `representative.load` و`representative.order` و`representative.sale` و
  `representative.return` و`representative.collection` و
  `representative.handover.submit` و`representative.handover.review`.

التحميل والبيع والمرتجع والتحصيل ومراجعة التسليم ذرية وidempotent. التحصيل يسدد الذمة
إلى عهدة المندوب ولا يعيد تسجيل الإيراد. التسليم المرسل لا ينقل النقد أو البضاعة قبل
مراجعة مشرف مخول.
