/**
 * Cloudflare Pages Function: POST /api/subscribe
 *
 * Emails new subscriber addresses via Resend. Requires RESEND_API_KEY and
 * SUBSCRIBE_TO in the Pages environment; without them the endpoint accepts the
 * submission and does nothing, so a missing key never shows a visitor an error.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost({ request, env }) {
  try {
    const form = await request.formData();

    // Honeypot: hidden to people, irresistible to bots. Accept and discard.
    if (form.get('website')) {
      return json({ success: true }, 200);
    }

    const email = String(form.get('email') ?? '').trim();
    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      return json({ error: 'Please enter a valid email address.' }, 400);
    }

    if (env.RESEND_API_KEY && env.SUBSCRIBE_TO) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.SUBSCRIBE_FROM ?? 'MyOgre <onboarding@resend.dev>',
          to: env.SUBSCRIBE_TO,
          reply_to: email,
          subject: 'New MyOgre subscriber',
          text: `${email} subscribed to MyOgre updates.`,
        }),
      });

      if (!response.ok) {
        console.error('Resend rejected the request', response.status, await response.text());
        return json({ error: 'Could not record that right now. Please try again.' }, 502);
      }
    }

    return json({ success: true }, 200);
  } catch (error) {
    // Logged for us, never returned — error text can expose internals.
    console.error('subscribe failed', error);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
