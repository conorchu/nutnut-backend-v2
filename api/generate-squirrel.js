/**
 * /api/generate-squirrel
 *
 * Nut Nut 松鼠圖片生成 API
 *
 * 功能：
 * 1. 接收 { title, content }
 * 2. 直接讀 repo 裡 assets/squirrel-reference.png
 * 3. 將母版圖 + 任務文字交給 Gemini
 * 4. Gemini 成功 → 上傳 Supabase Storage
 * 5. Gemini 失敗 → 使用固定母版圖上傳 Supabase Storage
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
   05｜Supabase Storage
   ================================================================ */

async function uploadToSupabaseStorage(
  base64,
  mimeType = "image/png",
) {
  /*
   * 注意：
   * 這裡使用你目前 Vercel 已存在的環境變數名稱：
   *
   * SUPABASE_URL_
   * SUPABASE_SECRET_KEY
   */

  const supabaseUrl =
    process.env.SUPABASE_URL;

  const supabaseSecretKey =
    process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl) {
    throw new Error(
      "SUPABASE_URL_ 環境變數沒有設定",
    );
  }

  if (!supabaseSecretKey) {
    throw new Error(
      "SUPABASE_SECRET_KEY 環境變數沒有設定",
    );
  }

  /*
   * Supabase Storage Bucket
   *
   * 請確認 Supabase 裡真的有：
   *
   * nutnut-images
   */

  const bucketName =
    "nutnut-images";


  /*
   * 根據圖片 MIME Type 決定副檔名
   */

  let extension = "png";

  if (
    mimeType === "image/jpeg"
  ) {
    extension = "jpg";
  } else if (
    mimeType === "image/webp"
  ) {
    extension = "webp";
  }


  /*
   * 建立唯一檔名
   */

  const fileName =
    `nutnut-${Date.now()}-` +
    `${Math.random()
      .toString(36)
      .slice(2, 8)}` +
    `.${extension}`;


  /*
   * Storage 裡的實際路徑：
   *
   * nutnut-images/
   * └── generated/
   *     └── nutnut-xxxxx.png
   */

  const filePath =
    `generated/${fileName}`;


  /*
   * Gemini Base64 → Buffer
   */

  const imageBuffer =
    Buffer.from(
      base64,
      "base64",
    );


  console.log(
    "⬆️ 開始上傳 Supabase Storage...",
  );

  console.log(
    "Bucket：",
    bucketName,
  );

  console.log(
    "檔案：",
    filePath,
  );

  console.log(
    "圖片大小：",
    imageBuffer.length,
  );


  /*
   * Supabase Storage REST API
   */

  const uploadUrl =
    `${supabaseUrl}/storage/v1/object/` +
    `${bucketName}/${filePath}`;


  const response =
    await fetch(
      uploadUrl,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${supabaseSecretKey}`,

          apikey:
            supabaseSecretKey,

          "Content-Type":
            mimeType,

          "x-upsert":
            "false",
        },

        body:
          imageBuffer,
      },
    );


  const result =
    await response
      .json()
      .catch(
        () => ({}),
      );


  /*
   * Supabase 上傳失敗
   */

  if (!response.ok) {
    console.error(
      "❌ Supabase Storage 上傳失敗：",
      response.status,
      JSON.stringify(
        result,
      ).slice(
        0,
        1500,
      ),
    );

    throw new Error(
      `Supabase Storage 上傳失敗（${response.status}）`,
    );
  }


  /*
   * Public Bucket 公開圖片 URL
   *
   * Gmail / EmailJS 會使用這個網址。
   */

  const imageUrl =
    `${supabaseUrl}/storage/v1/object/public/` +
    `${bucketName}/${filePath}`;


  console.log(
    "✅ Supabase Storage 上傳成功：",
    filePath,
  );

  console.log(
    "🖼️ Nut Nut 圖片 URL：",
    imageUrl,
  );


  return imageUrl;
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
       * 將 Gemini 生成圖
       * 上傳到 Supabase Storage。
       */

      imageUrl =
        await uploadToSupabaseStorage(
          generatedImage.base64,
          generatedImage.mimeType,
        );


      console.log(
        "✅ Gemini 圖片已上傳 Supabase Storage：",
        imageUrl,
      );


    } catch (
      generationError
    ) {

      /*
       * Gemini 生圖失敗時：
       *
       * 不使用其他 AI 生圖服務。
       *
       * 直接使用固定 Nut Nut 母版。
       */

      console.error(
        "⚠️ Gemini 生圖失敗，改使用固定 Nut Nut 母版：",
        generationError,
      );


      /*
       * 將 Nut Nut 母版也上傳到
       * Supabase Storage。
       */

      imageUrl =
        await uploadToSupabaseStorage(
          referenceImage.base64,
          "image/png",
        );


      fallbackUsed = true;


      console.log(
        "✅ 已使用固定 Nut Nut 母版 fallback：",
        imageUrl,
      );
    }


    /*
     * 成功回傳
     */

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
