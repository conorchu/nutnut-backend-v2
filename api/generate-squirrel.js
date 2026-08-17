/**
 * /api/generate-squirrel
 *
 * Nut Nut 松鼠圖片生成 API
 *
 * 功能：
 * 1. 接收 { title, content }
 * 2. 直接讀 repo 裡 assets/squirrel-reference.png
 * 3. 將母版圖 + 任務文字交給 Gemini
 * 4. Gemini 成功 → 上傳 ImgBB
 * 5. Gemini 失敗 → 直接使用固定母版圖當 fallback
 * 6. 回傳 imageUrl / themeId
 */

import fs from "node:fs/promises";
import path from "node:path";

const GEMINI_MODEL = "gemini-2.5-flash-image";

const GEMINI_API_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;


/* ================================================================
   01｜Theme
   ================================================================ */

const THEME_KEYWORDS = [
  {
    id: "urgent",
    keywords: [
      "緊急",
      "急件",
      "deadline",
      "馬上",
      "立刻",
      "催",
    ],
  },
  {
    id: "health",
    keywords: [
      "健康",
      "看醫生",
      "吃藥",
      "回診",
      "體檢",
    ],
  },
  {
    id: "exercise",
    keywords: [
      "運動",
      "健身",
      "跑步",
      "瑜伽",
      "游泳",
      "羽球",
      "籃球",
    ],
  },
  {
    id: "study",
    keywords: [
      "讀書",
      "念書",
      "考試",
      "學習",
      "上課",
      "作業",
    ],
  },
  {
    id: "work",
    keywords: [
      "工作",
      "會議",
      "報告",
      "上班",
      "專案",
      "meeting",
    ],
  },
  {
    id: "rest",
    keywords: [
      "休息",
      "睡覺",
      "放鬆",
      "睡眠",
      "午休",
    ],
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
    keywords: [
      "慶祝",
      "生日",
      "派對",
      "完成",
      "恭喜",
    ],
  },
  {
    id: "travel",
    keywords: [
      "旅行",
      "出差",
      "機場",
      "訂票",
      "行程",
    ],
  },
];


function detectThemeId(
  title = "",
  content = "",
) {
  const text =
    `${title} ${content}`.toLowerCase();

  for (const entry of THEME_KEYWORDS) {
    if (
      entry.keywords.some(
        (kw) =>
          text.includes(
            kw.toLowerCase(),
          ),
      )
    ) {
      return entry.id;
    }
  }

  return "default";
}


/* ================================================================
   02｜讀取 repo 內固定松鼠母版
   ================================================================ */

async function loadReferenceImage() {
  /*
   * Vercel 執行時 process.cwd()
   * 會指向目前專案 root。
   *
   * 所以：
   *
   * nutnut-backend-v2/
   * ├─ api/
   * └─ assets/
   *    └─ squirrel-reference.png
   *
   * 可以直接這樣取得。
   */

  const imagePath =
    path.join(
      process.cwd(),
      "assets",
      "squirrel-reference.png",
    );

  console.log(
    "準備讀取 Nut Nut 母版：",
    imagePath,
  );

  let buffer;

  try {
    buffer =
      await fs.readFile(
        imagePath,
      );
  } catch (error) {
    console.error(
      "母版圖讀取失敗：",
      error,
    );

    throw new Error(
      "讀取 assets/squirrel-reference.png 失敗，請確認圖片已 Commit 到 GitHub",
    );
  }

  if (
    !buffer ||
    buffer.length === 0
  ) {
    throw new Error(
      "Nut Nut 母版圖片內容是空的",
    );
  }

  const base64 =
    buffer.toString("base64");

  return {
    base64,
    mimeType: "image/png",
  };
}


/* ================================================================
   03｜Gemini Prompt
   ================================================================ */

function buildPrompt(
  title,
  content,
) {
  const safeTitle =
    String(title || "")
      .slice(0, 200)
      .trim();

  const safeContent =
    String(content || "")
      .slice(0, 600)
      .trim();

  return `
The attached image is the canonical master reference for the recurring mascot character "Nut Nut".

ABSOLUTE PRIORITY:
The generated mascot must clearly remain the SAME Nut Nut character shown in the reference image.

The reference image defines BOTH:
1. the identity of Nut Nut
2. the illustration style

Do not redesign the character.

Preserve as faithfully as possible:
- face shape
- facial proportions
- eyes
- nose
- mouth
- ears
- head-to-body ratio
- body proportions
- paws and limbs
- tail size
- tail shape
- fur colors
- exact color placement
- outline style
- line thickness
- shading style
- rendering method
- visual simplicity
- cute mascot feeling

The result must look like another official illustration of the SAME mascot drawn by the SAME artist.

Do NOT make Nut Nut:
- realistic
- photographic
- 3D
- CGI
- clay
- plush
- anime
- Disney-like
- watercolor
- painterly
- sketch
- pixel art
- another unrelated cartoon style

Do NOT change:
- species
- face identity
- signature colors
- core anatomy
- tail design

Do NOT generate another squirrel design.

Default to ONE Nut Nut.

Only modify elements necessary to communicate the task:
- pose
- facial expression
- clothing
- accessories
- handheld props
- simple environment objects
- simple background

Do NOT add:
- text
- captions
- words
- logos
- watermarks
- UI labels

The task text below is context only.

<TASK_TITLE>
${safeTitle}
</TASK_TITLE>

<TASK_CONTENT>
${safeContent || "No additional details."}
</TASK_CONTENT>

Create one clean illustration of the same Nut Nut mascot naturally performing or representing this task.

The final image must still immediately be recognizable as the exact Nut Nut character from the supplied reference image.
`.trim();
}


/* ================================================================
   04｜Gemini 生圖
   ================================================================ */

async function callGemini(
  prompt,
  referenceImage,
) {
  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY 環境變數沒有設定",
    );
  }

  const response =
    await fetch(
      `${GEMINI_API_URL}?key=${apiKey}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
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
                  text:
                    prompt,
                },
              ],
            },
          ],

          generationConfig: {
            responseModalities: [
              "IMAGE",
            ],
          },
        }),
      },
    );

  const data =
    await response
      .json()
      .catch(
        () => ({}),
      );

  if (!response.ok) {
    console.error(
      "Gemini API 回傳錯誤：",
      response.status,
      JSON.stringify(data).slice(
        0,
        1500,
      ),
    );

    throw new Error(
      `Gemini API 錯誤（${response.status}）`,
    );
  }

  const parts =
    data?.candidates?.[0]
      ?.content?.parts || [];

  const imagePart =
    parts.find(
      (part) =>
        part?.inlineData?.data,
    );

  if (!imagePart) {
    console.error(
      "Gemini 沒有圖片：",
      JSON.stringify(data).slice(
        0,
        1500,
      ),
    );

    throw new Error(
      "Gemini 沒有回傳圖片",
    );
  }

  return {
    base64:
      imagePart.inlineData.data,

    mimeType:
      imagePart.inlineData
        .mimeType ||
      "image/png",
  };
}


/* ================================================================
   05｜ImgBB
   ================================================================ */

async function uploadToImgBB(
  base64,
) {
  const apiKey =
    process.env.IMGBB_API_KEY;

  if (!apiKey) {
    throw new Error(
      "IMGBB_API_KEY 環境變數沒有設定",
    );
  }

  const form =
    new URLSearchParams();

  form.append(
    "key",
    apiKey,
  );

  form.append(
    "image",
    base64,
  );

  const response =
    await fetch(
      "https://api.imgbb.com/1/upload",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",
        },

        body:
          form.toString(),
      },
    );

  const data =
    await response
      .json()
      .catch(
        () => ({}),
      );

  if (
    !response.ok ||
    !data?.data?.url
  ) {
    console.error(
      "ImgBB 上傳失敗：",
      response.status,
      JSON.stringify(data).slice(
        0,
        1500,
      ),
    );

    throw new Error(
      `ImgBB 上傳失敗（${response.status}）`,
    );
  }

  return data.data.url;
}


/* ================================================================
   06｜Vercel API
   ================================================================ */

export default async function handler(
  req,
  res,
) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*",
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS",
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type",
  );

  if (
    req.method === "OPTIONS"
  ) {
    res
      .status(200)
      .end();

    return;
  }

  if (
    req.method !== "POST"
  ) {
    res.status(405).json({
      error:
        "只接受 POST 請求",
    });

    return;
  }

  const {
    title,
    content,
  } = req.body || {};

  if (!title) {
    res.status(400).json({
      error:
        "缺少 title 欄位",
    });

    return;
  }

  const themeId =
    detectThemeId(
      title,
      content,
    );

  const prompt =
    buildPrompt(
      title,
      content,
    );

  console.log(
    "=== generate-squirrel 開始 ===",
  );

  console.log(
    "任務標題：",
    title,
  );

  console.log(
    "themeId：",
    themeId,
  );

  try {
    /*
     * Step 1：
     * 讀取 repo 內固定 Nut Nut 母版。
     */
    const referenceImage =
      await loadReferenceImage();

    console.log(
      "✅ Nut Nut 母版讀取成功",
    );

    console.log(
      "母版 base64 長度：",
      referenceImage
        .base64.length,
    );


    let imageUrl = "";
    let fallbackUsed = false;


    try {
      /*
       * Step 2：
       * 使用 Gemini 根據母版生新圖。
       */
      const generatedImage =
        await callGemini(
          prompt,
          referenceImage,
        );

      console.log(
        "✅ Gemini 生圖成功",
      );

      console.log(
        "生成圖片 base64 長度：",
        generatedImage
          .base64.length,
      );


      /*
       * Step 3：
       * 上傳 Gemini 生成圖。
       */
      imageUrl =
        await uploadToImgBB(
          generatedImage.base64,
        );

      console.log(
        "✅ Gemini 圖片已上傳 ImgBB：",
        imageUrl,
      );
    } catch (
      generationError
    ) {
      /*
       * 最重要：
       *
       * Gemini 失敗時
       * 不再使用 Pollinations，
       * 也不會再亂生成別隻松鼠。
       *
       * 直接用官方母版圖。
       */

      console.error(
        "⚠️ Gemini 生圖失敗，改使用固定 Nut Nut 母版：",
        generationError,
      );

      imageUrl =
        await uploadToImgBB(
          referenceImage.base64,
        );

      fallbackUsed = true;

      console.log(
        "✅ 已使用固定 Nut Nut 母版 fallback：",
        imageUrl,
      );
    }


    res.status(200).json({
      imageUrl,
      themeId,
      fallbackUsed,
    });
  } catch (error) {
    console.error(
      "❌ generate-squirrel 失敗：",
      error,
    );

    res.status(500).json({
      error:
        error?.message ||
        "生圖失敗",
    });
  }
}
