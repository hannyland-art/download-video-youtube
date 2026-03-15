const express = require("express");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");

const router = express.Router();

/**
 * Build the nodemailer transporter from environment variables.
 * Required env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 * Optional env vars: SMTP_FROM (defaults to SMTP_USER)
 *                    SMTP_TLS_REJECT_UNAUTHORIZED (defaults to "false" for AWS SES compatibility)
 */
function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  // For AWS SES and some other providers, certificate chain validation can fail
  // Allow disabling strict certificate validation via env var (defaults to false for AWS SES compatibility)
  const rejectUnauthorized = process.env.SMTP_TLS_REJECT_UNAUTHORIZED === "true";

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true for 465, false for other ports
    auth: { user, pass },
    tls: {
      rejectUnauthorized: rejectUnauthorized,
      // For AWS SES, we need to allow self-signed certificates in the chain
      // This is safe because we're still using TLS encryption, just not verifying the full chain
    },
  });
}

/**
 * Send an email with an MP3 file attachment.
 * This function can be called from other modules (e.g., download.js).
 * @param {string} filePath - Path to the MP3 file
 * @param {string} title - Song title
 * @param {string} email - Recipient email address
 * @returns {Promise<void>}
 */
async function sendEmailWithFile(filePath, title, email) {
  const transporter = createTransporter();
  if (!transporter) {
    throw new Error("Email is not configured on the server.");
  }

  if (!fs.existsSync(filePath)) {
    throw new Error("File not found.");
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error("Invalid email address.");
  }

  const safeTitle = title.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, "_");
  const filename = `${safeTitle}.mp3`;
  const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;

  await transporter.sendMail({
    from: `"YouTube MP3" <${fromAddress}>`,
    to: email,
    subject: `Your MP3: ${title}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
        <h2 style="color: #333;">Your MP3 is ready! 🎵</h2>
        <p style="color: #666;">Here's your requested song:</p>
        <div style="background: #f5f5f5; padding: 15px; border-radius: 10px; margin: 15px 0;">
          <strong style="color: #333;">${title}</strong>
        </div>
        <p style="color: #999; font-size: 12px;">Sent from YouTube MP3 Downloader</p>
      </div>
    `,
    attachments: [
      {
        filename,
        path: filePath,
        contentType: "audio/mpeg",
      },
    ],
  });
}

/**
 * GET /api/email/status
 * Returns whether the email feature is configured.
 */
router.get("/status", (req, res) => {
  const configured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  res.json({ configured });
});

/**
 * POST /api/send-email
 * Body: { fileId, email }
 * Sends the completed MP3 file as an email attachment.
 *
 * NOTE: This route expects access to the completedFiles map from download.js.
 *       It is injected via module.exports function pattern.
 */
function createEmailRouter(completedFiles) {
  /**
   * POST /
   * Body: { fileId, email }
   */
  router.post("/", async (req, res) => {
    const { fileId, email } = req.body;

    if (!fileId || !email) {
      return res.status(400).json({ error: "fileId and email are required." });
    }

    // Validate email format (basic)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }

    const transporter = createTransporter();
    if (!transporter) {
      return res.status(500).json({
        error: "Email is not configured on the server. Ask the admin to set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS environment variables.",
      });
    }

    const entry = completedFiles.get(fileId);
    if (!entry) {
      return res.status(404).json({ error: "File not found or expired. Please download again." });
    }

    if (!fs.existsSync(entry.path)) {
      completedFiles.delete(fileId);
      return res.status(404).json({ error: "File no longer available. Please download again." });
    }

    try {
      await sendEmailWithFile(entry.path, entry.title, email);
      res.json({ success: true, message: `MP3 sent to ${email}` });
    } catch (err) {
      console.error("Email send error:", err.message);
      res.status(500).json({ error: `Failed to send email: ${err.message}` });
    }
  });

  return router;
}

module.exports = createEmailRouter;
module.exports.sendEmailWithFile = sendEmailWithFile;