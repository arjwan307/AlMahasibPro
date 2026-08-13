import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middlewares
app.use(cors());
app.use(express.json());

// مسار تجريبي بسيط جداً
app.get('/', (req, res) => {
  res.send('🚀 مرحباً بك في خادم المحاسب برو! السيرفر يعمل، ولكن لم يتم رفع الملفات الجديدة بعد.');
});

// تشغيل السيرفر
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
