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

function otpEmailHtml(otp: string): string {
  const code = escapeHtml(otp);
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; background-color: #0B0F19; padding: 40px; border-radius: 20px; border: 1px solid #1F2937; color: #FFFFFF;">
      <h2 style="color: #FFFFFF; font-size: 24px; font-weight: 700; margin-bottom: 16px; text-align: center;">
        Welcome to <span style="color: #818CF8;">Expenso</span>
      </h2>
      <p style="color: #9CA3AF; font-size: 15px; line-height: 1.5; margin-bottom: 28px; text-align: center;">
        Your code is below. Enter it in the app to sign in, or to finish creating your account.
      </p>
      <div style="background-color: #111827; border: 1px solid #374151; border-radius: 14px; padding: 20px; text-align: center; margin-bottom: 28px;">
        <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #818CF8;">${code}</span>
      </div>
      <p style="color: #9CA3AF; font-size: 13px; text-align: center;">
        Never share this code. Expenso will never ask you for it.<br />
        This code expires in 10 minutes. If you didn't request it, you can ignore this email.
      </p>
    </div>
  `;
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
function requestFor(provider: Provider, apiKey: string, fromEmail: string, to: string, html: string) {
  const json = { "content-type": "application/json", accept: "application/json" };
  return provider === "resend"
    ? {
        url: RESEND_SEND_URL,
        headers: { ...json, authorization: `Bearer ${apiKey}` },
        body: { from: `${env.mailFromName} <${fromEmail}>`, to: [to], subject: SUBJECT, html },
      }
    : {
        url: BREVO_SEND_URL,
        headers: { ...json, "api-key": apiKey },
        body: { sender: { name: env.mailFromName, email: fromEmail }, to: [{ email: to }], subject: SUBJECT, htmlContent: html },
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

  const request = requestFor(provider, apiKey, fromEmail, email, otpEmailHtml(otp));
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
