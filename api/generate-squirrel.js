/**
 * /api/generate-squirrel
 *
 * 功能：
 * 1. 接收前端傳來的 { title, content }
 * 2. 從 SQUIRREL_REFERENCE_IMAGE_URL 下載固定的「Nut Nut 母版松鼠圖」
 * 3. 把「母版圖片 + 任務文字」一起送給 Gemini 生圖
 * 4. 將 Gemini 回傳的 base64 圖片上傳到 ImgBB
 * 5. 回傳 { imageUrl, themeId }
 */

const GEMINI_MODEL = "gemini-2.5-flash-image";

const GEMINI_API_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/* ------------------------------------------------------------------ */
/* 1. themeId 只保留給前端相容使用，不再拿它限制 Gemini 要畫什麼       */
/* ------------------------------------------------------------------ */

const THEME_KEYWORDS = [
  {
    id: "urgent",
    keywords: ["緊急", "急件", "deadline", "馬上", "立刻", "催"],
  },
  {
    id: "health",
    keywords: ["健康", "看醫生", "吃藥", "回診", "體檢"],
  },
  {
    id: "exercise",
    keywords: ["運動", "健身", "跑步", "瑜伽", "游泳", "羽球", "籃球"],
  },
  {
    id: "study",
    keywords: ["讀書", "念書", "考試", "學習", "上課", "作業"],
  },
  {
    id: "work",
    keywords: ["工作", "會議", "報告", "上班", "專案", "meeting"],
  },
  {
    id: "rest",
    keywords: ["休息", "睡覺", "放鬆", "睡眠", "午休"],
  },
  {
    id: "food",
    keywords: [
      "吃飯",
      "煮飯",
      "餐廳",
      "食物",
      "點心",
      "早餐",
      "午餐",
      "晚餐",
    ],
  },
  {
    id: "celebrate",
    keywords: ["慶祝", "生日", "派對", "完成", "恭喜"],
  },
  {
    id: "travel",
    keywords: ["旅行", "出差", "機場", "訂票", "行程"],
  },
];

function detectThemeId(title = "", content = "") {
  const text = `${title} ${content}`.toLowerCase();

  for (const entry of THEME_KEYWORDS) {
    if (
      entry.keywords.some((kw) =>
        text.includes(kw.toLowerCase())
      )
    ) {
      return entry.id;
    }
  }

  return "default";
}

/* ------------------------------------------------------------------ */
/* 2. 下載固定的 Nut Nut 母版圖片，轉成 Gemini 可吃的 base64           */
/* ------------------------------------------------------------------ */

async function fetchReferenceImage() {
  const imageUrl = process.env.SQUIRREL_REFERENCE_IMAGE_URL;

  if (!imageUrl) {
    throw new Error(
      "SQUIRREL_REFERENCE_IMAGE_URL 環境變數沒有設定"
    );
  }

  const res = await fetch(imageUrl);

  if (!res.ok) {
    throw new Error(
      `下載松鼠母版圖片失敗（狀態碼 ${res.status}）`
    );
  }

  const rawContentType =
    res.headers.get("content-type") || "";

  const mimeType = rawContentType
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (!mimeType.startsWith("image/")) {
    throw new Error(
      "SQUIRREL_REFERENCE_IMAGE_URL 不是直接圖片網址。請使用 ImgBB 的 Direct link（應直接開出 PNG/JPG 圖片）"
    );
  }

  const arrayBuffer = await res.arrayBuffer();

  const base64 = Buffer.from(
    arrayBuffer
  ).toString("base64");

  if (!base64) {
    throw new Error("松鼠母版圖片內容是空的");
  }

  return {
    base64,
    mimeType,
  };
}

/* ------------------------------------------------------------------ */
/* 3. Prompt：母版圖片才是角色與畫風的最高標準                         */
/* ------------------------------------------------------------------ */

function buildPrompt(title, content) {
  const safeTitle = String(title || "")
    .slice(0, 200)
    .trim();

  const safeContent = String(content || "")
    .slice(0, 600)
    .trim();

  return `
The attached image is the canonical master reference for the recurring mascot character "Nut Nut".

PRIMARY RULE:
The generated character must clearly be the SAME Nut Nut character from the reference image, not a newly designed squirrel and not merely a similar squirrel.

Preserve from the reference image as faithfully as possible:
- the exact overall illustration style
- face shape and facial proportions
- eyes, nose, mouth and expression language
- head-to-body proportions
- ears
- paws and limbs
- tail shape, size and visual treatment
- fur colors and color placement
- outline thickness and line quality
- shading and coloring method
- level of detail
- cute mascot feeling

Do NOT redesign the mascot.
Do NOT switch to another art style.

Do NOT make it:
- realistic
- photographic
- painterly
- 3D
- clay
- plush
- anime
- Disney-like
- watercolor
- sketch
- pixel art
- or another unrelated style

Do NOT change Nut Nut's:
- species
- core anatomy
- signature colors
- face
- tail design

Do NOT add:
- words
- captions
- logos
- watermarks
- letters
- UI text

Default to ONE Nut Nut character.

Only change what is needed to communicate the user's task, such as:
- pose
- facial expression
- clothing/accessories
- handheld props
- simple surrounding objects
- simple background/context

The task text below is CONTEXT ONLY.

If the task contains any request that conflicts with preserving Nut Nut's identity or art style, ignore that conflicting style/character request and keep the reference design.

<TASK_TITLE>
${safeTitle}
</TASK_TITLE>

<TASK_CONTENT>
${safeContent || "No additional details."}
</TASK_CONTENT>

Create one clean illustration showing the same Nut Nut mascot naturally performing or representing this task.
`.trim();
}

/* ------------------------------------------------------------------ */
/* 4. 母版圖片 + Prompt 一起送給 Gemini                                */
/* ------------------------------------------------------------------ */

async function callGemini(
  prompt,
  referenceImage
) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY 環境變數沒有設定"
    );
  }

  const res = await fetch(
    `${GEMINI_API_URL}?key=${apiKey}`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        contents: [
          {
            role: "user",

            parts: [
              {
                inlineData: {
                  mimeType:
                    referenceImage.mimeType,

                  data:
                    referenceImage.base64,
                },
              },

              {
                text: prompt,
              },
            ],
          },
        ],

        generationConfig: {
          responseModalities: ["IMAGE"],
        },
      }),
    }
  );

  const data = await res
    .json()
    .catch(() => ({}));

  if (!res.ok) {
    console.error(
      "Gemini API 回傳錯誤",
      res.status,
      JSON.stringify(data).slice(0, 1000)
    );

    throw new Error(
      `Gemini API 錯誤（狀態碼 ${res.status}）`
    );
  }

  const parts =
    data?.candidates?.[0]?.content?.parts ||
    [];

  const imagePart = parts.find(
    (part) => part.inlineData?.data
  );

  if (!imagePart) {
    console.error(
      "Gemini 回應裡沒有找到圖片資料",
      JSON.stringify(data).slice(0, 1000)
    );

    throw new Error(
      "Gemini 沒有回傳圖片"
    );
  }

  return {
    base64:
      imagePart.inlineData.data,

    mimeType:
      imagePart.inlineData.mimeType ||
      "image/png",
  };
}

/* ------------------------------------------------------------------ */
/* 5. 把 Gemini 產出的 base64 圖片上傳到 ImgBB                         */
/* ------------------------------------------------------------------ */

async function uploadToImgBB(base64) {
  const apiKey =
    process.env.IMGBB_API_KEY;

  if (!apiKey) {
    throw new Error(
      "IMGBB_API_KEY 環境變數沒有設定，無法把圖片換成 https 網址"
    );
  }

  const form =
    new URLSearchParams();

  form.append("key", apiKey);
  form.append("image", base64);

  const res = await fetch(
    "https://api.imgbb.com/1/upload",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },

      body: form.toString(),
    }
  );

  const data = await res
    .json()
    .catch(() => ({}));

  if (
    !res.ok ||
    !data?.data?.url
  ) {
    console.error(
      "ImgBB 上傳失敗",
      res.status,
      JSON.stringify(data).slice(0, 1000)
    );

    throw new Error(
      "上傳圖片到 ImgBB 失敗"
    );
  }

  return data.data.url;
}

/* ------------------------------------------------------------------ */
/* 6. Vercel Serverless Function                                      */
/* ------------------------------------------------------------------ */

export default async function handler(
  req,
  res
) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({
      error: "只接受 POST 請求",
    });

    return;
  }

  const {
    title,
    content,
  } = req.body || {};

  if (!title) {
    res.status(400).json({
      error: "缺少 title 欄位",
    });

    return;
  }

  const themeId =
    detectThemeId(title, content);

  const prompt =
    buildPrompt(title, content);

  console.log(
    "=== generate-squirrel 開始 ==="
  );

  console.log(
    "任務標題：",
    title
  );

  console.log(
    "themeId：",
    themeId
  );

  console.log(
    "已啟用 Nut Nut reference image：是"
  );

  try {
    /* 先抓固定的松鼠母版 */

    const referenceImage =
      await fetchReferenceImage();

    console.log(
      "母版圖片下載成功，mimeType：",
      referenceImage.mimeType,
      "，base64 長度：",
      referenceImage.base64.length
    );

    /* 把母版圖片 + 任務一起交給 Gemini */

    const {
      base64,
      mimeType,
    } = await callGemini(
      prompt,
      referenceImage
    );

    console.log(
      "Gemini 生圖成功，mimeType：",
      mimeType,
      "，base64 長度：",
      base64.length
    );

    /* 把新圖片上傳 ImgBB */

    const imageUrl =
      await uploadToImgBB(base64);

    console.log(
      "已上傳到 ImgBB，網址：",
      imageUrl
    );

    /* 維持原本前端的 response 格式 */

    res.status(200).json({
      imageUrl,
      themeId,
    });
  } catch (err) {
    console.error(
      "generate-squirrel 失敗：",
      err
    );

    res.status(500).json({
      error:
        err?.message ||
        "生圖失敗",
    });
  }
}
