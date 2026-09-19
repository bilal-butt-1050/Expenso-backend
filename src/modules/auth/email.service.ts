import { Resend } from "resend";
import { env } from "../../config/env";

const resend = new Resend(env.resendApiKey || "dummy-key");

export async function sendOtpEmail(email: string, otp: string) {
  if (!env.resendApiKey) {
    console.warn(`[AUTH] No RESEND_API_KEY set. OTP for ${email}: ${otp}`);
    return;
  }

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; background-color: #0B0F19; padding: 40px; border-radius: 20px; border: 1px solid #1F2937; color: #FFFFFF;">
      <h2 style="color: #FFFFFF; font-size: 24px; font-weight: 700; margin-bottom: 16px; text-align: center;">
        Welcome to <span style="color: #6366F1;">Expenso</span>
      </h2>
      <p style="color: #9CA3AF; font-size: 15px; line-height: 1.5; margin-bottom: 28px; text-align: center;">
        Your verification code is below. Enter it in the app to proceed.
      </p>
      <div style="background-color: #111827; border: 1px solid #374151; border-radius: 14px; padding: 20px; text-align: center; margin-bottom: 28px;">
        <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #6366F1;">
          ${otp}
        </span>
      </div>
      <p style="color: #6B7280; font-size: 13px; text-align: center;">
        This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.
      </p>
    </div>
  `;

  try {
    await resend.emails.send({
      from: "Expenso <auth@resend.dev>",
      to: email,
      subject: "Your Expenso Verification Code",
      html,
    });
  } catch (error) {
    console.error("Failed to send OTP email via Resend", error);
    throw new Error("Failed to send verification email");
  }
}

