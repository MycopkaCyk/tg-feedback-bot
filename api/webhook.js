import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";

const bot = new Telegraf(process.env.BOT_TOKEN);

// Supabase клиент
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Память состояния (MVP). На Vercel может сбрасываться — мы позже перенесём в Supabase.
const state = new Map(); // userId -> { step, rating, category, lastMessageId }

function kbRating() {
  return Markup.inlineKeyboard([
    [1, 2, 3, 4, 5].map((n) => Markup.button.callback(`⭐ ${n}`, `rate:${n}`))
  ]);
}

function kbCategory() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🎨 UI", "cat:UI"),
      Markup.button.callback("🐞 Баг", "cat:BUG")
    ],
    [
      Markup.button.callback("✨ Фича", "cat:FEATURE"),
      Markup.button.callback("⚡ Скорость", "cat:PERF")
    ],
    [Markup.button.callback("📌 Другое", "cat:OTHER")]
  ]);
}

function kbDone() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Оставить ещё", "done:again")],
    [Markup.button.callback("✅ Закрыть", "done:finish")]
  ]);
}

// Помощник: редактировать “главное” сообщение (один экран)
async function editOrSend(ctx, userId, text, extra) {
  const st = state.get(userId) || {};
  const chatId = ctx.chat?.id || ctx.update?.callback_query?.message?.chat?.id;

  // пробуем редактировать существующее “главное” сообщение
  if (st.lastMessageId && chatId) {
    try {
      await ctx.telegram.editMessageText(chatId, st.lastMessageId, undefined, text, extra);
      return;
    } catch (e) {
      // если не вышло (сообщение удалено/старое) — отправим новое
    }
  }

  const msg = await ctx.reply(text, extra);
  state.set(userId, { ...st, lastMessageId: msg.message_id });
}

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  state.set(userId, { step: "WAIT_RATING", rating: null, category: null, lastMessageId: state.get(userId)?.lastMessageId });
  await editOrSend(ctx, userId, "Оцените приложение по шкале 1–5:", kbRating());
});

bot.action(/^rate:(\d)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const rating = Number(ctx.match[1]);

  const st = state.get(userId) || {};
  state.set(userId, { ...st, step: "WAIT_CATEGORY", rating });

  await editOrSend(ctx, userId, "Выберите категорию обратной связи:", kbCategory());
});

bot.action(/^cat:(UI|BUG|FEATURE|PERF|OTHER)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const category = ctx.match[1];

  const st = state.get(userId) || {};
  state.set(userId, { ...st, step: "WAIT_COMMENT", category });

  await editOrSend(ctx, userId, "Напишите комментарий одним сообщением:", { reply_markup: { inline_keyboard: [] } });
});

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const st = state.get(userId);

  // если не на шаге комментария — игнор
  if (!st || st.step !== "WAIT_COMMENT") return;

  const comment = ctx.message.text.trim();
  if (!comment) return;

  // сохраняем в Supabase
  const { data, error } = await supabase
  .from("feedback")
  .insert({
    tg_user_id: userId,
    tg_username: ctx.from.username ?? null,
    rating: st.rating,
    category: st.category,
    comment
  })
  .select()
  .single();

if (error) {
  console.error("SUPABASE INSERT ERROR:", {
    message: error.message,
    details: error.details,
    hint: error.hint,
    code: error.code
  });

  await editOrSend(
    ctx,
    userId,
    `Ошибка сохранения (код: ${error.code ?? "unknown"}). Попробуйте ещё раз позже.`,
    { reply_markup: { inline_keyboard: [] } }
  );
  return;
}

console.log("Saved feedback id:", data?.id);

  // сбрасываем состояние на DONE
  state.set(userId, { ...st, step: "DONE", rating: null, category: null });

  await editOrSend(ctx, userId, "Спасибо! Обратная связь сохранена.", kbDone());
});

bot.action(/^done:(again|finish)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const st = state.get(userId) || {};

  if (ctx.match[1] === "again") {
    state.set(userId, { ...st, step: "WAIT_RATING", rating: null, category: null });
    await editOrSend(ctx, userId, "Оцените приложение по шкале 1–5:", kbRating());
    return;
  }

  state.set(userId, { ...st, step: "DONE", rating: null, category: null });
  await editOrSend(ctx, userId, "Диалог завершён. Чтобы оставить отзыв снова — /start", { reply_markup: { inline_keyboard: [] } });
});

// Vercel handler
export default async function handler(req, res) {
  // 1) проверяем секрет от Telegram (позже настроим setWebhook с secret_token)
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).send("unauthorized");
    return;
  }

  // 2) Telegram шлёт POST
  if (req.method !== "POST") {
    res.status(200).send("ok");
    return;
  }

  // 3) передаём update боту
  await bot.handleUpdate(req.body);
  res.status(200).send("ok");
}
