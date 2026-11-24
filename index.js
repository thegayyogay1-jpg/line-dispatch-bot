const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const admin = require("firebase-admin");

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const PORT = process.env.PORT || 3000;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const FIREBASE_DB_URL =
  process.env.FIREBASE_DB_URL ||
  "https://surveyor-dispatch-v1-default-rtdb.asia-southeast1.firebasedatabase.app";
const AUTO_CANCEL_MS = 30000;

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
  databaseURL: FIREBASE_DB_URL,
});

const db = admin.database();
const notifiedClaimedJobs = new Set();

function verifyLineSignature(req) {
  if (!LINE_CHANNEL_SECRET || !req.rawBody) return false;
  const hash = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest("base64");
  return req.headers["x-line-signature"] === hash;
}

async function replyLine(replyToken, messages) {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

async function pushLine(to, messages) {
  if (!to) return;
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to, messages },
    {
      headers: {
        Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

function getTargetIdFromSource(source) {
  return source.groupId || source.roomId || source.userId || null;
}

async function getAvailableWorkers() {
  const snap = await db.ref("surveyors").once("value");
  const data = snap.val() || {};
  return Object.entries(data)
    .map(([id, w]) => ({ id, ...w }))
    .filter((w) => !!w.isOnline && !!w.isAvailable)
    .sort((a, b) => (a.lastJobAt || 0) - (b.lastJobAt || 0));
}

function buildDispatchConfirmFlex(detailText, targetGroupId) {
  const payload = JSON.stringify({
    action: "create_job",
    detail: detailText.slice(0, 120),
    groupId: targetGroupId,
  });

  return {
    type: "flex",
    altText: `ยืนยันจ่ายงาน: ${detailText}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "พบข้อมูลแจ้งเหตุ / จุดเกิดเหตุ", weight: "bold", size: "md", color: "#0f172a" },
          { type: "text", text: detailText, size: "sm", color: "#334155", wrap: true, margin: "md" },
          { type: "text", text: "กดปุ่มด้านล่างเพื่อยิงงานเข้าแอพพนักงาน (รอรับ 30 วิ)", size: "xs", color: "#64748b", wrap: true, margin: "sm" },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#16a34a",
            action: {
              type: "postback",
              label: "จ่ายงานเข้าแอพทันที",
              data: payload,
            },
          },
        ],
      },
    },
  };
}

app.get("/", (_req, res) => {
  res.send("LINE Surveyor Dispatch Webhook is running.");
});

app.post("/webhook", async (req, res) => {
  if (!verifyLineSignature(req)) {
    return res.status(401).send("Invalid signature");
  }

  const events = req.body.events || [];
  res.status(200).send("OK");

  for (const ev of events) {
    const targetId = getTargetIdFromSource(ev.source || {});

    if (ev.type === "message" && ev.message?.type === "text") {
      const text = (ev.message.text || "").trim();

      if (/พนักงาน|คนว่าง|มีใครว่าง|ว่างมั้ย|ว่างไหม/i.test(text) && text.length <= 25) {
        const avail = await getAvailableWorkers();
        if (!avail.length) {
          await replyLine(ev.replyToken, [
            { type: "text", text: "ตอนนี้ไม่มีพนักงานที่ออนไลน์และว่างพร้อมรับงานครับ" },
          ]);
        } else {
          const lines = avail.map((w, idx) => `${idx + 1}. ${w.name} (${w.phone || "ไม่ระบุเบอร์"})`);
          await replyLine(ev.replyToken, [
            {
              type: "text",
              text: `มีพนักงานว่างพร้อมรับงาน ${avail.length} คน:\n${lines.join("\n")}`,
            },
          ]);
        }
        continue;
      }

      if (text.length >= 2) {
        await replyLine(ev.replyToken, [buildDispatchConfirmFlex(text, targetId)]);
      }
    }

    if (ev.type === "postback") {
      try {
        const parsed = JSON.parse(ev.postback.data || "{}");
        if (parsed.action === "create_job") {
          const now = Date.now();
          const newJobRef = db.ref("dispatchJobs").push();
          await newJobRef.set({
            plateNumber: parsed.detail || "แจ้งเหตุผ่าน LINE",
            locationNote: parsed.detail || "",
            sourceChannel: "line_bot",
            lineGroupId: parsed.groupId || targetId,
            status: "open",
            createdAt: now,
            expiresAt: now + AUTO_CANCEL_MS,
            assignedTo: null,
            assignedToName: null,
            claimImage: null,
            claimLocked: false,
          });

          await replyLine(ev.replyToken, [
            {
              type: "text",
              text: `ส่งงาน "${parsed.detail}" เข้าแอพพนักงานแล้วครับ (รอรับภายใน 30 วินาที)`,
            },
          ]);
        }
      } catch (err) {
        console.error("Postback error:", err);
      }
    }
  }
});

db.ref("dispatchJobs").on("child_changed", async (snap) => {
  const jobId = snap.key;
  const job = snap.val();
  if (!job) return;

  if (job.status === "in_progress" && job.assignedTo && !notifiedClaimedJobs.has(jobId)) {
    notifiedClaimedJobs.add(jobId);

    let phone = job.assignedToPhone || "";
    if (!phone) {
      const wSnap = await db.ref(`surveyors/${job.assignedTo}`).once("value");
      phone = (wSnap.val() && wSnap.val().phone) || "ไม่ระบุเบอร์โทร";
    }

    const groupTarget = job.lineGroupId;
    if (groupTarget) {
      const msg = `${job.assignedToName || "พนักงาน"} เบอร์ ${phone} เป็นผู้รับงาน (${job.plateNumber || ""})`;
      await pushLine(groupTarget, [{ type: "text", text: msg }]).catch((err) => {
        console.error("Push LINE error:", err.message);
      });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
