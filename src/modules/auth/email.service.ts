import { env } from "../../config/env";
import { AppError } from "../../utils/asyncHandler";

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
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

/**
 * Brevo's answer, mapped to what the client may see (ARCH N1, EML-002). The client gets a plain
 * message only. The server logs one line with Brevo's status and code, never the key, the
 * recipient or the code.
 */
function mapBrevoFailure(status: number | null, code: string, message: string): AppError {
  // Brevo's message isn't known to echo the recipient, but never risk logging an address.
  const safe = message.replace(/\S+@\S+/g, "<email>").slice(0, 200);
  console.error(`[email] brevo ${status ?? "network"} ${code}: ${safe}`);

  // Bad key, an IP Brevo hasn't authorised, or the account isn't allowed to send yet.
  if (status === 401 || status === 403) {
    return new AppError(503, "Email is temporarily unavailable. Please try again later.");
  }
  // Out of credits, or Brevo is rate-limiting us.
  if (status === 402 || status === 429) {
    return new AppError(503, "We can't send codes right now. Please try again later.");
  }
  // Our request was invalid, Brevo failed, the network failed, or it timed out.
  return new AppError(502, "Could not send the verification email. Please try again.");
}

export async function sendOtpEmail(email: string, otp: string): Promise<void> {
  // Read at call time, not at import, so configuration changes and tests take effect.
  const apiKey = env.brevoApiKey;
  const fromEmail = env.mailFromEmail;

  if (!apiKey || !fromEmail) {
    if (mayLogCode()) {
      console.warn(`[email] Brevo not configured (${process.env.NODE_ENV}). OTP for ${email}: ${otp}`);
      return;
    }
    console.error("[email] BREVO_API_KEY or MAIL_FROM_EMAIL is not set; OTP email is unavailable");
    throw new AppError(503, "Email verification is unavailable right now. Please try again later.");
  }

  let response: Response;
  try {
    response = await fetch(BREVO_SEND_URL, {
      method: "POST",
      headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: env.mailFromName, email: fromEmail },
        to: [{ email }],
        subject: "Your Expenso sign-in code",
        htmlContent: otpEmailHtml(otp),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    throw mapBrevoFailure(null, reason, "request failed");
  }

  if (response.ok) return;

  let code = "";
  let message = "";
  try {
    const body = (await response.json()) as { code?: string; message?: string };
    code = body.code ?? "";
    message = body.message ?? "";
  } catch {
    // Not JSON; the status alone decides the mapping.
  }
  throw mapBrevoFailure(response.status, code, message);
}
