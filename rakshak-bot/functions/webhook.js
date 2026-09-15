const { Telegraf } = require('telegraf');
const { getStore } = require('@netlify/blobs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '');
const PRIMARY_UPI = process.env.PRIMARY_UPI || '';
const BACKUP_UPIS = [process.env.BACKUP_UPI_1 || '', process.env.BACKUP_UPI_2 || ''].filter(Boolean);
const PAYMENT_NAME = process.env.PAYMENT_NAME || 'Rakshak';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN environment variable is missing');
if (!ADMIN_ID) throw new Error('ADMIN_ID environment variable is missing');

const bot = new Telegraf(BOT_TOKEN);
const store = getStore('rakshak-bot');

// These are the complete license pools requested by the owner.
// IMPORTANT: assignment state is NOT kept in memory. Netlify Blobs persists it.
const LICENSE_POOLS = Object.freeze({
  '49': Array.from({ length: 10 }, (_, i) => `RAKSHAK-PRO-${String(i * 11).padStart(2, '0')}`),
  '599': Array.from({ length: 9 }, (_, i) => `RAKSHAK-PRO-${String((i + 1) * 111)}`),
  '999': Array.from({ length: 9 }, (_, i) => `RAKSHAK-PRO-${String((i + 1) * 1111)}`),
});

const PLANS = new Set(Object.keys(LICENSE_POOLS));

function userKey(chatId) { return `user:${chatId}`; }
function paymentKey(paymentId) { return `payment:${paymentId}`; }
function codeKey(plan, code) { return `license:${plan}:${code}`; }

async function getJson(key, consistency = 'strong') {
  const entry = await store.getWithMetadata(key, { type: 'json', consistency });
  if (!entry) return null;
  return { ...entry.data, etag: entry.etag };
}

async function setJson(key, value, options = {}) {
  return store.set(key, JSON.stringify(value), options);
}

function newPaymentId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeMd(text) {
  return String(text).replace(/([_*`\[\]])/g, '\\$1');
}

async function getUser(chatId) {
  return (await getJson(userKey(chatId))) || {};
}

async function setUser(chatId, value) {
  await setJson(userKey(chatId), value);
}

async function initializeLicensePool() {
  // Initialize each code only once. Existing assignment records are never overwritten.
  for (const [plan, codes] of Object.entries(LICENSE_POOLS)) {
    for (const code of codes) {
      const key = codeKey(plan, code);
      const existing = await getJson(key);
      if (!existing) {
        await setJson(key, { status: 'available', plan, code, assignedTo: null, paymentId: null, assignedAt: null }, { onlyIfNew: true });
      }
    }
  }
}

async function findAvailableAndClaim(plan, paymentId, userId) {
  const codes = LICENSE_POOLS[plan] || [];

  for (const code of codes) {
    const key = codeKey(plan, code);
    const current = await getJson(key, 'strong');
    if (!current) continue;
    if (current.status === 'assigned') {
      // Never hand an assigned code to anyone else.
      if (current.paymentId === paymentId && String(current.assignedTo) === String(userId)) return current;
      continue;
    }

    const claimed = {
      ...current,
      status: 'assigned',
      assignedTo: String(userId),
      paymentId,
      assignedAt: new Date().toISOString(),
    };

    try {
      // Optimistic compare-and-swap prevents two concurrent approvals from claiming the same code.
      const result = await setJson(key, claimed, { onlyIfMatch: current.etag });
      if (result.modified) return claimed;
    } catch (err) {
      // Another invocation won the race; try the next code.
    }
  }

  return null;
}

async function countAvailable(plan) {
  let available = 0;
  for (const code of LICENSE_POOLS[plan] || []) {
    const item = await getJson(codeKey(plan, code), 'strong');
    if (!item || item.status === 'available') available++;
  }
  return available;
}

async function notifyAdmin(text, paymentId) {
  return bot.telegram.sendMessage(ADMIN_ID, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${paymentId}` },
        { text: '❌ Reject', callback_data: `reject:${paymentId}` },
      ]],
    },
  });
}

bot.start(async (ctx) => {
  await ctx.reply(
    '🛡️ *RAKSHAK SECURITY PLAN*\n\nApna plan select karein:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔰 Basic Shield (₹49)', callback_data: 'plan:49' }],
          [{ text: '🛡️ Pro Armor (₹599)', callback_data: 'plan:599' }],
          [{ text: '⚡ Elite Master Node (₹999)', callback_data: 'plan:999' }],
        ],
      },
    },
  );
});

bot.action(/^plan:(49|599|999)$/, async (ctx) => {
  const plan = ctx.match[1];
  const chatId = String(ctx.chat.id);
  await setUser(chatId, { selectedPlan: plan, updatedAt: new Date().toISOString() });
  await ctx.answerCbQuery(`₹${plan} selected`);

  const backupText = BACKUP_UPIS.length
    ? BACKUP_UPIS.map((upi, i) => `🔄 Backup UPI ${i + 1}:\n\`${upi}\``).join('\n\n') + '\n\n'
    : '';

  await ctx.reply(
    `💳 *RAKSHAK PAYMENT DETAILS*\n\n📦 Plan: *₹${plan}*\n\n⭐ Primary UPI:\n\`${PRIMARY_UPI}\`\n\n${backupText}👤 Name: *${escapeMd(PAYMENT_NAME)}*\n\nPayment complete hone ke baad *12-digit UTR* yahin bhejein.`,
    { parse_mode: 'Markdown' },
  );
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const cleanText = text.replace(/\s/g, '');
  if (!/^\d{12}$/.test(cleanText)) {
    return ctx.reply('⚠️ Please 12-digit UTR bhejein. Pehle /start se plan select karein.');
  }

  const chatId = String(ctx.chat.id);
  const user = await getUser(chatId);
  const plan = String(user.selectedPlan || '');

  if (!PLANS.has(plan)) {
    return ctx.reply('⚠️ Pehle /start dabakar apna plan select karein.');
  }

  // UTR is globally unique in this bot. A duplicate is rejected and never creates another payment request.
  const utrKey = `utr:${cleanText}`;
  const existingUtr = await getJson(utrKey, 'strong');
  if (existingUtr) {
    return ctx.reply('⚠️ Ye UTR already submit ho chuka hai. Duplicate UTR accept nahi kiya jayega.');
  }

  const paymentId = newPaymentId();
  const payment = {
    id: paymentId,
    userId: chatId,
    plan,
    utr: cleanText,
    status: 'pending',
    code: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Reserve UTR before notifying admin. onlyIfNew prevents concurrent duplicate submissions.
  try {
    await setJson(utrKey, { paymentId, userId: chatId, plan, createdAt: payment.createdAt }, { onlyIfNew: true });
    await setJson(paymentKey(paymentId), payment, { onlyIfNew: true });
  } catch (err) {
    return ctx.reply('⚠️ UTR already process mein hai. Please wait for admin verification.');
  }

  try {
    await notifyAdmin(
      `🚨 *NEW PAYMENT RECEIVED*\n\n👤 User ID:\n\`${chatId}\`\n📦 Plan: *₹${plan}*\n🔢 UTR:\n\`${cleanText}\`\n🆔 Payment ID:\n\`${paymentId}\`\n\nPayment verify karein.`,
      paymentId,
    );
    return ctx.reply('✅ *UTR Received!*\n\nAdmin payment verify kar raha hai. Approval ke baad activation code isi chat me milega.', { parse_mode: 'Markdown' });
  } catch (err) {
    // Keep the payment pending so it can be recovered instead of allowing the UTR to be reused.
    console.error('Admin notification failed:', err);
    return ctx.reply('⚠️ UTR save ho gaya hai, lekin admin notification me temporary error aaya. Please admin se contact karein.');
  }
});

bot.action(/^approve:(.+)$/, async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('❌ Unauthorized');

  const paymentId = ctx.match[1];
  const payment = await getJson(paymentKey(paymentId), 'strong');
  if (!payment) return ctx.answerCbQuery('Payment record not found.');

  if (payment.status === 'approved' && payment.code) {
    await ctx.answerCbQuery('Already approved');
    return ctx.reply(`ℹ️ Already assigned: \`${payment.code}\``, { parse_mode: 'Markdown' });
  }
  if (payment.status === 'rejected') return ctx.answerCbQuery('Already rejected');

  const available = await countAvailable(payment.plan);
  if (available === 0) {
    await ctx.answerCbQuery('Codes exhausted');
    return bot.telegram.sendMessage(ADMIN_ID, `⚠️ ₹${payment.plan} plan ke saare license codes already assigned hain.`);
  }

  const assignment = await findAvailableAndClaim(payment.plan, paymentId, payment.userId);
  if (!assignment) {
    await ctx.answerCbQuery('Code was claimed by another approval');
    return bot.telegram.sendMessage(ADMIN_ID, `⚠️ ₹${payment.plan} plan ka code concurrent approval me claim ho gaya. Payment ${paymentId} check karein.`);
  }

  const approved = { ...payment, status: 'approved', code: assignment.code, updatedAt: new Date().toISOString() };
  await setJson(paymentKey(paymentId), approved);

  try {
    await bot.telegram.sendMessage(
      payment.userId,
      `🎉 *PAYMENT VERIFIED!*\n\n🛡️ Your Activation Code:\n\`${assignment.code}\`\n\nApp mein enter karein.`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    console.error('User notification failed:', err);
    await bot.telegram.sendMessage(ADMIN_ID, `⚠️ Code ${assignment.code} securely assigned to user ${payment.userId}, but Telegram delivery failed. Do NOT approve this payment again; resend the already-assigned code manually.`);
  }

  await ctx.answerCbQuery('Code assigned permanently');
  try {
    await ctx.editMessageText(`✅ *Payment Approved*\n\nPlan: ₹${payment.plan}\nCode: \`${assignment.code}\`\nUser: \`${payment.userId}\``, { parse_mode: 'Markdown' });
  } catch (_) {}
});

bot.action(/^reject:(.+)$/, async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_ID) return ctx.answerCbQuery('❌ Unauthorized');

  const paymentId = ctx.match[1];
  const payment = await getJson(paymentKey(paymentId), 'strong');
  if (!payment) return ctx.answerCbQuery('Payment record not found.');
  if (payment.status === 'approved') return ctx.answerCbQuery('Already approved');
  if (payment.status === 'rejected') return ctx.answerCbQuery('Already rejected');

  const rejected = { ...payment, status: 'rejected', updatedAt: new Date().toISOString() };
  await setJson(paymentKey(paymentId), rejected);

  try {
    await bot.telegram.sendMessage(payment.userId, '❌ *Payment Verification Failed*\n\nSahi UTR/payment proof admin se verify karayein.', { parse_mode: 'Markdown' });
  } catch (_) {}

  await ctx.answerCbQuery('Payment rejected');
  try { await ctx.editMessageText('❌ *Payment Rejected*', { parse_mode: 'Markdown' }); } catch (_) {}
});

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'Rakshak Bot is running.' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  if (WEBHOOK_SECRET) {
    const supplied = event.headers?.['x-telegram-bot-api-secret-token'] || event.headers?.['X-Telegram-Bot-Api-Secret-Token'];
    if (supplied !== WEBHOOK_SECRET) return { statusCode: 401, body: 'Unauthorized' };
  }

  try {
    await initializeLicensePool();
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    await bot.handleUpdate(body);
    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('Webhook error:', err);
    return { statusCode: 500, body: 'Internal Server Error' };
  }
};
