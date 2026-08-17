/**
 * /api/process-reminders
 *
 * 松鼠果 Nut Nut｜背景 Email 任務提醒
 *
 * 功能：
 * 1. 從 Supabase user_data 讀取所有使用者任務
 * 2. 找出已到提醒時間、尚未完成、尚未寄 Email 的任務
 * 3. 從 profiles 找到使用者 Email
 * 4. 呼叫現有 /api/generate-squirrel 生成任務專屬松鼠圖
 * 5. 使用 EmailJS REST API 寄提醒信
 * 6. 寄信成功後，把 emailNotified 設為 true
 *
 * 注意：
 * - 這支 API 不由手機瀏覽器負責執行
 * - 下一步會交給 Supabase Cron 每分鐘呼叫一次
 * - 所有 Secret 都放 Vercel Environment Variables
 * - 絕對不要把 Supabase Secret Key / EmailJS Private Key 寫死在這裡
 */

/* ================================================================
   01｜基本設定
   ================================================================ */

const MAX_REMINDERS_PER_RUN = 5;

/*
 * 避免系統剛上線時，把幾個月前的舊任務全部補寄。
 *
 * 超過提醒時間 60 分鐘的舊任務：
 * 不再補寄 Email。
 */
const MAX_LATE_MINUTES = 60;

/*
 * EmailJS 官方限制每秒最多 1 次 request。
 * 所以多封信之間保留一點間隔。
 */
const EMAIL_INTERVAL_MS = 1100;


/* ================================================================
   02｜Environment Variables
   ================================================================ */

function getConfig() {
  const config = {
    supabaseUrl:
      process.env.SUPABASE_URL || "",

    /*
     * 新版 Supabase 建議使用 Secret Key。
     * 如果你仍使用舊版 service_role，也相容。
     */
    supabaseSecretKey:
      process.env.SUPABASE_SECRET_KEY ||
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      "",

    emailjsPublicKey:
      process.env.EMAILJS_PUBLIC_KEY || "",

    /*
     * Private Key 可以沒有。
     * 如果 EmailJS 帳號有啟用 Private Key，
     * 就放到 Vercel 環境變數。
     */
    emailjsPrivateKey:
      process.env.EMAILJS_PRIVATE_KEY || "",

    emailjsServiceId:
      process.env.EMAILJS_SERVICE_ID || "",

    emailjsTemplateId:
      process.env.EMAILJS_TEMPLATE_ID || "",

    /*
     * 防止陌生人直接呼叫這支 API。
     *
     * 之後 Supabase Cron 呼叫時，
     * 會一起帶這個 Secret。
     */
    cronSecret:
      process.env.REMINDER_CRON_SECRET || "",

    /*
     * 通常不用填。
     *
     * 沒填時會自動使用目前 Vercel 網址。
     */
    backendUrl:
      process.env.BACKEND_URL || "",
  };

  return config;
}


/* ================================================================
   03｜小工具
   ================================================================ */

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}


function safeArray(value) {
  return Array.isArray(value)
    ? value
    : [];
}


/*
 * 舊任務可能還沒有 dueAt。
 *
 * 這時使用：
 *
 * date = 2026-08-18
 * time = 21:00
 *
 * 自動轉成：
 *
 * 2026-08-18T13:00:00.000Z
 *
 * 也就是台灣 21:00。
 */
function buildTaipeiDueAt(
  dateStr,
  timeStr,
) {
  if (!dateStr || !timeStr) {
    return null;
  }

  const normalizedTime =
    /^\d{2}:\d{2}$/.test(timeStr)
      ? `${timeStr}:00`
      : timeStr;

  const date = new Date(
    `${dateStr}T${normalizedTime}+08:00`,
  );

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}


/*
 * Email 裡顯示：
 *
 * 8/18（二） 21:00
 */
function formatTaskTime(
  dateStr,
  timeStr,
) {
  if (!dateStr) {
    return timeStr || "";
  }

  try {
    const date = new Date(
      `${dateStr}T${timeStr || "00:00"}:00+08:00`,
    );

    const formatted =
      new Intl.DateTimeFormat(
        "zh-TW",
        {
          timeZone: "Asia/Taipei",
          month: "numeric",
          day: "numeric",
          weekday: "short",
        },
      ).format(date);

    return `${formatted} ${timeStr || ""}`.trim();
  } catch (_) {
    return `${dateStr} ${timeStr || ""}`.trim();
  }
}


/* ================================================================
   04｜Supabase REST API
   ================================================================ */

function buildSupabaseHeaders(config) {
  return {
    apikey:
      config.supabaseSecretKey,

    Authorization:
      `Bearer ${config.supabaseSecretKey}`,

    "Content-Type":
      "application/json",
  };
}


/*
 * 讀取所有使用者的：
 *
 * user_id
 * tasks
 */
async function fetchUserData(config) {
  const url =
    `${config.supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/user_data` +
    `?select=user_id,tasks`;

  const response = await fetch(
    url,
    {
      method: "GET",

      headers:
        buildSupabaseHeaders(config),
    },
  );

  const data = await response
    .json()
    .catch(() => []);

  if (!response.ok) {
    console.error(
      "讀取 user_data 失敗：",
      response.status,
      data,
    );

    throw new Error(
      `Supabase user_data 讀取失敗（${response.status}）`,
    );
  }

  return Array.isArray(data)
    ? data
    : [];
}


/*
 * profiles 裡已經有：
 *
 * id
 * email
 *
 * 所以直接一次把使用者 Email 抓出來。
 */
async function fetchProfiles(config) {
  const url =
    `${config.supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/profiles` +
    `?select=id,email`;

  const response = await fetch(
    url,
    {
      method: "GET",

      headers:
        buildSupabaseHeaders(config),
    },
  );

  const data = await response
    .json()
    .catch(() => []);

  if (!response.ok) {
    console.error(
      "讀取 profiles 失敗：",
      response.status,
      data,
    );

    throw new Error(
      `Supabase profiles 讀取失敗（${response.status}）`,
    );
  }

  return Array.isArray(data)
    ? data
    : [];
}


/*
 * Email 寄成功之後，
 * 把修改過的 tasks 整包寫回該使用者。
 */
async function updateUserTasks(
  config,
  userId,
  tasks,
) {
  const url =
    `${config.supabaseUrl.replace(/\/$/, "")}` +
    `/rest/v1/user_data` +
    `?user_id=eq.${encodeURIComponent(userId)}`;

  const response = await fetch(
    url,
    {
      method: "PATCH",

      headers: {
        ...buildSupabaseHeaders(config),

        Prefer:
          "return=minimal",
      },

      body: JSON.stringify({
        tasks,

        updated_at:
          new Date().toISOString(),
      }),
    },
  );

  if (!response.ok) {
    const text = await response
      .text()
      .catch(() => "");

    console.error(
      "寫回 tasks 失敗：",
      response.status,
      text,
    );

    throw new Error(
      `Supabase 更新 tasks 失敗（${response.status}）`,
    );
  }
}


/* ================================================================
   05｜取得目前 Vercel Backend URL
   ================================================================ */

function getBackendUrl(
  req,
  config,
) {
  if (config.backendUrl) {
    return config.backendUrl.replace(
      /\/$/,
      "",
    );
  }

  const host =
    req.headers.host;

  if (!host) {
    throw new Error(
      "找不到 Backend host",
    );
  }

  const forwardedProto =
    req.headers["x-forwarded-proto"];

  const proto =
    forwardedProto ||
    "https";

  return `${proto}://${host}`;
}


/* ================================================================
   06｜呼叫現有 generate-squirrel.js
   ================================================================ */

async function generateSquirrel(
  req,
  config,
  task,
) {
  const backendUrl =
    getBackendUrl(
      req,
      config,
    );

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      60000,
    );

  try {
    const response = await fetch(
      `${backendUrl}/api/generate-squirrel`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          title:
            task.title || "任務提醒",

          content:
            task.content || "",
        }),

        signal:
          controller.signal,
      },
    );

    const data = await response
      .json()
      .catch(() => ({}));

    if (
      !response.ok ||
      !data.imageUrl
    ) {
      console.warn(
        "松鼠圖片生成失敗，改成寄純文字提醒：",
        response.status,
        data,
      );

      return {
        imageUrl: "",
        themeId:
          data.themeId ||
          "default",
      };
    }

    return {
      imageUrl:
        data.imageUrl,

      themeId:
        data.themeId ||
        "default",
    };
  } catch (error) {
    console.warn(
      "呼叫 generate-squirrel 失敗，改寄純文字：",
      error?.message ||
        error,
    );

    return {
      imageUrl: "",
      themeId: "default",
    };
  } finally {
    clearTimeout(timeout);
  }
}


/* ================================================================
   07｜松鼠情緒名稱
   ================================================================ */

function getSquirrelMood(
  themeId,
) {
  const moods = {
    urgent:
      "火力全開的緊急松鼠",

    health:
      "照顧健康的松鼠",

    exercise:
      "活力滿滿的運動松鼠",

    study:
      "專心學習的讀書松鼠",

    work:
      "認真工作的上班松鼠",

    rest:
      "準備休息的松鼠",

    food:
      "準備開動的吃貨松鼠",

    celebrate:
      "準備慶祝的派對松鼠",

    travel:
      "準備出發的旅行松鼠",

    default:
      "準備行動的松鼠",
  };

  return (
    moods[themeId] ||
    moods.default
  );
}


/* ================================================================
   08｜EmailJS REST API
   ================================================================ */

async function sendReminderEmail(
  config,
  {
    email,
    task,
    squirrelImage,
    themeId,
  },
) {
  const squirrelImageHtml =
    squirrelImage
      ? `<img src="${squirrelImage}" alt="松鼠提醒圖" style="width:180px;border-radius:16px;display:block;margin:12px auto;" />`
      : "";

  /*
   * 跟你現在 nutnut_v18.html
   * 使用完全相同的 Template Params。
   */
  const body = {
    service_id:
      config.emailjsServiceId,

    template_id:
      config.emailjsTemplateId,

    user_id:
      config.emailjsPublicKey,

    template_params: {
      to_email:
        email,

      task_title:
        task.title ||
        "任務提醒",

      task_content:
        task.content ||
        "（沒有補充內容）",

      task_time:
        formatTaskTime(
          task.date,
          task.time,
        ),

      squirrel_mood:
        getSquirrelMood(
          themeId,
        ),

      squirrel_image:
        squirrelImage || "",

      squirrel_image_html:
        squirrelImageHtml,
    },
  };

  /*
   * 如果有設定 EmailJS Private Key，
   * REST API 一併帶上。
   */
  if (
    config.emailjsPrivateKey
  ) {
    body.accessToken =
      config.emailjsPrivateKey;
  }

  const response = await fetch(
    "https://api.emailjs.com/api/v1.0/email/send",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",
      },

      body:
        JSON.stringify(body),
    },
  );

  const responseText =
    await response
      .text()
      .catch(() => "");

  if (!response.ok) {
    console.error(
      "EmailJS 寄送失敗：",
      response.status,
      responseText,
    );

    throw new Error(
      `EmailJS 寄送失敗（${response.status}）：${responseText}`,
    );
  }

  console.log(
    `Email 已寄出 → ${email} / ${task.title}`,
  );
}


/* ================================================================
   09｜判斷任務是不是現在應該提醒
   ================================================================ */

function getTaskReminderState(
  task,
  now,
) {
  if (!task) {
    return {
      shouldSend: false,
    };
  }

  /*
   * 已完成，不寄。
   */
  if (task.done === true) {
    return {
      shouldSend: false,
    };
  }

  /*
   * 已經成功寄過 Email，不寄。
   */
  if (
    task.emailNotified === true
  ) {
    return {
      shouldSend: false,
    };
  }

  /*
   * 舊版資料沒有 emailNotified，
   * 但 notified 已經是 true，
   * 代表以前前端已處理過這個提醒。
   *
   * 避免系統更新後重新寄舊信。
   */
  if (
    typeof task.emailNotified !==
      "boolean" &&
    task.notified === true
  ) {
    return {
      shouldSend: false,
      markAsHandled: true,
    };
  }

  const dueAt =
    task.dueAt ||
    buildTaipeiDueAt(
      task.date,
      task.time,
    );

  if (!dueAt) {
    return {
      shouldSend: false,
    };
  }

  const due =
    new Date(dueAt);

  if (
    Number.isNaN(
      due.getTime(),
    )
  ) {
    return {
      shouldSend: false,
    };
  }

  /*
   * 還沒到時間。
   */
  if (
    now.getTime() <
    due.getTime()
  ) {
    return {
      shouldSend: false,
    };
  }

  const minutesLate =
    (
      now.getTime() -
      due.getTime()
    ) /
    60000;

  /*
   * 太久以前的舊任務不補寄。
   */
  if (
    minutesLate >
    MAX_LATE_MINUTES
  ) {
    return {
      shouldSend: false,
      markAsHandled: true,
    };
  }

  return {
    shouldSend: true,
    dueAt,
    minutesLate,
  };
}


/* ================================================================
   10｜檢查 Environment Variables
   ================================================================ */

function validateConfig(
  config,
) {
  const missing = [];

  if (!config.supabaseUrl) {
    missing.push(
      "SUPABASE_URL",
    );
  }

  if (
    !config.supabaseSecretKey
  ) {
    missing.push(
      "SUPABASE_SECRET_KEY",
    );
  }

  if (
    !config.emailjsPublicKey
  ) {
    missing.push(
      "EMAILJS_PUBLIC_KEY",
    );
  }

  if (
    !config.emailjsServiceId
  ) {
    missing.push(
      "EMAILJS_SERVICE_ID",
    );
  }

  if (
    !config.emailjsTemplateId
  ) {
    missing.push(
      "EMAILJS_TEMPLATE_ID",
    );
  }

  if (
    !config.cronSecret
  ) {
    missing.push(
      "REMINDER_CRON_SECRET",
    );
  }

  return missing;
}


/* ================================================================
   11｜驗證 Cron Secret
   ================================================================ */

function isAuthorized(
  req,
  config,
) {
  const headerSecret =
    req.headers[
      "x-cron-secret"
    ];

  const authorization =
    req.headers.authorization ||
    "";

  const bearerSecret =
    authorization.startsWith(
      "Bearer ",
    )
      ? authorization.slice(7)
      : "";

  return (
    headerSecret ===
      config.cronSecret ||
    bearerSecret ===
      config.cronSecret
  );
}


/* ================================================================
   12｜真正處理提醒
   ================================================================ */

async function processReminders(
  req,
  config,
) {
  const now =
    new Date();

  console.log(
    "=== process-reminders 開始 ===",
  );

  console.log(
    "目前 UTC：",
    now.toISOString(),
  );

  /*
   * 一次把任務與 profiles 抓出來。
   */
  const [
    userRows,
    profiles,
  ] = await Promise.all([
    fetchUserData(config),
    fetchProfiles(config),
  ]);

  /*
   * userId → Email
   */
  const emailMap =
    new Map();

  profiles.forEach(
    (profile) => {
      if (
        profile?.id &&
        profile?.email
      ) {
        emailMap.set(
          profile.id,
          profile.email,
        );
      }
    },
  );

  let sentCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  const results = [];

  /*
   * 每個使用者逐一處理。
   */
  for (
    const row of userRows
  ) {
    if (
      sentCount >=
      MAX_REMINDERS_PER_RUN
    ) {
      break;
    }

    const userId =
      row.user_id;

    const email =
      emailMap.get(userId);

    const tasks =
      safeArray(row.tasks).map(
        (task) => ({
          ...task,
        }),
      );

    let userTasksChanged =
      false;

    for (
      const task of tasks
    ) {
      if (
        sentCount >=
        MAX_REMINDERS_PER_RUN
      ) {
        break;
      }

      const state =
        getTaskReminderState(
          task,
          now,
        );

      /*
       * 舊任務已處理，
       * 或過期太久：
       * 直接標記，避免每分鐘一直掃到。
       */
      if (
        state.markAsHandled
      ) {
        task.emailNotified =
          true;

        task.emailNotifiedAt =
          task.emailNotifiedAt ||
          now.toISOString();

        userTasksChanged =
          true;

        skippedCount += 1;

        continue;
      }

      if (
        !state.shouldSend
      ) {
        continue;
      }

      /*
       * 找不到 Email 時先不標記成功，
       * 下次 Cron 還會再試。
       */
      if (!email) {
        console.warn(
          `找不到 ${userId} 的 Email，這次略過。`,
        );

        failedCount += 1;

        results.push({
          userId,
          taskId:
            task.id || null,
          title:
            task.title || "",
          success: false,
          reason:
            "profile_email_missing",
        });

        continue;
      }

      console.log(
        `準備提醒：${email} / ${task.title}`,
      );

      try {
        /*
         * 先生成松鼠圖。
         *
         * 生圖失敗也沒關係：
         * generateSquirrel() 會回傳空網址，
         * Email 照樣寄。
         */
        const squirrel =
          await generateSquirrel(
            req,
            config,
            task,
          );

        /*
         * EmailJS 寄信。
         */
        await sendReminderEmail(
          config,
          {
            email,
            task,

            squirrelImage:
              squirrel.imageUrl,

            themeId:
              squirrel.themeId,
          },
        );

        /*
         * EmailJS 成功才標記。
         */
        task.emailNotified =
          true;

        task.emailNotifiedAt =
          new Date().toISOString();

        task.dueAt =
          state.dueAt ||
          task.dueAt ||
          null;

        /*
         * 把真正寄出去的圖片留下。
         */
        task.aiImageUrl =
          squirrel.imageUrl ||
          null;

        userTasksChanged =
          true;

        sentCount += 1;

        results.push({
          userId,

          taskId:
            task.id || null,

          title:
            task.title || "",

          success: true,

          imageGenerated:
            Boolean(
              squirrel.imageUrl,
            ),
        });

        /*
         * EmailJS 官方是每秒 1 request。
         */
        await sleep(
          EMAIL_INTERVAL_MS,
        );
      } catch (error) {
        failedCount += 1;

        console.error(
          `提醒失敗：${email} / ${task.title}`,
          error,
        );

        results.push({
          userId,

          taskId:
            task.id || null,

          title:
            task.title || "",

          success: false,

          reason:
            error?.message ||
            "unknown_error",
        });

        /*
         * 注意：
         *
         * 寄信失敗時不把
         * emailNotified 設 true。
         *
         * 所以下一次 Cron
         * 還有機會再試一次。
         */
      }
    }

    /*
     * 這個使用者有任何任務狀態改變，
     * 才寫回 Supabase。
     */
    if (
      userTasksChanged
    ) {
      try {
        await updateUserTasks(
          config,
          userId,
          tasks,
        );
      } catch (error) {
        console.error(
          `使用者 ${userId} 的 tasks 寫回失敗：`,
          error,
        );

        failedCount += 1;
      }
    }
  }

  console.log(
    "=== process-reminders 完成 ===",
  );

  console.log({
    sentCount,
    skippedCount,
    failedCount,
  });

  return {
    sentCount,
    skippedCount,
    failedCount,
    results,
  };
}


/* ================================================================
   13｜Vercel Serverless Function
   ================================================================ */

export default async function handler(
  req,
  res,
) {
  const config =
    getConfig();

  /*
   * GET 只做健康檢查。
   *
   * 所以你之後直接開：
   *
   * /api/process-reminders
   *
   * 不會突然寄信。
   */
  if (req.method === "GET") {
    const missing =
      validateConfig(config);

    res.status(200).json({
      ok: true,

      service:
        "Nut Nut Reminder Worker",

      message:
        "process-reminders API 已上線。GET 不會寄信。",

      environmentReady:
        missing.length === 0,

      missingEnvironmentVariables:
        missing,
    });

    return;
  }

  /*
   * 正式執行只能 POST。
   */
  if (req.method !== "POST") {
    res.status(405).json({
      error:
        "只接受 GET / POST",
    });

    return;
  }

  const missing =
    validateConfig(config);

  if (
    missing.length > 0
  ) {
    res.status(500).json({
      error:
        "Vercel Environment Variables 尚未設定完整",

      missing,
    });

    return;
  }

  /*
   * 防止任何人知道網址後，
   * 就一直要求系統寄 Email。
   */
  if (
    !isAuthorized(
      req,
      config,
    )
  ) {
    res.status(401).json({
      error:
        "Unauthorized",
    });

    return;
  }

  try {
    const result =
      await processReminders(
        req,
        config,
      );

    res.status(200).json({
      ok: true,

      ...result,

      processedAt:
        new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      "process-reminders 發生錯誤：",
      error,
    );

    res.status(500).json({
      ok: false,

      error:
        error?.message ||
        "背景提醒處理失敗",
    });
  }
}
