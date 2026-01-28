import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";

const bot = new Telegraf(process.env.BOT_TOKEN);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// MVP state in memory
const state = new Map();
/**
 * userId -> {
 *   step: "MENU" | "WAIT_TEXT" | "WAIT_USEFULNESS" | "WAIT_USABILITY",
 *   topic: "REVIEW" | "BUG" | "IDEA" | null,
 *   comment: string|null,
 *   usefulness: number|null
 * }
 */

const TEXT = {
  greeting:
    "Привет! Я помогу быстро отправить обратную связь по приложению.\n\nВыбери действие:",
  gratitudeReply:
    "Спасибо! Мне очень приятно.\nЕсли захочешь — можешь оставить отзыв, баг или идею через меню.",

  // Инструкции (их потом заменишь на свои)
  reviewHowTo:
    "Оставь отзыв одним сообщением.\n\nКак написать конструктивно:\n1) Контекст\n2) Что понравилось/не понравилось\n3) Пример\n4) Что улучшить\n",
  bugHowTo:
    "Опиши ошибку одним сообщением.\n\nШаблон:\n1) Где\n2) Шаги\n3) Ожидал\n4) Получил\n5) Устройство/ОС\n",
  ideaHowTo:
    "Опиши идею одним сообщением.\n\nШаблон:\n1) Проблема\n2) Идея\n3) Польза\n4) Пример\n",

  askWriteNow: "Напиши текст сейчас:",
  askUsefulness: "Оцени полезность приложения по шкале 1–5:",
  askUsability: "Оцени удобство приложения по шкале 1–5:",
  saved: "Готово, сохранил. Спасибо!",
  closed: "Ок. Если нужно снова — нажми /start",
  saveError: (code) =>
    `Ошибка сохранения (код: ${code ?? "unknown"}). Попробуйте ещё раз позже.`,
  typingPlaceholder: "Печатает…",
};

const DIRECTIONS = [
  { label: "🙏 Выразить благодарность", code: "THANKS" },
  { label: "📝 Оставить отзыв", code: "REVIEW" },
  { label: "🐞 Нашли ошибку", code: "BUG" },
  { label: "💡 Предложить идею", code: "IDEA" },
];

function kbMenu() {
  return Markup.inlineKeyboard(
    DIRECTIONS.map((d) => [Markup.button.callback(d.label, `menu:${d.code}`)])
  );
}

function kbBackToMenu() {
  return Markup.inlineKeyboard([[Markup.button.callback("⬅️ В меню", "nav:MENU")]]);
}

function kbAfterSaved() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Отправить ещё", "nav:MENU")],
    [Markup.button.callback("✅ Закрыть", "nav:CLOSE")],
  ]);
}

function kbRating(prefix) {
  return Markup.inlineKeyboard([
    [1, 2, 3, 4, 5].map((n) => Markup.button.callback(`⭐ ${n}`, `${prefix}:${n}`)),
  ]);
}

/**
 * Чипсы выбора формата сообщения.
 * Они не “вставляют” текст в поле ввода (Telegram так не умеет),
 * но дают пользователю шаблон/ориентир и затем просят написать текст.
 */
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
  // 1: выбор темы, 2: сообщение, 3: полезность, 4: удобство
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

/** Динамическая задержка “typing” по длине текста */
function calcDelayMs(text) {
  // 12 мс на символ, но в пределах 500..1300
  const ms = Math.round(text.length * 12);
  return Math.max(500, Math.min(1300, ms));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** Чипсы: выдаём подсказку/шаблон и просим написать текст */
bot.action(/^chip:(REVIEW|BUG|IDEA):(SHORT|TEMPLATE|DETAILED)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId) || {};
  const topic = ctx.match[1];
  const mode = ctx.match[2];

  // гарантируем, что пользователь действительно в нужном шаге
  if (!st || st.step !== "WAIT_TEXT" || st.topic !== topic) {
    resetToMenu(userId);
    await sendTypingThen(ctx, progress("MENU") + TEXT.greeting, kbMenu());
    return;
  }

  let guide = "";
  if (topic === "REVIEW") guide = TEXT.reviewHowTo;
  if (topic === "BUG") guide = TEXT.bugHowTo;
  if (topic === "IDEA") guide = TEXT.ideaHowTo;

  // Формируем подсказку по выбранному режиму
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

  await sendTypingThen(ctx, progress("WAIT_USEFULNESS") + TEXT.askUsefulness, kbRating("useful"));
});

/** Полезность */
bot.action(/^useful:(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId);
  if (!st || st.step !== "WAIT_USEFULNESS") return;

  const val = Number(ctx.match[1]);

  setState(userId, { step: "WAIT_USABILITY", usefulness: val });

  await sendTypingThen(ctx, progress("WAIT_USABILITY") + TEXT.askUsability, kbRating("usable"));
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
