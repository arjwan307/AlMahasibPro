const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// الاتصال بقاعدة بيانات MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ تم الاتصال بقاعدة بيانات المحاسب برو بنجاح"))
  .catch(err => console.error("❌ خطأ في الاتصال بقاعدة البيانات:", err));

// نموذج المنتج في المخزون
const productSchema = new mongoose.Schema({
    name: { type: String, required: true },
    price: { type: Number, required: true },
    cost: { type: Number, required: true },
    stock: { type: Number, required: true }
});
const Product = mongoose.model('Product', productSchema);

// نموذج الفواتير والمبيعات لتخزينها في القاعدة
const saleSchema = new mongoose.Schema({
    items: [{
        name: String,
        price: Number,
        qty: Number
    }],
    totalAmount: { type: Number, required: true },
    date: { type: Date, default: Date.now }
});
const Sale = mongoose.model('Sale', saleSchema);

// جلب جميع المنتجات
app.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find();
        res.json({ success: true, products });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// إضافة منتج جديد للمخزون
app.post('/api/products', async (req, res) => {
    try {
        const { name, price, cost, stock } = req.body;
        const newProduct = new Product({ name, price, cost, stock });
        await newProduct.save();
        res.json({ success: true, product: newProduct });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// حفظ عملية البيع (الكاشير) في قاعدة البيانات وخصم المخزون
app.post('/api/sales', async (req, res) => {
    try {
        const { items, totalAmount } = req.body;
        
        // خصم الكميات من المخزون
        for (let item of items) {
            await Product.findOneAndUpdate(
                { name: item.name },
                { $inc: { stock: -item.qty } }
            );
        }

        // حفظ الفاتورة
        const newSale = new Sale({ items, totalAmount });
        await newSale.save();

        res.json({ success: true, message: "تم تسجيل البيع وحفظ الفاتورة في القاعدة بنجاح" });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 السيرفر يعمل على المنفذ: ${PORT}`);
});
