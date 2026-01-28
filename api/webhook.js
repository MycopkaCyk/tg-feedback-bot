import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";

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

/** Настраиваемые тексты (позже просто меняй тут) */
const TEXT = {
  greeting:
    "Привет! Я помогу быстро отправить обратную связь по приложению.\n\nВыбери действие:",
  gratitudeReply:
    "Спасибо! Мне очень приятно 🙂\nЕсли захочешь — можешь также оставить отзыв или идею через меню.",
  reviewHowTo:
    "Оставь отзыв одним сообщением.\n\nКак написать конструктивно:\n1) Контекст: где/когда использовал\n2) Что понравилось/не понравилось\n3) Конкретный пример\n4) Что улучшить (если есть)\n\nНапиши текст сейчас:",
  bugHowTo:
    "Опиши ошибку одним сообщением.\n\nШаблон:\n1) Где: экран/раздел\n2) Шаги: 1…2…3…\n3) Ожидал: …\n4) Получил: …\n5) Устройство/ОС (если знаешь)\n\nНапиши текст сейчас:",
  ideaHowTo:
    "Опиши идею одним сообщением.\n\nШаблон:\n1) Проблема: что неудобно сейчас\n2) Идея: что предлагаешь\n3) Польза: зачем это пользователю\n4) Пример: как должно работать\n\nНапиши текст сейчас:",
  askUsefulness: "Оцени полезность приложения по шкале 1–5:",
  askUsability: "Оцени удобство приложения по шкале 1–5:",
  saved: "Готово, сохранил. Спасибо!",
  closed: "Ок. Если нужно снова — нажми /start",
  saveError: (code) =>
    `Ошибка сохранения (код: ${code ?? "unknown"}). Попробуйте ещё раз позже.`,
  typingPlaceholder: "Печатает…",
};

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
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ В меню", "nav:MENU")],
  ]);
}

function kbAfterSaved() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Отправить ещё", "nav:MENU")],
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

/** Пауза (для эффекта “плавности”) */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * “Печатает…”:
 * 1) sendChatAction typing
 * 2) отправить временное сообщение
 * 3) подождать
 * 4) удалить временное
 * 5) отправить итоговое
 */
async function sendTypingThen(ctx, finalText, extra = undefined, delayMs = 700) {
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

/** /start */
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  resetToMenu(userId);
  await sendTypingThen(ctx, TEXT.greeting, kbMenu());
});

/** Навигация */
bot.action(/^nav:(MENU|CLOSE)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  if (ctx.match[1] === "MENU") {
    resetToMenu(userId);
    await sendTypingThen(ctx, TEXT.greeting, kbMenu());
    return;
  }

  resetToMenu(userId);
  await sendTypingThen(ctx, TEXT.closed, { reply_markup: { inline_keyboard: [] } });
});

/** Меню: выбор действия */
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
    await sendTypingThen(ctx, TEXT.reviewHowTo, kbBackToMenu());
    return;
  }

  if (choice === "BUG") {
    setState(userId, { step: "WAIT_TEXT", topic: "BUG", comment: null, usefulness: null });
    await sendTypingThen(ctx, TEXT.bugHowTo, kbBackToMenu());
    return;
  }

  if (choice === "IDEA") {
    setState(userId, { step: "WAIT_TEXT", topic: "IDEA", comment: null, usefulness: null });
    await sendTypingThen(ctx, TEXT.ideaHowTo, kbBackToMenu());
    return;
  }
});

/** Пользователь пишет текст (отзыв/ошибка/идея) */
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const st = state.get(userId);

  if (!st || st.step !== "WAIT_TEXT") return;

  const comment = ctx.message.text.trim();
  if (!comment) return;

  setState(userId, { step: "WAIT_USEFULNESS", comment });

  await sendTypingThen(ctx, TEXT.askUsefulness, kbRating("useful"));
});

/** Оценка полезности */
bot.action(/^useful:(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId);
  if (!st || st.step !== "WAIT_USEFULNESS") return;

  const val = Number(ctx.match[1]);

  setState(userId, { step: "WAIT_USABILITY", usefulness: val });

  await sendTypingThen(ctx, TEXT.askUsability, kbRating("usable"));
});

/** Оценка удобства + сохранение */
bot.action(/^usable:(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId);
  if (!st || st.step !== "WAIT_USABILITY") return;

  const usability = Number(ctx.match[1]);

  // защита от пустых данных
  if (!st.topic || !st.comment || !st.usefulness) {
    resetToMenu(userId);
    await sendTypingThen(ctx, TEXT.greeting, kbMenu());
    return;
  }

  const payload = {
    tg_user_id: userId,
    tg_username: ctx.from.username ?? null,
    category: st.topic,              // REVIEW / BUG / IDEA
    comment: st.comment,
    rating_usefulness: st.usefulness,
    rating_usability: usability,
  };

  // ВАЖНО: твоя таблица называется mYfeedbek (с регистром)
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
  resetToMenu(userId);
  await sendTypingThen(ctx, TEXT.saved, kbAfterSaved());
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
