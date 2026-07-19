// POST /api/contact
// Validates the submitted lead and sends it on to the studio's inbox.
// Swap the transporter for whatever Sammy/Africaptions actually use
// (Gmail SMTP, SendGrid, Resend, etc.) — nodemailer supports all of them.

const express = require('express');
const nodemailer = require('nodemailer');

const router = express.Router();

router.post('/', async (req, res) => {
  const { name, email, message } = req.body || {};

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  try {
    // If SMTP env vars are not set (e.g. local dev), just log the lead
    // instead of failing — keeps the demo usable without credentials.
    if (!process.env.SMTP_HOST) {
      console.log('New contact form lead (no SMTP configured):', {
        name,
        email,
        message,
      });
      return res.json({ ok: true, delivered: false });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: `"Africaptions Website" <${process.env.SMTP_USER}>`,
      to: process.env.CONTACT_TO || process.env.SMTP_USER,
      replyTo: email,
      subject: `New project enquiry from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
    });

    res.json({ ok: true, delivered: true });
  } catch (err) {
    console.error('Contact form error:', err);
    res.status(500).json({ error: 'Could not send message right now.' });
  }
});

module.exports = router;
