import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// الاتصال بقاعدة بيانات MongoDB
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ تم الاتصال بـ MongoDB بنجاح!'))
  .catch(err => {
    console.error('❌ خطأ في الاتصال بـ MongoDB:', err.message);
    // لا نغلق السيرفر، بل نستمر في العمل
  });

// تعريف نموذج العميل (Sample Schema)
const ClientSchema = new mongoose.Schema({
  name: String,
  invoiceType: String,
  amount: Number,
  status: String
});
const Client = mongoose.model('Client', ClientSchema);

// API: جلب البيانات من قاعدة البيانات
app.get('/api/clients', async (req, res) => {
  try {
    const clients = await Client.find();
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: 'فشل في جلب البيانات' });
  }
});

// توجيه الصفحات
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
