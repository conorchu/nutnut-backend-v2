/**
 * /api/generate-squirrel
 *
 * 用途：接收前端傳來的任務標題 / 內容，呼叫 Gemini 圖片生成模型，
 *       產出一張「風格固定」的松鼠吉祥物插圖，回傳圖片網址給前端。
 *
 * 這一版重寫的重點（解決「畫風跑掉」的問題）：
 * 1. 把「松鼠基礎畫風」寫成一段完全固定、不會被標題內容干擾的樣板文字，
 *    永遠放在 prompt 最前面，且用非常明確、重複強調的方式描述風格細節
 *    （角色設計、線條、配色、材質、視角），降低模型自由發揮的空間。
 * 2. 任務標題／內容一律只拿來判斷「情境動作」（跑步、睡覺、慶祝...），
 *    絕對不會被當成風格描述的一部分直接塞進 prompt，避免使用者輸入
 *    不可預期的字詞去污染畫風指令。
 * 3. 加上 negative prompt（明確列出「不要出現」的元素），避免模型
 *    跑去畫成真實松鼠、3D 立體渲染、其他動物、或加上不想要的背景。
 * 4. 全程用 console.log／console.error 記錄「送出的 prompt」與
 *    「Gemini 的回應狀態」，之後可以直接在 Vercel Logs 裡查到，
 *    不會再發生「程式碼遺失、Logs 也是空白」的狀況。
 * 5. 保留跟前端一致的請求／回應格式：
 *      request  body: { title, content }
 *      response body: { imageUrl } 或 { error }
 * 6.【重要修正】Gemini 回傳的是 base64 圖片資料，這一版新增「上傳到 ImgBB
 *    換成真正的 https 網址」這一步，因為 Gmail 會直接擋掉 base64 (data:image...)
 *    來源的圖片，導致提醒信附圖失效。回傳給前端的 imageUrl 現在一定是
 *    https://i.ibb.co/... 這種真正的網址，可以放心塞進 Email 樣板。
 */

const GEMINI_MODEL = "gemini-2.5-flash-image";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/* ------------------------------------------------------------------ */
/* 1. 固定不變的松鼠角色設計「聖經」——這段文字絕對不會被使用者輸入影響。 */
/* ------------------------------------------------------------------ */
const SQUIRREL_STYLE_BIBLE = `
Character design reference (MUST follow exactly, this is a fixed mascot design):
- A single cute chibi cartoon squirrel mascot named "Nut Nut"
- Body proportions: large round head, small compact body, short stubby limbs, big fluffy tail curled upward
- Fur color: warm orange-brown fur on the back, cream/off-white belly and chest patch
- Face: big round sparkly black eyes with a small white highlight, tiny black nose, gentle friendly smile
- Line art: clean thick black outline (flat vector illustration style, NOT 3D, NOT realistic, NOT painterly)
- Shading: flat cel-shading only, minimal soft shadow under the body, no gradients, no photorealistic lighting
- Palette: warm forest color palette (orange, brown, cream, small pops of green)
- Composition: single character centered, sticker/emoji style, plain white or very light background
- No text, no watermark, no logo, no signature anywhere in the image
`.trim();

const NEGATIVE_PROMPT = `
Do NOT include: realistic/photographic squirrel, 3D render, other animals, human characters,
multiple squirrels, dark or busy background, extra text or letters, watermark, blurry image,
different color palette, different character design than the reference above.
`.trim();

/* ------------------------------------------------------------------ */
/* 2. 情境動作字典——只負責決定「松鼠在做什麼動作／表情」，不碰畫風。 */
/* ------------------------------------------------------------------ */
const MOOD_KEYWORDS = [
  { id: "urgent", keywords: ["緊急", "急件", "deadline", "馬上", "立刻", "催"], mood: "panicked expression, waving both arms frantically, tiny sweat drops" },
  { id: "health", keywords: ["健康", "看醫生", "吃藥", "回診", "體檢"], mood: "wearing a tiny bandage, holding a small first-aid cross icon, caring expression" },
  { id: "exercise", keywords: ["運動", "健身", "跑步", "瑜伽", "游泳"], mood: "mid-jog pose, tiny sweatband, determined happy expression" },
  { id: "study", keywords: ["讀書", "念書", "考試", "學習", "上課"], mood: "sitting at a tiny desk with a small book, wearing round glasses, focused expression" },
  { id: "work", keywords: ["工作", "會議", "報告", "上班", "專案"], mood: "holding a tiny briefcase, standing confidently, determined expression" },
  { id: "rest", keywords: ["休息", "睡覺", "放鬆", "睡眠", "午休"], mood: "curled up sleeping, eyes closed, small 'Z' floating above head" },
  { id: "food", keywords: ["吃飯", "煮飯", "餐廳", "食物", "點心"], mood: "holding a tiny acorn like a snack, happy satisfied expression" },
  { id: "celebrate", keywords: ["慶祝", "生日", "派對", "完成", "恭喜"], mood: "arms raised in celebration, tiny confetti around, joyful expression" },
  { id: "travel", keywords: ["旅行", "出差", "機場", "訂票", "行程"], mood: "wearing a tiny backpack, waving goodbye, excited expression" },
  { id: "default", keywords: [], mood: "friendly neutral standing pose, gentle encouraging smile, one paw raised as if reminding you" },
];

function pickMood(title = "", content = "") {
  const text = `${title} ${content}`;
  for (const entry of MOOD_KEYWORDS) {
    if (entry.keywords.some((kw) => text.includes(kw))) return entry;
  }
  return MOOD_KEYWORDS[MOOD_KEYWORDS.length - 1]; // default
}

/* ------------------------------------------------------------------ */
/* 3. 組出最終 prompt：畫風聖經 + 固定動作描述 + negative prompt。      */
/*    使用者輸入的標題只會被放進「task context」這個獨立區塊，          */
/*    並且明確告訴模型「這只是情境參考，不要因此改變角色設計」。        */
/* ------------------------------------------------------------------ */
function buildPrompt(title, content) {
  const moodEntry = pickMood(title, content);
  const safeTitle = String(title || "").slice(0, 60); // 避免超長標題把 prompt 撐爆

  const prompt = `
${SQUIRREL_STYLE_BIBLE}

Pose / expression for this illustration: ${moodEntry.mood}

Task context (for pose/prop inspiration ONLY — do NOT change the character design above,
do NOT render this text, do NOT add extra unrelated objects beyond what's described in the pose):
"${safeTitle}"

${NEGATIVE_PROMPT}
`.trim();

  return { prompt, themeId: moodEntry.id };
}

/* ------------------------------------------------------------------ */
/* 4. 呼叫 Gemini，回傳 base64 圖片並轉成可直接使用的 data URL。        */
/* ------------------------------------------------------------------ */
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY 環境變數沒有設定");
  }

  const res = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error("Gemini API 回傳錯誤", res.status, JSON.stringify(data).slice(0, 500));
    throw new Error(`Gemini API 錯誤（狀態碼 ${res.status}）`);
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);

  if (!imagePart) {
    console.error("Gemini 回應裡沒有找到圖片資料", JSON.stringify(data).slice(0, 500));
    throw new Error("Gemini 沒有回傳圖片");
  }

  const mimeType = imagePart.inlineData.mimeType || "image/png";
  const base64 = imagePart.inlineData.data;
  return { base64, mimeType };
}

/* ------------------------------------------------------------------ */
/* 4.5 把 base64 圖片上傳到 ImgBB，換成真正的 https 網址。              */
/*     Gmail 會擋掉 data:image base64 來源的圖片，所以 Email 附圖       */
/*     一定要是這種外部託管的真實網址才會顯示出來。                     */
/* ------------------------------------------------------------------ */
async function uploadToImgBB(base64) {
  const apiKey = process.env.IMGBB_API_KEY;
  if (!apiKey) {
    throw new Error("IMGBB_API_KEY 環境變數沒有設定，無法把圖片換成 https 網址");
  }

  const form = new URLSearchParams();
  form.append("key", apiKey);
  form.append("image", base64);

  const res = await fetch("https://api.imgbb.com/1/upload", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data?.data?.url) {
    console.error("ImgBB 上傳失敗", res.status, JSON.stringify(data).slice(0, 500));
    throw new Error("上傳圖片到 ImgBB 失敗");
  }

  return data.data.url; // 例如 https://i.ibb.co/xxxxxxx/xxx.png
}

/* ------------------------------------------------------------------ */
/* 5. Serverless Function 主體                                        */
/* ------------------------------------------------------------------ */
export default async function handler(req, res) {
  // CORS：讓 GitHub Pages 前端可以打這支 API
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "只接受 POST 請求" });
    return;
  }

  const { title, content } = req.body || {};

  if (!title) {
    res.status(400).json({ error: "缺少 title 欄位" });
    return;
  }

  const { prompt, themeId } = buildPrompt(title, content);

  // 關鍵：把送出的 prompt 完整印出來，之後可以直接在 Vercel Logs 裡查到
  console.log("=== generate-squirrel 開始 ===");
  console.log("任務標題：", title);
  console.log("判斷出的情境（themeId）：", themeId);
  console.log("送給 Gemini 的完整 prompt：");
  console.log(prompt);

  try {
    const { base64, mimeType } = await callGemini(prompt);
    console.log("Gemini 生圖成功，mimeType：", mimeType, "，base64 長度：", base64.length);

    const imageUrl = await uploadToImgBB(base64);
    console.log("已上傳到 ImgBB，網址：", imageUrl);

    res.status(200).json({ imageUrl, themeId });
  } catch (err) {
    console.error("generate-squirrel 失敗：", err.message);
    res.status(500).json({ error: err.message || "生圖失敗" });
  }
}
