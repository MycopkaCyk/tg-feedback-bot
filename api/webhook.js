// api/webhook.js (ПОЛНАЯ рабочая версия)
// Функции: меню -> текст -> 2 оценки -> сохранение -> финальная отбивка
// + follow-up при avg<=3 (4.1)
// + контакт по желанию (5.1): Telegram / Email / Не нужно
// Таблица: public."mYfeedbek"

import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import { TEXT, FINAL, TOPIC_LABEL } from "../texts.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const state = new Map();
/**
 * userId -> {
 *   step: "MENU" | "WAIT_TEXT" | "WAIT_USEFULNESS" | "WAIT_USABILITY" | "WAIT_FOLLOWUP" | "WAIT_EMAIL",
 *   topic: "REVIEW" | "BUG" | "IDEA" | null,
 *   comment: string|null,
 *   usefulness: number|null,
 *   lastFeedbackId: string|null
 * }
 */

/* ---------- UI ---------- */

function kbMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🙏 Выразить благодарность", "menu:THANKS")],
    [Markup.button.callback("📝 Оставить отзыв", "menu:REVIEW")],
    [Markup.button.callback("🐞 Нашли ошибку", "menu:BUG")],
    [Markup.button.callback("💡 Предложить идею", "menu:IDEA")],
  ]);
}

function kbBackToMenu() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ В меню", "nav:MENU")]]);
}

function kbAfterSavedBase() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Отправить ещё", "nav:MENU")],
    [Markup.button.callback("✅ Закрыть", "nav:CLOSE")],
  ]);
}

function kbFollowupChoice() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🛠 Уточнить, что не так", "fu:yes")],
    [Markup.button.callback("Нет, спасибо", "fu:no")],
  ]);
}

function kbContactChoice() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📨 Telegram", "ct:TG")],
    [Markup.button.callback("📧 Email", "ct:EMAIL")],
    [Markup.button.callback("❌ Не нужно", "ct:NONE")],
  ]);
}

function kbRating(prefix) {
  return Markup.inlineKeyboard([
    [1, 2, 3, 4, 5].map((n) => Markup.button.callback(`⭐ ${n}`, `${prefix}:${n}`)),
  ]);
}

function kbChips(topic) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✍️ Коротко", `chip:${topic}:SHORT`),
      Markup.button.callback("🧩 По шаблону", `chip:${topic}:TEMPLATE`),
      Markup.button.callback("📝 Подробно", `chip:${topic}:DETAILED`),
    ],
    [Markup.button.callback("⬅️ В меню", "nav:MENU")],
  ]);
}

/* ---------- Helpers ---------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calcDelayMs(text) {
  const ms = Math.round(String(text ?? "").length * 12);
  return Math.max(500, Math.min(1300, ms));
}

async function sendTypingThen(ctx, finalText, extra = undefined) {
  const safeTyping = TEXT?.typing ?? "Печатает…";
  const safeText = String(finalText ?? "");

  try {
    await ctx.telegram.sendChatAction(ctx.chat.id, "typing");
  } catch {}

  let tempMsgId = null;
  try {
    const temp = await ctx.reply(safeTyping);
    tempMsgId = temp.message_id;
  } catch {}

  await sleep(calcDelayMs(safeText));

  if (tempMsgId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, tempMsgId);
    } catch {}
  }

  return ctx.reply(safeText, extra);
}

function setState(userId, patch) {
  const prev = state.get(userId) || {
    step: "MENU",
    topic: null,
    comment: null,
    usefulness: null,
    lastFeedbackId: null,
  };
  state.set(userId, { ...prev, ...patch });
}

function resetToMenu(userId) {
  setState(userId, {
    step: "MENU",
    topic: null,
    comment: null,
    usefulness: null,
    lastFeedbackId: null,
  });
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function scoreAvg(usefulness, usability) {
  return (usefulness + usability) / 2;
}

function scoreBucket(usefulness, usability) {
  const avg = scoreAvg(usefulness, usability);
  if (avg >= 4) return "high";
  if (avg >= 3) return "mid";
  return "low";
}

function buildFinalMessage(topic, comment, usefulness, usability) {
  const label = TOPIC_LABEL?.[topic] ?? "Обратная связь";

  const header =
    topic === "BUG"
      ? `🐞 ${label} зафиксирована.`
      : topic === "IDEA"
      ? `💡 ${label} зафиксирована.`
      : `✅ ${label} зафиксирован(а).`;

  const ratings = `⭐ Полезность: ${usefulness}/5\n⭐ Удобство: ${usability}/5`;

  const bucket = scoreBucket(usefulness, usability);
  const pool =
    bucket === "high" ? FINAL?.high : bucket === "mid" ? FINAL?.mid : FINAL?.low;

  const tail =
    Array.isArray(pool) && pool.length ? pickRandom(pool) : "Спасибо за обратную связь.";

  const short =
    comment && String(comment).trim().length
      ? `\n\n📝 Сообщение:\n${String(comment).slice(0, 600)}${
          String(comment).length > 600 ? "…" : ""
        }`
      : "";

  return `${header}\n\n${ratings}\n\n${tail}${short}`;
}

function isLikelyEmail(text) {
  const s = String(text || "").trim();
  if (s.length < 6 || s.length > 254) return false;
  // простой и устойчивый regex
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

/* ---------- Flow ---------- */

bot.start(async (ctx) => {
  resetToMenu(ctx.from.id);
  await sendTypingThen(ctx, TEXT.greeting, kbMenu());
});

bot.action(/^nav:(MENU|CLOSE)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  if (ctx.match[1] === "MENU") {
    resetToMenu(userId);
    await sendTypingThen(ctx, TEXT.greeting, kbMenu());
    return;
  }

  resetToMenu(userId);
  await sendTypingThen(ctx, TEXT.close, { reply_markup: { inline_keyboard: [] } });
});

bot.action(/^menu:(THANKS|REVIEW|BUG|IDEA)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const choice = ctx.match[1];

  if (choice === "THANKS") {
    resetToMenu(userId);
    await sendTypingThen(ctx, TEXT.gratitudeReply, kbBackToMenu());
    return;
  }

  if (choice === "REVIEW") {
    setState(userId, { step: "WAIT_TEXT", topic: "REVIEW", comment: null, usefulness: null });
    await sendTypingThen(ctx, TEXT.reviewIntro, kbChips("REVIEW"));
    return;
  }

  if (choice === "BUG") {
    setState(userId, { step: "WAIT_TEXT", topic: "BUG", comment: null, usefulness: null });
    await sendTypingThen(ctx, TEXT.bugIntro, kbChips("BUG"));
    return;
  }

  if (choice === "IDEA") {
    setState(userId, { step: "WAIT_TEXT", topic: "IDEA", comment: null, usefulness: null });
    await sendTypingThen(ctx, TEXT.ideaIntro, kbChips("IDEA"));
    return;
  }
});

bot.action(/^chip:(REVIEW|BUG|IDEA):(SHORT|TEMPLATE|DETAILED)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId);

  const topic = ctx.match[1];
  const mode = ctx.match[2];

  if (!st || st.step !== "WAIT_TEXT" || st.topic !== topic) {
    resetToMenu(userId);
    await sendTypingThen(ctx, TEXT.greeting, kbMenu());
    return;
  }

  let guide = "";

  if (topic === "REVIEW") {
    guide =
      mode === "SHORT"
        ? TEXT.reviewShort
        : mode === "DETAILED"
        ? TEXT.reviewDetailed
        : TEXT.reviewTemplate;
  } else if (topic === "BUG") {
    guide = TEXT.bugTemplate;
  } else if (topic === "IDEA") {
    guide = TEXT.ideaTemplate;
  }

  await sendTypingThen(ctx, `${guide}\n\n${TEXT.askWrite}`, kbBackToMenu());
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const st = state.get(userId);

  // 1) Email ожидание
  if (st && st.step === "WAIT_EMAIL" && st.lastFeedbackId) {
    const email = ctx.message.text.trim();

    if (!isLikelyEmail(email)) {
      await sendTypingThen(
        ctx,
        "Похоже, это не email. Пример: name@example.com\n\nПопробуй ещё раз или нажми «В меню».",
        kbBackToMenu()
      );
      return;
    }

    const { error } = await supabase
      .from("mYfeedbek")
      .update({ contact_type: "EMAIL", contact_value: email })
      .eq("id", st.lastFeedbackId);

    if (error) {
      console.error("SUPABASE CONTACT EMAIL UPDATE ERROR:", error);
      await sendTypingThen(ctx, `Ошибка сохранения (код: ${error.code ?? "unknown"}).`, kbBackToMenu());
      return;
    }

    // После email — завершаем
    resetToMenu(userId);
    await sendTypingThen(ctx, "Спасибо! Контакт сохранён. Мы можем ответить при необходимости.", kbAfterSavedBase());
    return;
  }

  // 2) Follow-up ожидание
  if (st && st.step === "WAIT_FOLLOWUP" && st.lastFeedbackId) {
    const follow = ctx.message.text.trim();
    if (!follow) return;

    const { error } = await supabase
      .from("mYfeedbek")
      .update({ followup_comment: follow })
      .eq("id", st.lastFeedbackId);

    if (error) {
      console.error("SUPABASE FOLLOWUP UPDATE ERROR:", error);
      await sendTypingThen(ctx, `Ошибка сохранения (код: ${error.code ?? "unknown"}).`, kbBackToMenu());
      return;
    }

    // После follow-up — предлагаем контакт
    setState(userId, { step: "MENU" });
    await sendTypingThen(ctx, "Спасибо! Уточнение добавлено.\n\nОставить контакт для ответа?", kbContactChoice());
    return;
  }

  // 3) Основной текст
  if (!st || st.step !== "WAIT_TEXT" || !st.topic) return;

  const comment = ctx.message.text.trim();
  if (!comment) return;

  setState(userId, { step: "WAIT_USEFULNESS", comment });

  await sendTypingThen(ctx, TEXT.askUsefulness, kbRating("useful"));
});

bot.action(/^useful:(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId);
  if (!st || st.step !== "WAIT_USEFULNESS") return;

  const val = Number(ctx.match[1]);

  setState(userId, { step: "WAIT_USABILITY", usefulness: val });

  await sendTypingThen(ctx, TEXT.askUsability, kbRating("usable"));
});

bot.action(/^usable:(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId);
  if (!st || st.step !== "WAIT_USABILITY") return;

  const usability = Number(ctx.match[1]);

  if (!st.topic || !st.comment || !st.usefulness) {
    resetToMenu(userId);
    await sendTypingThen(ctx, TEXT.greeting, kbMenu());
    return;
  }

  const payload = {
    tg_user_id: userId,
    tg_username: ctx.from.username ?? null,
    category: st.topic,
    comment: st.comment,
    rating_usefulness: st.usefulness,
    rating_usability: usability,
  };

  const { data, error } = await supabase
    .from("mYfeedbek")
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error("SUPABASE INSERT ERROR:", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
    await sendTypingThen(ctx, `Ошибка сохранения (код: ${error.code ?? "unknown"}).`, kbBackToMenu());
    return;
  }

  const feedbackId = data?.id ?? null;
  setState(userId, { lastFeedbackId: feedbackId });

  const msg = buildFinalMessage(st.topic, st.comment, st.usefulness, usability);
  const avg = scoreAvg(st.usefulness, usability);

  // 1) Показываем финальную отбивку
  await sendTypingThen(ctx, msg, { reply_markup: { inline_keyboard: [] } });

  // 2) Если низко/средне — предлагаем уточнение, потом контакт
  if (avg <= 3) {
    setState(userId, { step: "MENU" });
    await sendTypingThen(
      ctx,
      "Если хочешь — уточни в одном сообщении, что именно было не так. Это поможет улучшить быстрее.",
      kbFollowupChoice()
    );
    return;
  }

  // 3) Если 4–5 — сразу спрашиваем контакт (по желанию)
  setState(userId, { step: "MENU" });
  await sendTypingThen(ctx, "Оставить контакт для ответа (по желанию)?", kbContactChoice());
});

bot.action(/^fu:(yes|no)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId);

  if (!st || !st.lastFeedbackId) {
    resetToMenu(userId);
    await sendTypingThen(ctx, TEXT.greeting, kbMenu());
    return;
  }

  if (ctx.match[1] === "no") {
    // Если не хочет уточнять — спрашиваем контакт
    setState(userId, { step: "MENU" });
    await sendTypingThen(ctx, "Оставить контакт для ответа (по желанию)?", kbContactChoice());
    return;
  }

  setState(userId, { step: "WAIT_FOLLOWUP" });
  await sendTypingThen(
    ctx,
    "Напиши уточнение одним сообщением (что именно было не так / что улучшить):",
    kbBackToMenu()
  );
});

bot.action(/^ct:(TG|EMAIL|NONE)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId);

  if (!st || !st.lastFeedbackId) {
    resetToMenu(userId);
    await sendTypingThen(ctx, TEXT.greeting, kbMenu());
    return;
  }

  const choice = ctx.match[1];

  if (choice === "NONE") {
    resetToMenu(userId);
    await sendTypingThen(ctx, "Принято. Спасибо!", kbAfterSavedBase());
    return;
  }

  if (choice === "TG") {
    const username = ctx.from.username ? `@${ctx.from.username}` : null;

    const { error } = await supabase
      .from("mYfeedbek")
      .update({
        contact_type: "TG",
        contact_value: username ?? String(userId),
      })
      .eq("id", st.lastFeedbackId);

    if (error) {
      console.error("SUPABASE CONTACT TG UPDATE ERROR:", error);
      await sendTypingThen(ctx, `Ошибка сохранения (код: ${error.code ?? "unknown"}).`, kbBackToMenu());
      return;
    }

    resetToMenu(userId);
    await sendTypingThen(
      ctx,
      username
        ? `Контакт сохранён: ${username}\nСпасибо!`
        : "Контакт сохранён. Спасибо!",
      kbAfterSavedBase()
    );
    return;
  }

  // EMAIL
  setState(userId, { step: "WAIT_EMAIL" });
  await sendTypingThen(
    ctx,
    "Напиши email одним сообщением (пример: name@example.com).",
    kbBackToMenu()
  );
});

/* ---------- Vercel handler ---------- */

export default async function handler(req, res) {
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).send("unauthorized");
    return;
  }

  if (req.method !== "POST") {
    res.status(200).send("ok");
    return;
  }

  try {
    await bot.handleUpdate(req.body);
  } catch (e) {
    console.error("BOT HANDLE UPDATE ERROR:", e);
  }

  res.status(200).send("ok");
}
