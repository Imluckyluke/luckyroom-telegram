const bcrypt = require('bcryptjs');

// Fixed catalog the client renders as a dropdown at registration. IDs are
// stable — never reorder/remove/renumber existing entries, only append,
// since user_security_questions rows reference these ids.
const CATALOG = [
  { id: 1, text: 'نام اولین مدرسه‌ای که در آن تحصیل کردید چیست؟' },
  { id: 2, text: 'نام اولین حیوان خانگی شما چه بود؟' },
  { id: 3, text: 'شهر محل تولد پدر یا مادر شما کجاست؟' },
  { id: 4, text: 'نام بهترین دوست دوران کودکی‌تان چیست؟' },
  { id: 5, text: 'غذای مورد علاقه‌ی دوران کودکی شما چه بود؟' },
  { id: 6, text: 'نام اولین معلم مورد علاقه‌تان چه بود؟' },
  { id: 7, text: 'مدل یا برند اولین ماشینی که سوار شدید چه بود؟' },
  { id: 8, text: 'نام خیابان محل زندگی دوران کودکی‌تان چیست؟' },
  { id: 9, text: 'نام دانشگاه یا دانشکده‌ی مورد علاقه‌ی شما چیست؟' },
  { id: 10, text: 'لقب یا اسم مستعار دوران کودکی شما چه بود؟' }
];

const CATALOG_IDS = new Set(CATALOG.map((q) => q.id));

function getCatalog() {
  return CATALOG;
}

function questionText(id) {
  const q = CATALOG.find((item) => item.id === id);
  return q ? q.text : null;
}

function isValidQuestionId(id) {
  return CATALOG_IDS.has(Number(id));
}

// Case/whitespace-insensitive so trivial formatting differences at answer
// time don't fail a legitimate user (answers are freeform text).
function normalizeAnswer(answer) {
  return String(answer || '').trim().toLowerCase();
}

function hashAnswer(answer) {
  return bcrypt.hashSync(normalizeAnswer(answer), 10);
}

function verifyAnswer(answer, hash) {
  return bcrypt.compareSync(normalizeAnswer(answer), hash);
}

module.exports = {
  getCatalog,
  questionText,
  isValidQuestionId,
  normalizeAnswer,
  hashAnswer,
  verifyAnswer
};
