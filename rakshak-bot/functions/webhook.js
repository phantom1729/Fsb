const { Telegraf, Markup } = require("telegraf");
const { getStore } = require("@netlify/blobs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || "");

const PRIMARY_UPI = process.env.PRIMARY_UPI;
const BACKUP_UPI_1 = process.env.BACKUP_UPI_1;
const BACKUP_UPI_2 = process.env.BACKUP_UPI_2;
const PAYMENT_NAME = process.env.PAYMENT_NAME;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!ADMIN_ID) throw new Error("ADMIN_ID is missing");

const bot = new Telegraf(BOT_TOKEN);

// Netlify Blobs
const blobsOptions =
  process.env.BLOBS_TOKEN && (process.env.SITE_ID || process.env.NETLIFY_SITE_ID)
    ? {
        token: process.env.BLOBS_TOKEN,
        siteID: process.env.SITE_ID || process.env.NETLIFY_SITE_ID,
      }
    : undefined;

const store = blobsOptions
  ? getStore("rakshak-bot", blobsOptions)
  : getStore("rakshak-bot");

// --------------------------------------------------
// LICENSE POOLS
// --------------------------------------------------

const LICENSES = {
  "49": Array.from(
    { length: 10 },
    (_, i) => `RAKSHAK-PRO-0${i}`
  ),

  "599": Array.from(
    { length: 9 },
    (_, i) => `RAKSHAK-PRO-${(i + 1) * 111}`
  ),

  "999": Array.from(
    { length: 9 },
    (_, i) => `RAKSHAK-PRO-${(i + 1) * 1111}`
  ),
};

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

async function getJson(key, consistency = "eventual") {
  const result = await store.getWithMetadata(key, {
    type: "json",
    consistency,
  });

  if (!result || result.data == null) return null;

  return {
    data: result.data,
    etag: result.etag,
  };
}

async function setJson(key, value, options = {}) {
  return store.set(key, JSON.stringify(value), {
    ...options,
    contentType: "application/json",
  });
}

async function saveUser(chatId, data) {
  await setJson(`user:${chatId}`, data);
}

async function getUser(chatId) {
  const result = await getJson(`user:${chatId}`, "strong");
  return result ? result.data : null;
}

function isAdmin(ctx) {
  return String(ctx.from?.id) === ADMIN_ID;
}

// --------------------------------------------------
// CLAIM LICENSE SAFELY
// --------------------------------------------------

async function findAvailableAndClaim(plan) {
  const codes = LICENSES[plan];

  if (!codes) return null;

  for (const code of codes) {
    const key = `license:${plan}:${code}`;

    const current = await getJson(key, "strong");

    // License has never been assigned
    if (!current) {
      const result = await setJson(
        key,
        {
          code,
          plan,
          assigned: true,
          assignedAt: new Date().toISOString(),
        },
        {
          onlyIfNew: true,
        }
      );

      if (result?.modified !== false) {
        return code;
      }

      continue;
    }

    // License already assigned, try next
  }

  return null;
}

// --------------------------------------------------
// START
// --------------------------------------------------

bot.start(async (ctx) => {
  await ctx.reply(
    "🛡️ Welcome to Rakshak Bot\n\n" +
      "Choose your plan:",
    Markup.inlineKeyboard([
      [Markup.button.callback("₹49 Plan", "plan_49")],
      [Markup.button.callback("₹599 Plan", "plan_599")],
      [Markup.button.callback("₹999 Plan", "plan_999")],
    ])
  );
});

// --------------------------------------------------
// PLAN SELECTION
// --------------------------------------------------

async function showPayment(ctx, plan) {
  await ctx.answerCbQuery();

  const upiText =
    `💳 *Rakshak ${plan === "49" ? "₹49" : plan === "599" ? "₹599" : "₹999"} Plan*\n\n` +
    `Payment Name: *${PAYMENT_NAME}*\n\n` +
    `UPI IDs:\n` +
    `• ${PRIMARY_UPI}\n` +
    `• ${BACKUP_UPI_1}\n` +
    `• ${BACKUP_UPI_2}\n\n` +
    `Payment karne ke baad apna *12-digit UTR number* bhejo.`;

  await ctx.reply(
    upiText,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Back", "back_plans")],
      ]),
    }
  );

  await saveUser(ctx.chat.id, {
    chatId: ctx.chat.id,
    plan,
    state: "waiting_utr",
    updatedAt: new Date().toISOString(),
  });
}

bot.action("plan_49", (ctx) => showPayment(ctx, "49"));
bot.action("plan_599", (ctx) => showPayment(ctx, "599"));
bot.action("plan_999", (ctx) => showPayment(ctx, "999"));

bot.action("back_plans", async (ctx) => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "Choose your plan:",
    Markup.inlineKeyboard([
      [Markup.button.callback("₹49 Plan", "plan_49")],
      [Markup.button.callback("₹599 Plan", "plan_599")],
      [Markup.button.callback("₹999 Plan", "plan_999")],
    ])
  );
});

// --------------------------------------------------
// UTR SUBMISSION
// --------------------------------------------------

bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) return;

  const user = await getUser(ctx.chat.id);

  if (!user || user.state !== "waiting_utr") {
    return;
  }

  // Only 12 digit UTR
  if (!/^\d{12}$/.test(text)) {
    await ctx.reply(
      "❌ Invalid UTR.\n\nPlease send exactly 12 digits."
    );
    return;
  }

  const utr = text;

  // Prevent duplicate UTR
  const utrKey = `utr:${utr}`;
  const existingUTR = await getJson(utrKey, "strong");

  if (existingUTR) {
    await ctx.reply(
      "❌ This UTR has already been submitted."
    );
    return;
  }

  const paymentId =
    `${Date.now()}-${ctx.chat.id}`;

  const payment = {
    paymentId,
    chatId: ctx.chat.id,
    username: ctx.from.username || "",
    firstName: ctx.from.first_name || "",
    plan: user.plan,
    utr,
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  // Reserve UTR first
  const utrResult = await setJson(
    utrKey,
    payment,
    {
      onlyIfNew: true,
    }
  );

  if (utrResult?.modified === false) {
    await ctx.reply("❌ This UTR has already been submitted.");
    return;
  }

  await setJson(`payment:${paymentId}`, payment);

  await saveUser(ctx.chat.id, {
    ...user,
    state: "payment_pending",
    paymentId,
    updatedAt: new Date().toISOString(),
  });

  await ctx.reply(
    "✅ UTR received.\n\n" +
      "Your payment is now waiting for admin verification.\n" +
      "You will receive the activation code after approval."
  );

  // Admin notification
  await bot.telegram.sendMessage(
    ADMIN_ID,
    `🔔 *New Payment Request*\n\n` +
      `Payment ID: \`${paymentId}\`\n` +
      `User ID: \`${ctx.chat.id}\`\n` +
      `Username: @${ctx.from.username || "N/A"}\n` +
      `Plan: ₹${user.plan}\n` +
      `UTR: \`${utr}\``,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ APPROVE",
            `approve:${paymentId}`
          ),
          Markup.button.callback(
            "❌ REJECT",
            `reject:${paymentId}`
          ),
        ],
      ]),
    }
  );
});

// --------------------------------------------------
// ADMIN APPROVE
// --------------------------------------------------

bot.action(/^approve:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery("Unauthorized");
    return;
  }

  const paymentId = ctx.match[1];

  const paymentResult = await getJson(
    `payment:${paymentId}`,
    "strong"
  );

  if (!paymentResult) {
    await ctx.answerCbQuery("Payment not found");
    return;
  }

  const payment = paymentResult.data;

  if (payment.status !== "pending") {
    await ctx.answerCbQuery(
      `Already ${payment.status}`
    );
    return;
  }

  const code = await findAvailableAndClaim(payment.plan);

  if (!code) {
    await ctx.answerCbQuery("No license available");

    await ctx.reply(
      `⚠️ No unused license available for ₹${payment.plan}.`
    );

    return;
  }

  payment.status = "approved";
  payment.license = code;
  payment.approvedAt = new Date().toISOString();

  await setJson(
    `payment:${paymentId}`,
    payment
  );

  const user = await getUser(payment.chatId);

  if (user) {
    await saveUser(payment.chatId, {
      ...user,
      state: "activated",
      license: code,
      updatedAt: new Date().toISOString(),
    });
  }

  await bot.telegram.sendMessage(
    payment.chatId,
    `🎉 *Payment Approved!*\n\n` +
      `Your Rakshak activation code is:\n\n` +
      `\`${code}\`\n\n` +
      `Keep this code safe.`,
    {
      parse_mode: "Markdown",
    }
  );

  await ctx.editMessageText(
    `✅ *APPROVED*\n\n` +
      `Payment ID: \`${paymentId}\`\n` +
      `Plan: ₹${payment.plan}\n` +
      `UTR: \`${payment.utr}\`\n` +
      `License: \`${code}\``,
    {
      parse_mode: "Markdown",
    }
  );

  await ctx.answerCbQuery("Approved");
});

// --------------------------------------------------
// ADMIN REJECT
// --------------------------------------------------

bot.action(/^reject:(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    await ctx.answerCbQuery("Unauthorized");
    return;
  }

  const paymentId = ctx.match[1];

  const paymentResult = await getJson(
    `payment:${paymentId}`,
    "strong"
  );

  if (!paymentResult) {
    await ctx.answerCbQuery("Payment not found");
    return;
  }

  const payment = paymentResult.data;

  if (payment.status !== "pending") {
    await ctx.answerCbQuery(
      `Already ${payment.status}`
    );
    return;
  }

  payment.status = "rejected";
  payment.rejectedAt = new Date().toISOString();

  await setJson(
    `payment:${paymentId}`,
    payment
  );

  const user = await getUser(payment.chatId);

  if (user) {
    await saveUser(payment.chatId, {
      ...user,
      state: "rejected",
      updatedAt: new Date().toISOString(),
    });
  }

  await bot.telegram.sendMessage(
    payment.chatId,
    "❌ Your payment request was rejected by admin.\n\n" +
      "If you believe this is a mistake, please contact support."
  );

  await ctx.editMessageText(
    `❌ *REJECTED*\n\n` +
      `Payment ID: \`${paymentId}\`\n` +
      `Plan: ₹${payment.plan}\n` +
      `UTR: \`${payment.utr}\``,
    {
      parse_mode: "Markdown",
    }
  );

  await ctx.answerCbQuery("Rejected");
});

// --------------------------------------------------
// NETLIFY FUNCTION
// --------------------------------------------------

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "GET") {
      return {
        statusCode: 200,
        body: "Rakshak Bot is running.",
      };
    }

    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: "Method Not Allowed",
      };
    }

    // Optional Telegram secret validation
    if (WEBHOOK_SECRET) {
      const receivedSecret =
        event.headers?.["x-telegram-bot-api-secret-token"] ||
        event.headers?.["X-Telegram-Bot-Api-Secret-Token"];

      if (receivedSecret !== WEBHOOK_SECRET) {
        return {
          statusCode: 401,
          body: "Unauthorized",
        };
      }
    }

    const update = JSON.parse(event.body || "{}");

    await bot.handleUpdate(update);

    return {
      statusCode: 200,
      body: "OK",
    };
  } catch (error) {
    console.error("Webhook Error:", error);

    return {
      statusCode: 500,
      body: "Internal Server Error",
    };
  }
};
