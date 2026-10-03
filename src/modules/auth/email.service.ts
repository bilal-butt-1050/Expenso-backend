import { env } from "../../config/env";
import { AppError } from "../../utils/asyncHandler";

const RESEND_SEND_URL = "https://api.resend.com/emails";
const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const SUBJECT = "Your Expenso sign-in code";
const SEND_TIMEOUT_MS = 10_000;

/**
 * Whether a code may be printed instead of emailed. An allow-list on the *raw* NODE_ENV (threat S7):
 * `env.nodeEnv` defaults to "development" when unset, so a production box with a missing or mistyped
 * NODE_ENV would otherwise start logging live codes.
 */
function mayLogCode(): boolean {
  const raw = process.env.NODE_ENV;
  return raw === "development" || raw === "test";
}

/** Everything interpolated into the email HTML is escaped, even though a code is digits today. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * A plain white layout, built from tables so every mail client renders it the same, with the code
 * large and nothing else competing with it. The dark design scored worse with spam filters.
 */
function otpEmailHtml(otp: string): string {
  const code = escapeHtml(otp);
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  return `<!doctype html>
<html lang="en">
  <body style="margin: 0; padding: 0; background-color: #F4F5F7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #F4F5F7; padding: 32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; background-color: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 12px; font-family: ${font}; color: #111827;">
            <tr>
              <td style="padding: 32px 32px 8px; font-size: 20px; font-weight: 700;">Expenso</td>
            </tr>
            <tr>
              <td style="padding: 8px 32px 24px; font-size: 15px; line-height: 1.5; color: #374151;">
                Here's your sign-in code. Enter it in the app to sign in, or to finish creating your account.
              </td>
            </tr>
            <tr>
              <td style="padding: 0 32px;">
                <div style="font-size: 32px; font-weight: 700; letter-spacing: 8px; text-align: center; padding: 16px 0; background-color: #F4F5F7; border-radius: 8px; color: #111827;">${code}</div>
              </td>
            </tr>
            <tr>
              <td style="padding: 24px 32px 32px; font-size: 13px; line-height: 1.5; color: #6B7280;">
                This code expires in 10 minutes. If you didn't request it, you can ignore this email.
                Never share this code with anyone: Expenso will never ask you for it.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** The same message as plain text. Mail with only an HTML part is scored as more likely spam. */
function otpEmailText(otp: string): string {
  return [
    `Your Expenso sign-in code is ${otp}`,
    "",
    "Enter it in the app to sign in, or to finish creating your account. It expires in 10 minutes.",
    "",
    "If you didn't request it, you can ignore this email. Never share this code with anyone: Expenso will never ask you for it.",
  ].join("\n");
}

type Provider = "resend" | "brevo";

/**
 * The provider's answer, mapped to what the client may see (ARCH N1, EML-002). The client gets a
 * plain message only. The server logs one line with the provider, its status and error code, never
 * the key, the recipient or the code.
 */
function mapSendFailure(provider: Provider, status: number | null, code: string, message: string): AppError {
  // Neither provider is known to echo the recipient, but never risk logging an address.
  const safe = message.replace(/\S+@\S+/g, "<email>").slice(0, 200);
  console.error(`[email] ${provider} ${status ?? "network"} ${code}: ${safe}`);

  // A bad key, an IP the provider hasn't authorised, or an unverified sender domain.
  if (status === 401 || status === 403) {
    return new AppError(503, "Email is temporarily unavailable. Please try again later.");
  }
  // Out of credits or daily quota, or the provider is rate-limiting us.
  if (status === 402 || status === 429) {
    return new AppError(503, "We can't send codes right now. Please try again later.");
  }
  // Our request was invalid, the provider failed, the network failed, or it timed out.
  return new AppError(502, "Could not send the verification email. Please try again.");
}

/** The HTTP request each provider expects for one email. */
function requestFor(provider: Provider, apiKey: string, fromEmail: string, to: string, html: string, text: string) {
  const json = { "content-type": "application/json", accept: "application/json" };
  return provider === "resend"
    ? {
        url: RESEND_SEND_URL,
        headers: { ...json, authorization: `Bearer ${apiKey}` },
        body: { from: `${env.mailFromName} <${fromEmail}>`, to: [to], subject: SUBJECT, html, text },
      }
    : {
        url: BREVO_SEND_URL,
        headers: { ...json, "api-key": apiKey },
        body: {
          sender: { name: env.mailFromName, email: fromEmail },
          to: [{ email: to }],
          subject: SUBJECT,
          htmlContent: html,
          textContent: text,
        },
      };
}

export async function sendOtpEmail(email: string, otp: string): Promise<void> {
  // Read at call time, not at import, so configuration changes and tests take effect. Resend wins
  // when both are set; Brevo stays as the fallback until the Resend key is in place.
  const provider: Provider | null = env.resendApiKey ? "resend" : env.brevoApiKey ? "brevo" : null;
  const apiKey = provider === "resend" ? env.resendApiKey : env.brevoApiKey;
  const fromEmail = env.mailFromEmail;

  if (!provider || !apiKey || !fromEmail) {
    if (mayLogCode()) {
      console.warn(`[email] No email provider configured (${process.env.NODE_ENV}). OTP for ${email}: ${otp}`);
      return;
    }
    console.error("[email] No email provider (RESEND_API_KEY or BREVO_API_KEY) or MAIL_FROM_EMAIL; OTP email is unavailable");
    throw new AppError(503, "Email verification is unavailable right now. Please try again later.");
  }

  const request = requestFor(provider, apiKey, fromEmail, email, otpEmailHtml(otp), otpEmailText(otp));
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    throw mapSendFailure(provider, null, reason, "request failed");
  }

  if (response.ok) return;

  let code = "";
  let message = "";
  try {
    // Brevo answers {code, message}; Resend answers {statusCode, name, message}.
    const body = (await response.json()) as { code?: string; name?: string; message?: string };
    code = body.code ?? body.name ?? "";
    message = body.message ?? "";
  } catch {
    // Not JSON; the status alone decides the mapping.
  }
  throw mapSendFailure(provider, response.status, code, message);
}
