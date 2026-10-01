# API

نواة Node.js/Express مع PostgreSQL ومخزن ذاكرة للاختبارات. نقطة الإنشاء في `src/app.js`،
والتخزين في `src/store`. المسارات المنفذة موثقة في `docs/api-contract.md`.
الخادم لا يأخذ `company_id` من العميل؛ سياق الشركة مشتق من الجلسة.
