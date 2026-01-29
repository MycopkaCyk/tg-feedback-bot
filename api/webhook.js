import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";
import { TEXT, FINAL, TOPIC_LABEL } from "../texts.js";


const bot = new Telegraf(process.env.BOT_TOKEN);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/**
 * State in memory (MVP). На Vercel может сбрасываться — позже перенесём в Supabase.
 * userId -> {
 *   step: "MENU" | "WAIT_TEXT" | "WAIT_USEFULNESS" | "WAIT_USABILITY",
 *   topic: "REVIEW" | "BUG" | "IDEA" | null,
 *   comment: string|null,
 *   usefulness: number|null
 * }
 */
const state = new Map();

/** Меню (inline) */
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

function kbAfterSaved() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Отправить повторно", "nav:MENU")],
    [Markup.button.callback("✅ Закрыть", "nav:CLOSE")],
  ]);
}

function kbRating(prefix) {
  return Markup.inlineKeyboard([
    [1, 2, 3, 4, 5].map((n) =>
      Markup.button.callback(`⭐ ${n}`, `${prefix}:${n}`)
    ),
  ]);
}

/** Чипсы выбора формата */
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

/** Прогресс */
function progress(step) {
  switch (step) {
    case "MENU":
      return "Шаг 1/4 — Выбор темы\n\n";
    case "WAIT_TEXT":
      return "Шаг 2/4 — Сообщение\n\n";
    case "WAIT_USEFULNESS":
      return "Шаг 3/4 — Оценка полезности\n\n";
    case "WAIT_USABILITY":
      return "Шаг 4/4 — Оценка удобства\n\n";
    default:
      return "";
  }
}

/** Динамическая задержка typing */
function calcDelayMs(text) {
  const ms = Math.round(text.length * 12);
  return Math.max(500, Math.min(1300, ms));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** typing + временное сообщение + удаление */
async function sendTypingThen(ctx, finalText, extra = undefined) {
  const delayMs = calcDelayMs(finalText);

  try {
    await ctx.telegram.sendChatAction(ctx.chat.id, "typing");
  } catch {}

  let tempMsgId = null;
  try {
    const temp = await ctx.reply(TEXT.typingPlaceholder);
    tempMsgId = temp.message_id;
  } catch {}

  await sleep(delayMs);

  if (tempMsgId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, tempMsgId);
    } catch {}
  }

  return ctx.reply(finalText, extra);
}

function setState(userId, patch) {
  const prev = state.get(userId) || {
    step: "MENU",
    topic: null,
    comment: null,
    usefulness: null,
  };
  state.set(userId, { ...prev, ...patch });
}

function resetToMenu(userId) {
  setState(userId, { step: "MENU", topic: null, comment: null, usefulness: null });
}

/** Финальная отбивка */
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function scoreBucket(usefulness, usability) {
  const avg = (usefulness + usability) / 2;
  if (avg >= 4) return "high";
  if (avg >= 3) return "mid";
  return "low";
}

function buildFinalMessage(topic, comment, usefulness, usability) {
  const label = TOPIC_LABEL[topic] ?? "Обратная связь";

  // Более человеческие формулировки по теме
  const header =
    topic === "BUG"
      ? `🐞 ${label} зафиксирована.`
      : topic === "IDEA"
      ? `💡 ${label} зафиксирована.`
      : `✅ ${label} зафиксирован(а).`;

  const ratings = `⭐ Полезность: ${usefulness}/5\n⭐ Удобство: ${usability}/5`;

  const bucket = scoreBucket(usefulness, usability);
  const tail =
    bucket === "high"
      ? pickRandom(FINAL.high)
      : bucket === "mid"
      ? pickRandom(FINAL.mid)
      : pickRandom(FINAL.low);

  const short =
    comment && comment.length > 0
      ? `\n\n📝 Сообщение:\n${comment.slice(0, 220)}${comment.length > 220 ? "…" : ""}`
      : "";

  return `${header}\n\n${ratings}\n\n${tail}${short}`;
}

/** /start */
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  resetToMenu(userId);
  await sendTypingThen(ctx, progress("MENU") + TEXT.greeting, kbMenu());
});

/** Навигация */
bot.action(/^nav:(MENU|CLOSE)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  if (ctx.match[1] === "MENU") {
    resetToMenu(userId);
    await sendTypingThen(ctx, progress("MENU") + TEXT.greeting, kbMenu());
    return;
  }

  resetToMenu(userId);
  await sendTypingThen(ctx, TEXT.closed, { reply_markup: { inline_keyboard: [] } });
});

/** Меню */
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
    await sendTypingThen(
      ctx,
      progress("WAIT_TEXT") + "Выбрано: Отзыв\n\nВыбери формат сообщения:",
      kbChips("REVIEW")
    );
    return;
  }

  if (choice === "BUG") {
    setState(userId, { step: "WAIT_TEXT", topic: "BUG", comment: null, usefulness: null });
    await sendTypingThen(
      ctx,
      progress("WAIT_TEXT") + "Выбрано: Ошибка\n\nВыбери формат сообщения:",
      kbChips("BUG")
    );
    return;
  }

  if (choice === "IDEA") {
    setState(userId, { step: "WAIT_TEXT", topic: "IDEA", comment: null, usefulness: null });
    await sendTypingThen(
      ctx,
      progress("WAIT_TEXT") + "Выбрано: Идея\n\nВыбери формат сообщения:",
      kbChips("IDEA")
    );
    return;
  }
});

/** Чипсы: подсказка + просим написать */
bot.action(/^chip:(REVIEW|BUG|IDEA):(SHORT|TEMPLATE|DETAILED)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId) || {};
  const topic = ctx.match[1];
  const mode = ctx.match[2];

  if (!st || st.step !== "WAIT_TEXT" || st.topic !== topic) {
    resetToMenu(userId);
    await sendTypingThen(ctx, progress("MENU") + TEXT.greeting, kbMenu());
    return;
  }

  let guide = "";
  if (topic === "REVIEW") guide = TEXT.reviewHowTo;
  if (topic === "BUG") guide = TEXT.bugHowTo;
  if (topic === "IDEA") guide = TEXT.ideaHowTo;

  let message = progress("WAIT_TEXT");
  message +=
    mode === "SHORT"
      ? "Формат: Коротко\n\nНапиши 2–4 предложения по сути.\n\n"
      : mode === "DETAILED"
      ? "Формат: Подробно\n\nОпиши максимально конкретно, с примерами.\n\n"
      : "Формат: По шаблону\n\nЗаполни пункты ниже:\n\n";

  message += guide + "\n" + TEXT.askWriteNow;

  await sendTypingThen(ctx, message, kbBackToMenu());
});

/** Пользователь пишет текст */
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const st = state.get(userId);

  if (!st || st.step !== "WAIT_TEXT" || !st.topic) return;

  const comment = ctx.message.text.trim();
  if (!comment) return;

  setState(userId, { step: "WAIT_USEFULNESS", comment });

  await sendTypingThen(
    ctx,
    progress("WAIT_USEFULNESS") + TEXT.askUsefulness,
    kbRating("useful")
  );
});

/** Полезность */
bot.action(/^useful:(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId);
  if (!st || st.step !== "WAIT_USEFULNESS") return;

  const val = Number(ctx.match[1]);

  setState(userId, { step: "WAIT_USABILITY", usefulness: val });

  await sendTypingThen(
    ctx,
    progress("WAIT_USABILITY") + TEXT.askUsability,
    kbRating("usable")
  );
});

/** Удобство + сохранение */
bot.action(/^usable:(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId);
  if (!st || st.step !== "WAIT_USABILITY") return;

  const usability = Number(ctx.match[1]);

  if (!st.topic || !st.comment || !st.usefulness) {
    resetToMenu(userId);
    await sendTypingThen(ctx, progress("MENU") + TEXT.greeting, kbMenu());
    return;
  }

  const payload = {
    tg_user_id: userId,
    tg_username: ctx.from.username ?? null,
    category: st.topic, // REVIEW/BUG/IDEA
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
    await sendTypingThen(ctx, TEXT.saveError(error.code), kbBackToMenu());
    return;
  }

  console.log("Saved feedback id:", data?.id);

  // Динамическая финальная отбивка
  const finalText = buildFinalMessage(st.topic, st.comment, st.usefulness, usability);

  resetToMenu(userId);
  await sendTypingThen(ctx, finalText, kbAfterSaved());
});

/** Vercel handler */
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
