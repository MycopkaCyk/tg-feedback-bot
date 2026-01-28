import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";

/**
 * ENV переменные в Vercel:
 * BOT_TOKEN
 * SUPABASE_URL
 * SUPABASE_SERVICE_ROLE_KEY
 * WEBHOOK_SECRET
 */

const bot = new Telegraf(process.env.BOT_TOKEN);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/**
 * MVP state in memory (на Vercel может иногда сбрасываться).
 * Структура на пользователя:
 * {
 *   step: "WAIT_DIRECTION" | "WAIT_COMMENT" | "WAIT_USEFULNESS" | "WAIT_USABILITY" | "DONE",
 *   direction: string|null,
 *   comment: string|null,
 *   usefulness: number|null,
 *   usability: number|null,
 *   lastMessageId: number|null
 * }
 */
const state = new Map();

const TEXT = {
  hello:
    "Привет! Я соберу обратную связь по приложению.\n\nВыберите, что хотите отправить:",
  askComment: "Напишите ваш комментарий одним сообщением:",
  askUsefulness: "Оцените полезность приложения по шкале 1–5:",
  askUsability: "Оцените удобство приложения по шкале 1–5:",
  saved: "Спасибо! Отзыв сохранён.",
  closed: "Диалог завершён. Чтобы оставить отзыв снова — /start",
  saveError: (code) =>
    `Ошибка сохранения (код: ${code ?? "unknown"}). Попробуйте ещё раз позже.`,
};

const DIRECTIONS = [
  { label: "🐞 Сообщить о ошибке", code: "BUG" },
  { label: "✨ Предложить идею", code: "FEATURE" },
  { label: "💬 Общий отзыв", code: "FEEDBACK" },
  { label: "❓ Вопрос/поддержка", code: "SUPPORT" },
];

function kbDirection() {
  return Markup.inlineKeyboard(
    DIRECTIONS.map((d) => [Markup.button.callback(d.label, `dir:${d.code}`)])
  );
}

function kbRating(prefix) {
  return Markup.inlineKeyboard([
    [1, 2, 3, 4, 5].map((n) =>
      Markup.button.callback(`⭐ ${n}`, `${prefix}:${n}`)
    ),
  ]);
}

function kbDone() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Оставить ещё", "done:again")],
    [Markup.button.callback("✅ Закрыть", "done:finish")],
  ]);
}

/**
 * Основной UX: 1 "главное" сообщение, которое редактируем.
 */
async function editOrSend(ctx, userId, text, extra) {
  const st = state.get(userId) || {};
  const chatId = ctx.chat?.id || ctx.update?.callback_query?.message?.chat?.id;

  if (st.lastMessageId && chatId) {
    try {
      await ctx.telegram.editMessageText(
        chatId,
        st.lastMessageId,
        undefined,
        text,
        extra
      );
      return;
    } catch {
      // если нельзя отредактировать — отправим новое
    }
  }

  const msg = await ctx.reply(text, extra);
  state.set(userId, { ...st, lastMessageId: msg.message_id });
}

function resetUser(userId) {
  const prev = state.get(userId) || {};
  state.set(userId, {
    step: "WAIT_DIRECTION",
    direction: null,
    comment: null,
    usefulness: null,
    usability: null,
    lastMessageId: prev.lastMessageId ?? null,
  });
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  resetUser(userId);
  await editOrSend(ctx, userId, TEXT.hello, kbDirection());
});

/**
 * Выбор направления
 */
bot.action(/^dir:(BUG|FEATURE|FEEDBACK|SUPPORT)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const dir = ctx.match[1];

  const st = state.get(userId) || {};
  state.set(userId, { ...st, step: "WAIT_COMMENT", direction: dir });

  await editOrSend(ctx, userId, TEXT.askComment, {
    reply_markup: { inline_keyboard: [] },
  });
});

/**
 * Пользователь пишет комментарий (текст)
 */
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const st = state.get(userId);

  if (!st || st.step !== "WAIT_COMMENT") return;

  const comment = ctx.message.text.trim();
  if (!comment) return;

  state.set(userId, { ...st, comment, step: "WAIT_USEFULNESS" });

  await editOrSend(ctx, userId, TEXT.askUsefulness, kbRating("useful"));
});

/**
 * Оценка полезности
 */
bot.action(/^useful:(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const val = Number(ctx.match[1]);

  const st = state.get(userId);
  if (!st || st.step !== "WAIT_USEFULNESS") return;

  state.set(userId, { ...st, usefulness: val, step: "WAIT_USABILITY" });

  await editOrSend(ctx, userId, TEXT.askUsability, kbRating("usable"));
});

/**
 * Оценка удобства + сохранение в Supabase
 */
bot.action(/^usable:(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const val = Number(ctx.match[1]);

  const st = state.get(userId);
  if (!st || st.step !== "WAIT_USABILITY") return;

  // защита от пустых данных
  if (!st.direction || !st.comment || !st.usefulness) {
    resetUser(userId);
    await editOrSend(ctx, userId, TEXT.hello, kbDirection());
    return;
  }

  const payload = {
    tg_user_id: userId,
    tg_username: ctx.from.username ?? null,
    category: st.direction, // в базе можно потом переименовать в direction
    comment: st.comment,
    rating_usefulness: st.usefulness,
    rating_usability: val,
  };

  const { data, error } = await supabase
    .from("feedback")
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

    await editOrSend(
      ctx,
      userId,
      TEXT.saveError(error.code),
      { reply_markup: { inline_keyboard: [] } }
    );
    return;
  }

  state.set(userId, { ...st, step: "DONE", usability: val });

  console.log("Saved feedback id:", data?.id);
  await editOrSend(ctx, userId, TEXT.saved, kbDone());
});

/**
 * Завершение или новый отзыв
 */
bot.action(/^done:(again|finish)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;

  if (ctx.match[1] === "again") {
    resetUser(userId);
    await editOrSend(ctx, userId, TEXT.hello, kbDirection());
    return;
  }

  const st = state.get(userId) || {};
  state.set(userId, { ...st, step: "DONE" });

  await editOrSend(ctx, userId, TEXT.closed, {
    reply_markup: { inline_keyboard: [] },
  });
});

/**
 * Vercel handler (webhook endpoint)
 */
export default async function handler(req, res) {
  // Telegram присылает секрет вот в этом заголовке (если setWebhook был с secret_token)
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
